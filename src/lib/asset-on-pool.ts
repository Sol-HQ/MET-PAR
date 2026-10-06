import { Connection, PublicKey } from "@solana/web3.js";
import { rpcUrl, type ClusterName } from "./constants";
import { curveSale } from "./load-pool";
import { readCopy } from "./record-copy";
import { RECORD_VAULT, readRecord } from "./record";
import {
  ESCROW_PROGRAM,
  readListing,
  readTitle,
  titleStatus,
  type Listing,
} from "./title";

export type AssetStanding = "sold" | "for-sale" | "waiting" | "held";

export type PoolAsset = {
  pool: string;
  record: string;
  title: string;
  creator: string;
  /** attached when a coin was created first. none when the mint is only the payment token. */
  coin: "attached" | "none";
  name: string;
  /** The object's own description, such as "One original painting". Empty when the sheet has none. */
  kind: string;
  symbol: string;
  image: string;
  standing: AssetStanding;
  status: string;
  titleTerms: { key: string; value: string }[];
  recordTerms: { key: string; value: string }[];
  story: string[];
  titleHref: string;
};

type Indexed = {
  record: string;
  name: string;
  uri: string;
  attributes: Record<string, string>;
};

type Sheet = {
  name?: string;
  description?: string;
  image?: string;
  claim?: string;
  handoff?: string;
  promises?: string[];
  record?: {
    pitch?: string;
    object?: { story?: string; name?: string; kind?: string };
    claim?: { text?: string };
    redemption?: { handoff?: string; declaredValue?: string; declaredUnit?: string };
    title?: { promises?: string[] };
  };
};

let indexCache: { cluster: ClusterName; at: number; rows: Indexed[] } | null = null;

function rowsOf(value: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(value).map(([key, item]) => ({ key, value: item }));
}

function storyLines(sheet: Sheet): string[] {
  const lines = [
    sheet.description || "",
    sheet.claim ? `Claim: ${sheet.claim}` : "",
    sheet.handoff || "",
    ...(sheet.promises || []),
    sheet.record?.object?.story || "",
    sheet.record?.pitch || "",
    sheet.record?.claim?.text ? `Claim: ${sheet.record.claim.text}` : "",
    sheet.record?.redemption?.handoff || "",
    sheet.record?.redemption?.declaredValue
      ? `Declared value: ${sheet.record.redemption.declaredValue} ${sheet.record.redemption.declaredUnit || ""}`.trim()
      : "",
    ...(sheet.record?.title?.promises || []),
  ];
  return lines.map((line) => line.trim()).filter(Boolean);
}

function tokenAmount(amount: bigint): string {
  const scale = BigInt(1000000);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC");
}

async function readIds(endpoint: string, ids: string[]): Promise<Indexed[]> {
  const rows = await Promise.all(
    ids.map(async (id) => {
      const read = await readRecord(endpoint, id);
      if (!read.exists || !read.attributes.title || !read.attributes.pool) return null;
      return { record: id, name: read.name, uri: read.uri, attributes: read.attributes };
    }),
  );
  return rows.filter((row): row is Indexed => row !== null);
}

async function vaultRecords(cluster: ClusterName, extraRecords: string[] = []): Promise<Indexed[]> {
  const endpoint = rpcUrl(cluster);
  if (indexCache && indexCache.cluster === cluster && Date.now() - indexCache.at < 20_000) {
    const have = new Set(indexCache.rows.map((row) => row.record));
    const missing = extraRecords.filter((id) => id && !have.has(id));
    if (missing.length === 0) return indexCache.rows;
    const added = await readIds(endpoint, missing);
    indexCache = { cluster, at: indexCache.at, rows: [...added, ...indexCache.rows] };
    return indexCache.rows;
  }
  const vault = RECORD_VAULT[cluster];
  if (!vault) return [];
  const ids: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "vault",
        method: "getAssetsByOwner",
        params: { ownerAddress: vault, page, limit: 100 },
      }),
    });
    if (!response.ok) break;
    const body = (await response.json()) as { result?: { items?: { id?: string }[] } };
    const items = body.result?.items || [];
    for (const item of items) {
      if (item.id) ids.push(item.id);
    }
    if (items.length < 100) break;
  }
  for (const id of extraRecords) {
    if (id && !ids.includes(id)) ids.unshift(id);
  }
  const rows = await readIds(endpoint, ids);
  indexCache = { cluster, at: Date.now(), rows };
  return rows;
}

async function loadSheet(cluster: ClusterName, record: string, uri: string): Promise<Sheet> {
  let text = "";
  if (uri.startsWith("https://")) {
    try {
      const response = await fetch(uri, { cache: "no-store" });
      const type = response.headers.get("content-type") || "";
      if (response.ok && (type.includes("json") || type.startsWith("text/"))) text = await response.text();
    } catch {
      text = "";
    }
  }
  if (!text.trim().startsWith("{")) {
    text = (await readCopy(cluster, record).catch(() => null)) || "";
  }
  if (!text.trim().startsWith("{")) return {};
  try {
    return JSON.parse(text) as Sheet;
  } catch {
    return {};
  }
}

export const CLAIMED_STATUS = "Claimed. Still awaiting handoff.";

function kindSentence(kind: string): string {
  const text = kind.trim().replace(/\.+$/, "");
  if (!text) return "";
  const phrase = text.charAt(0).toLowerCase() + text.slice(1);
  return `It is ${phrase}.`;
}

/** The title's state, as a full sentence, for the pool cards. */
function afterGraduation(rest: string): string {
  if (rest === "The title is listed on Tensor. The sale has not opened.") return "It is listed on Tensor, and the sale has not opened.";
  if (rest === "The title is not in the escrow.") return "It has left the escrow.";
  if (rest === "The title is not in the creator wallet.") return "It has left the creator wallet.";
  return rest;
}

export function titleSentence(status: string): string {
  const text = status.trim();
  if (text.startsWith("Waiting for graduation. ")) {
    return `The title is waiting for graduation. ${afterGraduation(text.slice("Waiting for graduation. ".length))}`;
  }
  if (text === "Waiting for graduation.") return "The title is waiting for graduation.";
  if (text.startsWith("Waiting. ")) return `The title is waiting. ${text.slice("Waiting. ".length)}`;
  if (text.startsWith("Claimed. ")) return "The title is claimed. The handoff is still ahead.";
  if (text.startsWith("For sale ")) {
    return `The title is ${text.charAt(0).toLowerCase()}${text.slice(1)}`.replace(/\bthis coin\b/g, "this token");
  }
  if (text === "In auction.") return "The title is in auction.";
  return text.replace(/\bthis coin\b/g, "this token").replace(/\bThe coin\b/g, "The token");
}

/** On a token card. The token comes first, then the real-world asset it is paired with. */
export function tokenPairing(name: string, kind: string): string {
  const object = name.trim() || "this object";
  const detail = kindSentence(kind);
  return [`This token is paired with ${object}, a real-world asset.`, detail].filter(Boolean).join(" ");
}

/** On a real-world asset card. The object comes first, then the token it is paired with. */
export function objectPairing(kind: string, symbol: string, coin: "attached" | "none", here = false): string {
  const detail = kindSentence(kind);
  const pair =
    coin === "attached" && symbol
      ? here
        ? `It is paired with this token, ${symbol}.`
        : `It is paired with the token ${symbol}.`
      : coin === "attached"
        ? here
          ? "It is paired with this token."
          : "It is paired with a token."
        : symbol
          ? `The buyer pays for it in the token ${symbol}.`
          : "The payment token is named when the title is listed.";
  return ["This is a real-world asset.", detail, pair].filter(Boolean).join(" ");
}

/** A purchase can only be true after the sale was allowed to open and the title actually left. */
export function titleWasPurchased(input: {
  coin: "attached" | "none";
  graduated: boolean | null;
  saleOpen: boolean;
  leftSeller: boolean;
}): boolean {
  if (!input.leftSeller) return false;
  if (input.coin === "none") return true;
  return input.graduated === true && input.saleOpen;
}

function standingOf(
  rail: "escrow" | "creator",
  owner: string,
  creator: string,
  listingAddress: string | null,
  listing: Listing | null,
  tensorAmount: bigint | null,
  coin: "attached" | "none",
  graduated: boolean | null,
  saleOpen: boolean,
): { standing: AssetStanding; status: string } {
  const pay = coin === "none" ? "the payment token" : "this token";
  const leftEscrow = Boolean(rail === "escrow" && listingAddress && owner && owner !== listingAddress);
  const leftCreator = Boolean(rail === "creator" && owner && creator && owner !== creator && tensorAmount === null);
  const purchased = titleWasPurchased({ coin, graduated, saleOpen, leftSeller: leftEscrow || leftCreator });
  if (purchased) return { standing: "sold", status: CLAIMED_STATUS };
  if (coin === "attached" && graduated === null) {
    return { standing: "waiting", status: "The coin could not be read. This title is not marked claimed." };
  }
  if (coin === "attached" && graduated === false) {
    if (rail === "escrow" && listingAddress && owner === listingAddress) {
      return { standing: "waiting", status: "Waiting for graduation. The escrow holds the title." };
    }
    if (rail === "creator" && tensorAmount !== null) {
      return { standing: "waiting", status: "Waiting for graduation. The title is listed on Tensor. The sale has not opened." };
    }
    if (rail === "creator" && (!creator || owner === creator)) {
      return { standing: "waiting", status: "Waiting for graduation. The creator holds the title." };
    }
    if (leftEscrow) return { standing: "waiting", status: "Waiting for graduation. The title is not in the escrow." };
    return { standing: "waiting", status: "Waiting for graduation. The title is not in the creator wallet." };
  }
  if (coin === "attached" && graduated === true && !saleOpen) {
    const holder =
      rail === "escrow" && listingAddress && owner === listingAddress
        ? "The escrow holds the title."
        : creator && owner === creator
          ? "The creator holds the title."
          : "The title is not in the creator wallet.";
    return { standing: "waiting", status: `The coin has graduated. The sale has not opened. ${holder}` };
  }
  if (rail === "creator" && tensorAmount !== null) {
    return { standing: "for-sale", status: `For sale on Tensor for ${tokenAmount(tensorAmount)} of ${pay}.` };
  }
  if (rail === "creator") {
    return { standing: "held", status: "The creator holds the title. It is not listed." };
  }
  if (coin === "attached" && (!listing || listing.graduatedAt <= 0)) {
    return { standing: "waiting", status: "Waiting for graduation." };
  }
  if (!listing) {
    return { standing: "held", status: "The creator holds the title. It is not listed." };
  }
  const opensAt = listing.graduatedAt + listing.delaySeconds;
  if (listing.graduatedAt > 0 && Math.floor(Date.now() / 1000) < opensAt) {
    return { standing: "waiting", status: `Waiting. The sale opens ${when(opensAt)}.` };
  }
  if (listing.sale === "auction") {
    return { standing: "for-sale", status: "In auction." };
  }
  return { standing: "for-sale", status: `For sale for ${tokenAmount(listing.price)} of ${pay}.` };
}

async function describe(cluster: ClusterName, row: Indexed): Promise<PoolAsset | null> {
  const endpoint = rpcUrl(cluster);
  const connection = new Connection(endpoint, "confirmed");
  const [title, status, sheet] = await Promise.all([
    readTitle(endpoint, row.attributes.title),
    titleStatus(endpoint, cluster, { address: row.record, attributes: row.attributes }),
    loadSheet(cluster, row.record, row.uri),
  ]);
  const network = cluster === "devnet" ? "?c=devnet" : "";
  const named = {
    pool: row.attributes.pool,
    record: row.record,
    title: status?.address || row.attributes.title,
    creator: status?.creator || row.attributes.creator || "",
    coin: (row.attributes.coin === "none" ? "none" : "attached") as "attached" | "none",
    name: sheet.name || sheet.record?.object?.name || row.name || title.name || "Record",
    kind: (sheet.record?.object?.kind || "").trim(),
    symbol: row.attributes.symbol || "",
    image: typeof sheet.image === "string" ? sheet.image : "",
    titleTerms: rowsOf(title.attributes),
    recordTerms: rowsOf(row.attributes),
    story: storyLines(sheet),
    titleHref: `/t/${status?.address || row.attributes.title}${network}`,
  };
  if (!title.exists) {
    return { ...named, standing: "waiting", status: "The title is not on chain yet." };
  }
  if (!status?.rail) {
    return { ...named, standing: "waiting", status: "The record and the title do not name the same holder." };
  }
  const program = ESCROW_PROGRAM[cluster];
  const listing =
    status.rail === "escrow" && program
      ? await readListing(connection, new PublicKey(program), new PublicKey(status.address)).catch(() => null)
      : null;
  const coin = named.coin;
  const creator = named.creator;
  const opens = title.attributes["sale opens"] || "";
  const delay = Number.parseInt(opens, 10);
  const sale = coin === "attached" && row.attributes.pool && row.attributes.pool !== "none" ? await curveSale(connection, row.attributes.pool) : null;
  const finishedAt = sale?.finishedAt ?? 0;
  const waitSeconds = Number.isFinite(delay) ? (opens.includes("second") ? delay : delay * 86_400) : 0;
  const saleOpen = Boolean(sale?.graduated) && finishedAt > 0 && waitSeconds > 0 && Math.floor(Date.now() / 1000) >= finishedAt + waitSeconds;
  const result = standingOf(
    status.rail,
    status.owner,
    creator,
    status.listing,
    listing,
    status.tensor ? status.tensor.amount : null,
    coin,
    sale ? sale.graduated : coin === "attached" ? null : true,
    coin === "none" ? true : saleOpen,
  );
  return { ...named, creator, coin, standing: result.standing, status: result.status };
}

/** Every titled object on this network, read from the vault that holds the records. */
export async function poolAssets(cluster: ClusterName, pool?: string, extraRecords: string[] = []): Promise<PoolAsset[]> {
  const rows = await vaultRecords(cluster, extraRecords);
  const matched = pool ? rows.filter((row) => row.attributes.pool === pool) : rows;
  const assets = await Promise.all(matched.map((row) => describe(cluster, row).catch(() => null)));
  return assets.filter((asset): asset is PoolAsset => asset !== null);
}
