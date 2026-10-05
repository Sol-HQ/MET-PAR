import { Connection, PublicKey } from "@solana/web3.js";
import { rpcUrl, type ClusterName } from "./constants";
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
  name: string;
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
    object?: { story?: string; name?: string };
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

async function vaultRecords(cluster: ClusterName): Promise<Indexed[]> {
  if (indexCache && indexCache.cluster === cluster && Date.now() - indexCache.at < 20_000) return indexCache.rows;
  const vault = RECORD_VAULT[cluster];
  if (!vault) return [];
  const endpoint = rpcUrl(cluster);
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
  const rows = (
    await Promise.all(
      ids.map(async (id) => {
        const read = await readRecord(endpoint, id);
        if (!read.exists || !read.attributes.title || !read.attributes.pool) return null;
        return { record: id, name: read.name, uri: read.uri, attributes: read.attributes };
      }),
    )
  ).filter((row): row is Indexed => row !== null);
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

function standingOf(
  rail: "escrow" | "creator",
  owner: string,
  creator: string,
  listingAddress: string | null,
  listing: Listing | null,
  tensorAmount: bigint | null,
): { standing: AssetStanding; status: string } {
  if (rail === "escrow" && listingAddress && owner && owner !== listingAddress) {
    return { standing: "sold", status: "Sold." };
  }
  if (rail === "creator" && tensorAmount !== null) {
    return { standing: "for-sale", status: `For sale on Tensor for ${tokenAmount(tensorAmount)} of this coin.` };
  }
  if (rail === "creator" && owner && creator && owner !== creator) {
    return { standing: "sold", status: "Sold." };
  }
  if (rail === "creator") {
    return { standing: "held", status: "The creator holds the title. It is not listed." };
  }
  if (!listing || listing.graduatedAt <= 0) {
    return { standing: "waiting", status: "Waiting for graduation." };
  }
  const opensAt = listing.graduatedAt + listing.delaySeconds;
  if (Math.floor(Date.now() / 1000) < opensAt) {
    return { standing: "waiting", status: `Waiting. The sale opens ${when(opensAt)}.` };
  }
  if (listing.sale === "auction") {
    return { standing: "for-sale", status: "In auction." };
  }
  return { standing: "for-sale", status: `For sale for ${tokenAmount(listing.price)} of this coin.` };
}

async function describe(cluster: ClusterName, row: Indexed): Promise<PoolAsset | null> {
  const endpoint = rpcUrl(cluster);
  const connection = new Connection(endpoint, "confirmed");
  const [title, status, sheet] = await Promise.all([
    readTitle(endpoint, row.attributes.title),
    titleStatus(endpoint, cluster, { address: row.record, attributes: row.attributes }),
    loadSheet(cluster, row.record, row.uri),
  ]);
  if (!status || !title.exists) return null;
  const program = ESCROW_PROGRAM[cluster];
  const listing =
    status.rail === "escrow" && program
      ? await readListing(connection, new PublicKey(program), new PublicKey(status.address)).catch(() => null)
      : null;
  const sale = standingOf(
    status.rail,
    status.owner,
    row.attributes.creator || "",
    status.listing,
    listing,
    status.tensor ? status.tensor.amount : null,
  );
  const network = cluster === "devnet" ? "?c=devnet" : "";
  return {
    pool: row.attributes.pool,
    record: row.record,
    title: status.address,
    name: sheet.name || sheet.record?.object?.name || row.name || title.name,
    symbol: row.attributes.symbol || "",
    image: typeof sheet.image === "string" ? sheet.image : "",
    standing: sale.standing,
    status: sale.status,
    titleTerms: rowsOf(title.attributes),
    recordTerms: rowsOf(row.attributes),
    story: storyLines(sheet),
    titleHref: `/t/${status.address}${network}`,
  };
}

/** Every titled object on this network, read from the vault that holds the records. */
export async function poolAssets(cluster: ClusterName, pool?: string): Promise<PoolAsset[]> {
  const rows = await vaultRecords(cluster);
  const matched = pool ? rows.filter((row) => row.attributes.pool === pool) : rows;
  const assets = await Promise.all(matched.map((row) => describe(cluster, row).catch(() => null)));
  return assets.filter((asset): asset is PoolAsset => asset !== null);
}
