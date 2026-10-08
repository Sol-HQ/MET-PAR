import { create, fetchAsset, mplCore } from "@metaplex-foundation/mpl-core";
import { createNoopSigner, createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ClusterName } from "./constants";

export const PUBLIC_ORIGIN = "https://www.meteora.surf";

/** A path this site serves. A link that still names a removed host is read on this site. */
export function sitePath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (host !== "www.meteora.surf" && host !== "meteora.surf" && !host.endsWith(".vercel.app")) return null;
  return `${url.pathname}${url.search}`;
}
export const CORE_PROGRAM_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const RECORD_KIND = "PAR asset record v1";
/** Arweave Turbo stores items up to 105 KiB without payment. */
export const FREE_UPLOAD_BYTES = 105 * 1024;

/**
 * The wallet that receives every record. The same address is used on the practice network and the real network.
 * The master is frozen with no freeze authority, so this wallet cannot move or burn it.
 * A later rotation changes where new records go. Records already sent stay at the address they were minted to.
 */
const RECORD_VAULT_ADDRESS = "pMUdWH9UsqorhF9Wi6Snaq6c5xMpA6yoyYd2q1tmfei";

export const RECORD_VAULT: Record<ClusterName, string> = {
  devnet: RECORD_VAULT_ADDRESS,
  "mainnet-beta": RECORD_VAULT_ADDRESS,
};

export function arweaveUrl(id: string): string {
  return `https://arweave.net/${id}`;
}

const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const SAVED_UPLOADS = "par-arweave-id";
/** Turbo confirms an upload before arweave.net serves it. The mint waits for arweave.net. */
const ARWEAVE_WAIT_MS = 12 * 60 * 1000;

async function hashMatches(url: string, sha256: string): Promise<boolean> {
  const response = await fetch(url);
  if (!response.ok) return false;
  return (await sha256Hex(new Uint8Array(await response.arrayBuffer()))) === sha256;
}

/** The upload id for these exact bytes, kept after a signature so a retry does not sign it again. */
export function savedArweaveId(sha256: string): string {
  if (typeof sessionStorage === "undefined" || !sha256) return "";
  try {
    const map = JSON.parse(sessionStorage.getItem(SAVED_UPLOADS) || "{}") as Record<string, string>;
    const id = map[sha256];
    return typeof id === "string" && ARWEAVE_ID.test(id) ? id : "";
  } catch {
    return "";
  }
}

export function keepArweaveId(sha256: string, id: string) {
  if (typeof sessionStorage === "undefined" || !sha256 || !ARWEAVE_ID.test(id)) return;
  try {
    const map = JSON.parse(sessionStorage.getItem(SAVED_UPLOADS) || "{}") as Record<string, string>;
    map[sha256] = id;
    sessionStorage.setItem(SAVED_UPLOADS, JSON.stringify(map));
  } catch {
    /* A retry signs the upload again. */
  }
}

/**
 * arweave.net must return these exact bytes. The address written on the mint is that arweave.net link.
 * Turbo can confirm the upload minutes before arweave.net serves it.
 */
export async function waitForArweave(id: string, sha256: string, onWait?: (elapsedSeconds: number) => void): Promise<string> {
  if (!ARWEAVE_ID.test(id) || !sha256) return "";
  const url = arweaveUrl(id);
  const started = Date.now();
  while (Date.now() - started < ARWEAVE_WAIT_MS) {
    onWait?.(Math.round((Date.now() - started) / 1000));
    try {
      if (await hashMatches(url, sha256)) return url;
    } catch {
      /* arweave.net trails the upload. */
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return "";
}

/** Taken off the site. The chain copies stay where they were minted. The paired token stays. */
export const REMOVED_RECORDS = new Set(["tQ3CWLiAHD88vseUKmFjRz9APUtEM9Q7d6Z4SZtMN1G"]);
export const REMOVED_TITLES = new Set(["Fbn8wewPmDiXGgeLcKGNdTa1cnRN2todeQDtesHqGvrk"]);

/** The address written on a mint has to return these exact bytes before that mint is signed. */
export async function bytesMatch(url: string, sha256: string): Promise<boolean> {
  if (!url || !sha256) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (await hashMatches(url, sha256)) return true;
    } catch {
      /* arweave.net can lag behind the upload. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** The frozen token link. It names the record before the record exists, so the token and the record point at each other. */
export function recordTokenUri(asset: string, mint: string, cluster: ClusterName): string {
  const network = cluster === "devnet" ? "c=devnet&" : "";
  return `${PUBLIC_ORIGIN}/r/${asset}?${network}m=${mint}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RecordAttribute = { key: string; value: string };

export type RecordFacts = {
  mint: string;
  pool: string;
  vault: string;
  creator: string;
  symbol: string;
  supply?: string;
  decimals?: string;
  quote: string;
  par: string;
  poolPrice: string;
  handoffDays: string;
  declared: string;
  sheetSha256: string;
  imageSha256: string;
  title: string;
  titleHeldBy: string;
  escrowProgram?: string;
  serial?: string;
  makerName?: string;
  /** Readable sheet page. Written on every record. */
  sheet?: string;
  salePage?: string;
  soldThrough?: string;
  /** attached when this record names a coin. none when the mint is only the price token. */
  coin?: "attached" | "none";
};

/** Short fields written on chain. The full sheet sits behind the record link and is pinned by its hash here. */
export function recordAttributes(facts: RecordFacts): RecordAttribute[] {
  return [
    { key: "record", value: RECORD_KIND },
    { key: "coin", value: facts.coin || "attached" },
    ...(facts.sheet ? [{ key: "full sheet", value: facts.sheet }] : []),
    { key: "symbol", value: facts.symbol },
    ...(facts.supply ? [{ key: "supply", value: facts.supply }] : []),
    ...(facts.decimals ? [{ key: "decimals", value: facts.decimals }] : []),
    { key: "mint", value: facts.mint },
    ...(facts.soldThrough ? [{ key: "sold through", value: facts.soldThrough }] : []),
    ...(facts.salePage ? [{ key: "sale page", value: facts.salePage }] : []),
    { key: "pool", value: facts.pool },
    { key: "vault", value: facts.vault },
    { key: "creator", value: facts.creator },
    { key: "quote", value: facts.quote },
    { key: "par", value: facts.par },
    { key: "pool price", value: facts.poolPrice },
    { key: "handoff days", value: facts.handoffDays },
    { key: "declared", value: facts.declared },
    { key: "sheet sha256", value: facts.sheetSha256 },
    { key: "image sha256", value: facts.imageSha256 },
    { key: "title", value: facts.title },
    { key: "title held by", value: facts.titleHeldBy },
    { key: "serial", value: facts.serial?.trim() || "none" },
    { key: "maker", value: facts.makerName?.trim() || "none" },
    { key: "escrow program", value: facts.escrowProgram || "none" },
  ];
}

/**
 * The createV2 instruction for the record. The vault owns it. Name, link, and attributes are locked:
 * ImmutableMetadata, Attributes, and AddBlocker all carry authority None, so no wallet can change them.
 * PermanentFreezeDelegate is frozen with authority None, so the record can never be burned or moved, even by the vault.
 */
export function recordInstruction(input: {
  endpoint: string;
  asset: Keypair;
  payer: PublicKey;
  vault: PublicKey;
  name: string;
  uri: string;
  attributes: RecordAttribute[];
}): TransactionInstruction[] {
  const umi = createUmi(input.endpoint).use(mplCore());
  const payer = createNoopSigner(umiKey(input.payer.toBase58()));
  umi.use(signerIdentity(payer));
  const asset = createSignerFromKeypair(umi, fromWeb3JsKeypair(input.asset));
  const builder = create(umi, {
    asset,
    name: input.name,
    uri: input.uri,
    owner: umiKey(input.vault.toBase58()),
    updateAuthority: umiKey(input.vault.toBase58()),
    payer,
    authority: payer,
    plugins: [
      { type: "Attributes", attributeList: input.attributes, authority: { type: "None" } },
      { type: "ImmutableMetadata", authority: { type: "None" } },
      { type: "AddBlocker", authority: { type: "None" } },
      { type: "PermanentFreezeDelegate", frozen: true, authority: { type: "None" } },
    ],
  });
  return builder.getInstructions().map((instruction) => toWeb3JsInstruction(instruction));
}

export type RecordRead = {
  exists: boolean;
  owner: string;
  name: string;
  uri: string;
  attributes: Record<string, string>;
  nameLocked: boolean;
  attributesLocked: boolean;
  addBlocked: boolean;
  frozenForever: boolean;
};

const MISSING: RecordRead = {
  exists: false,
  owner: "",
  name: "",
  uri: "",
  attributes: {},
  nameLocked: false,
  attributesLocked: false,
  addBlocked: false,
  frozenForever: false,
};

export async function readRecord(endpoint: string, asset: string): Promise<RecordRead> {
  const umi = createUmi(endpoint).use(mplCore());
  try {
    const found = await fetchAsset(umi, umiKey(asset), { commitment: "confirmed" });
    const attributes: Record<string, string> = {};
    for (const item of found.attributes?.attributeList ?? []) attributes[item.key] = item.value;
    return {
      exists: true,
      owner: found.owner.toString(),
      name: found.name,
      uri: found.uri,
      attributes,
      nameLocked: found.immutableMetadata?.authority.type === "None",
      attributesLocked: found.attributes?.authority.type === "None",
      addBlocked: found.addBlocker?.authority.type === "None",
      frozenForever: found.permanentFreezeDelegate?.frozen === true && found.permanentFreezeDelegate.authority.type === "None",
    };
  } catch {
    return MISSING;
  }
}

export type RecordCheck = { label: string; ok: boolean };

/** What a buyer can confirm without trusting PAR. */
export function recordChecks(
  read: RecordRead,
  expected: { mint: string; pool?: string; vault: string; sheetSha256?: string | null },
): RecordCheck[] {
  const checks: RecordCheck[] = [
    { label: "The record exists on chain", ok: read.exists },
    { label: "The record names this token", ok: read.attributes.mint === expected.mint },
    { label: "The program vault holds the master", ok: Boolean(expected.vault) && read.owner === expected.vault },
    { label: "The name and link are locked", ok: read.nameLocked },
    { label: "The attributes are locked", ok: read.attributesLocked },
    { label: "No plugin can be added", ok: read.addBlocked },
    { label: "Nobody can burn or move the record", ok: read.frozenForever },
  ];
  if (expected.pool) checks.splice(2, 0, { label: "The record names this pool", ok: read.attributes.pool === expected.pool });
  if (expected.sheetSha256 !== undefined) {
    checks.push({
      label: "The full record sheet matches the hash on chain",
      ok: Boolean(expected.sheetSha256) && expected.sheetSha256 === read.attributes["sheet sha256"],
    });
  }
  return checks;
}

export function parseRecordUri(uri: string): { asset: string; mint: string; cluster: ClusterName } | null {
  try {
    const url = new URL(uri);
    const match = /^\/r\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
    if (!match) return null;
    return {
      asset: match[1],
      mint: url.searchParams.get("m") || "",
      cluster: url.searchParams.get("c") === "devnet" ? "devnet" : "mainnet-beta",
    };
  } catch {
    return null;
  }
}
