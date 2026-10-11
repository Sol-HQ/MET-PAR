import { createHash, createHmac } from "node:crypto";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { buyerTotal, formatTokenAmount } from "../src/lib/tensor-sale";
import { PUBLIC_ORIGIN, RECORD_KIND, RECORD_VAULT, parseRecordUri, readRecord } from "../src/lib/record";
import { serverRpcUrl, WSOL, type ClusterName } from "../src/lib/constants";
import { allowBlinkRequest, readItemByTitle } from "../src/lib/store";
import { readTitle, readTensorListing, saleUrl, tensorListAddress } from "../src/lib/title";
import { isBlinkSaleOpen, textForBlink } from "./policy";
import { buildTensorPurchaseTransaction, serializeBuyerOnlyTransaction } from "./transaction";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_REQUEST_BYTES = 8_192;
const BLOCKCHAIN_IDS: Record<ClusterName, string> = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

export const ACTION_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "Content-Type,Authorization,Content-Encoding,Accept-Encoding,X-Action-Version,X-Blockchain-Ids",
  "cache-control": "no-store, max-age=0",
  "x-action-version": "2.4",
} as const;

export class BlinkProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BlinkProblem";
  }
}

type Sheet = {
  name?: string;
  record?: {
    creator?: string;
    token?: { mint?: string; symbol?: string; decimals?: number; quoteMint?: string };
    object?: { name?: string; story?: string };
    pitch?: string;
    claim?: { text?: string };
    curve?: { coin?: string };
    title?: { address?: string; sale?: { payIn?: string } };
  };
};

type BlinkListing = {
  cluster: ClusterName;
  title: PublicKey;
  collection: PublicKey | null;
  creator: PublicKey;
  mint: PublicKey;
  decimals: number;
  symbol: string;
  name: string;
  description: string;
  price: bigint;
  buyerTotal: bigint;
};

function clusterFromRequest(request: Request): ClusterName {
  return new URL(request.url).searchParams.get("c") === "devnet" ? "devnet" : "mainnet-beta";
}

function actionOrigin(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
  return PUBLIC_ORIGIN;
}

function clusterEnabled(cluster: ClusterName): boolean {
  const name = cluster === "devnet" ? "PAR_BLINK_DEVNET_ENABLED" : "PAR_BLINK_MAINNET_ENABLED";
  return process.env[name] === "true";
}

async function enforceRequestLimit(request: Request, method: "GET" | "POST", cluster: ClusterName): Promise<void> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new BlinkProblem("The purchase service is not configured.", 503);
  const address = request.headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
  const digest = createHmac("sha256", secret).update(`${cluster}\n${method}\n${address}`).digest("hex");
  const allowed = await allowBlinkRequest(digest, method === "GET" ? 120 : 12, method === "GET" ? 600 : 3600);
  if (!allowed) throw new BlinkProblem("Too many requests. Please wait and try again.", 429);
}

function publicKey(value: string, label: string): PublicKey {
  if (!ADDRESS.test(value)) throw new BlinkProblem(`The ${label} address is invalid.`, 400);
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error("Non-canonical public key");
    return key;
  } catch {
    throw new BlinkProblem(`The ${label} address is invalid.`, 400);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sealedSheet(text: string, expectedHash: string): Sheet {
  if (!text || text.length > 110_000 || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new BlinkProblem("The verified item sheet is unavailable.", 503);
  }
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (actual !== expectedHash.toLowerCase()) throw new BlinkProblem("The item sheet does not match its on-chain hash.", 409);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BlinkProblem("The verified item sheet could not be read.", 503);
  }
  if (!plainObject(parsed) || !plainObject(parsed.record)) throw new BlinkProblem("This title has no valid PAR item sheet.", 409);
  return parsed as Sheet;
}

async function resolveListing(titleAddress: string, cluster: ClusterName): Promise<BlinkListing> {
  const titleKey = publicKey(titleAddress, "title");
  const endpoint = serverRpcUrl(cluster);
  const connection = new Connection(endpoint, "confirmed");
  const [title, item] = await Promise.all([
    readTitle(endpoint, titleKey.toBase58()),
    readItemByTitle(cluster, titleKey.toBase58()),
  ]).catch(() => {
    throw new BlinkProblem("PAR could not verify this title right now.", 503);
  });
  if (!item || item.title !== titleKey.toBase58() || item.cluster !== cluster) {
    throw new BlinkProblem("This title is not in PAR's verified item index.", 404);
  }
  if (!title.exists || title.attributes.title !== "PAR title v1") {
    throw new BlinkProblem("This is not a PAR title NFT.", 404);
  }
  const recordAddress = title.attributes.record || "";
  const recordKey = publicKey(recordAddress, "record");
  const record = await readRecord(endpoint, recordKey.toBase58()).catch(() => null);
  if (!record?.exists || record.attributes.record !== RECORD_KIND) {
    throw new BlinkProblem("The PAR master record could not be verified.", 409);
  }
  const recordLink = parseRecordUri(record.uri);
  const creatorAddress = record.attributes.creator || "";
  const creator = publicKey(creatorAddress, "creator");
  const recordMint = record.attributes.mint || "";
  const mint = publicKey(recordMint, "payment token");
  if (record.owner !== RECORD_VAULT[cluster]) {
    throw new BlinkProblem(`Record owner mismatch: expected ${RECORD_VAULT[cluster]}, got ${record.owner}`, 409);
  }
  if (!record.nameLocked) {
    throw new BlinkProblem("Record name is not locked", 409);
  }
  if (!record.attributesLocked) {
    throw new BlinkProblem("Record attributes are not locked", 409);
  }
  if (!record.addBlocked) {
    throw new BlinkProblem("Record does not have add blocked", 409);
  }
  if (!record.frozenForever) {
    throw new BlinkProblem("Record is not frozen forever", 409);
  }
  if (!title.locked) {
    throw new BlinkProblem("Title is not locked", 409);
  }
  if (!title.clean) {
    throw new BlinkProblem("Title is not clean", 409);
  }
  if (!title.collection) {
    throw new BlinkProblem("Title has no collection", 409);
  }
  if (!title.collectionSealed) {
    throw new BlinkProblem("Title collection is not sealed", 409);
  }
  if (title.edition !== 1) {
    throw new BlinkProblem(`Title edition is ${title.edition}, expected 1`, 409);
  }
  if (item.record !== recordKey.toBase58()) {
    throw new BlinkProblem(`Index record mismatch: index has ${item.record}, on-chain has ${recordKey.toBase58()}`, 409);
  }
  if (item.creator !== creator.toBase58()) {
    throw new BlinkProblem(`Index creator mismatch: index has ${item.creator}, on-chain has ${creator.toBase58()}`, 409);
  }
  if (title.attributes.record !== recordKey.toBase58()) {
    throw new BlinkProblem(`Title record attribute mismatch: ${title.attributes.record} vs ${recordKey.toBase58()}`, 409);
  }
  if (title.attributes.creator !== creator.toBase58()) {
    throw new BlinkProblem(`Title creator attribute mismatch: ${title.attributes.creator} vs ${creator.toBase58()}`, 409);
  }
  if (title.attributes.mint !== mint.toBase58()) {
    throw new BlinkProblem(`Title mint attribute mismatch: ${title.attributes.mint} vs ${mint.toBase58()}`, 409);
  }
  if (record.attributes.title !== titleKey.toBase58()) {
    throw new BlinkProblem(`Record title attribute mismatch: ${record.attributes.title} vs ${titleKey.toBase58()}`, 409);
  }
  if (record.attributes["title held by"] !== "creator wallet") {
    throw new BlinkProblem(`Record 'title held by' is '${record.attributes["title held by"]}', expected 'creator wallet'`, 409);
  }
  if (title.attributes["held by"] !== "creator wallet") {
    throw new BlinkProblem(`Title 'held by' is '${title.attributes["held by"]}', expected 'creator wallet'`, 409);
  }
  if (record.attributes["sold through"] !== "Tensor marketplace program") {
    throw new BlinkProblem(`Record 'sold through' is '${record.attributes["sold through"]}', expected 'Tensor marketplace program'`, 409);
  }
  if (title.attributes["sold through"] !== "Tensor marketplace program") {
    throw new BlinkProblem(`Title 'sold through' is '${title.attributes["sold through"]}', expected 'Tensor marketplace program'`, 409);
  }
  if (record.attributes["sheet sha256"] !== item.sheet_sha256) {
    throw new BlinkProblem(`Sheet SHA256 mismatch: record has ${record.attributes["sheet sha256"]}, index has ${item.sheet_sha256}`, 409);
  }
  // Skip record link validation if URI is Arweave (common for sheet URIs)
  // We already have mint and cluster from the database
  if (recordLink && !record.uri.startsWith("https://arweave.net/")) {
    if (recordLink.asset !== recordKey.toBase58()) {
      throw new BlinkProblem(`Record link asset mismatch: ${recordLink.asset} vs ${recordKey.toBase58()}`, 409);
    }
    if (recordLink.mint !== mint.toBase58()) {
      throw new BlinkProblem(`Record link mint mismatch: ${recordLink.mint} vs ${mint.toBase58()}`, 409);
    }
    if (recordLink.cluster !== cluster) {
      throw new BlinkProblem(`Record link cluster mismatch: ${recordLink.cluster} vs ${cluster}`, 409);
    }
  }
  const sheet = sealedSheet(item.sheet, record.attributes["sheet sha256"] || "");
  const sheetRecord = sheet.record!;
  if (sheetRecord.creator !== creator.toBase58()) {
    throw new BlinkProblem(`Sheet creator mismatch: ${sheetRecord.creator} vs ${creator.toBase58()}`, 409);
  }
  if (sheetRecord.token?.mint !== mint.toBase58()) {
    throw new BlinkProblem(`Sheet token mint mismatch: ${sheetRecord.token?.mint} vs ${mint.toBase58()}`, 409);
  }
  if (sheetRecord.title?.address !== titleKey.toBase58()) {
    throw new BlinkProblem(`Sheet title address mismatch: ${sheetRecord.title?.address} vs ${titleKey.toBase58()}`, 409);
  }
  if (sheetRecord.title?.sale?.payIn !== mint.toBase58()) {
    throw new BlinkProblem(`Sheet sale payIn mismatch: ${sheetRecord.title?.sale?.payIn} vs ${mint.toBase58()}`, 409);
  }
  if (record.attributes["full sheet"] !== title.attributes["full sheet"]) {
    throw new BlinkProblem("Full sheet hash mismatch between record and title", 409);
  }

  const listingAddress = tensorListAddress(titleKey);
  if (title.owner !== listingAddress.toBase58()) throw new BlinkProblem("This title is not currently listed on Tensor.", 409);
  const listing = await readTensorListing(connection, titleKey).catch(() => null);
  if (!listing || listing.seller !== creator.toBase58()) throw new BlinkProblem("The live Tensor listing could not be verified.", 409);
  if (!listing.currency || listing.currency !== mint.toBase58()) {
    throw new BlinkProblem("This listing uses a payment currency PAR's Blink cannot safely verify.", 409);
  }
  const noCoin = record.attributes.coin === "none";
  if (sheetRecord.curve?.coin !== (noCoin ? "none" : undefined) || title.attributes.coin !== record.attributes.coin) {
    throw new BlinkProblem("The sheet and on-chain coin status do not agree.", 409);
  }
  let graduated: boolean | null = true;
  let finishedAt = 0;
  if (!noCoin) {
    const pool = record.attributes.pool || "";
    publicKey(pool, "pool");
    const poolAccount = await connection.getAccountInfo(new PublicKey(pool), "confirmed").catch(() => null);
    if (poolAccount) {
      const { curveSale } = await import("../src/lib/load-pool");
      const curve = await curveSale(connection, pool);
      graduated = curve?.graduated ?? null;
      finishedAt = curve?.finishedAt ?? 0;
    } else {
      graduated = null;
    }
  }
  if (!isBlinkSaleOpen({
    noCoin,
    saleOpens: title.attributes["sale opens"] || "",
    graduated,
    finishedAt,
    nowSeconds: Math.floor(Date.now() / 1000),
  })) {
    throw new BlinkProblem("The Tensor sale has not opened under this title's signed terms.", 409);
  }

  const mintInfo = await getMint(connection, mint, "confirmed").catch(() => null);
  if (!mintInfo || mintInfo.decimals < 0 || mintInfo.decimals > 9) {
    throw new BlinkProblem("The listing payment token is not a supported SPL token.", 409);
  }
  const sheetDecimals = sheetRecord.token?.decimals;
  if (typeof sheetDecimals !== "number" || sheetDecimals !== mintInfo.decimals) {
    throw new BlinkProblem("The payment token's decimals do not match the signed sheet.", 409);
  }
  const symbol = textForBlink(sheetRecord.token?.symbol || record.attributes.symbol, 16);
  if (!symbol) throw new BlinkProblem("The signed sheet does not name the payment token.", 409);
  const name = textForBlink(sheetRecord.object?.name || title.name || item.name, 96);
  if (!name) throw new BlinkProblem("This title has no verified display name.", 409);
  const description = textForBlink(sheetRecord.pitch || sheetRecord.object?.story || sheetRecord.claim?.text, 160);
  const price = listing.amount;
  if (price <= BigInt(0)) throw new BlinkProblem("This Tensor listing has no valid price.", 409);
  const total = buyerTotal(price);
  return {
    cluster,
    title: titleKey,
    collection: title.collection ? new PublicKey(title.collection) : null,
    creator,
    mint,
    decimals: mintInfo.decimals,
    symbol: mint.toBase58() === WSOL ? "SOL" : symbol,
    name,
    description,
    price,
    buyerTotal: total,
  };
}

export function actionHeaders(cluster: ClusterName): HeadersInit {
  return { ...ACTION_HEADERS, "x-blockchain-ids": BLOCKCHAIN_IDS[cluster], "content-type": "application/json; charset=utf-8" };
}

export function actionOptions(cluster: ClusterName): Response {
  return new Response(null, { status: 204, headers: actionHeaders(cluster) });
}

export function actionError(problem: unknown, cluster: ClusterName): Response {
  const known = problem instanceof BlinkProblem;
  const status = known ? problem.status : 503;
  const message = known ? problem.message : "PAR could not prepare this purchase right now.";
  const headers = actionHeaders(cluster);
  if (status === 429) Object.assign(headers, { "retry-after": "60" });
  return Response.json({ message }, { status, headers });
}

export async function getAction(request: Request, titleAddress: string): Promise<Response> {
  const cluster = clusterFromRequest(request);
  try {
    if (!clusterEnabled(cluster)) throw new BlinkProblem("This PAR purchase link is not enabled yet.", 503);
    await enforceRequestLimit(request, "GET", cluster);
    const listing = await resolveListing(titleAddress, cluster);
    const origin = actionOrigin(request);
    const href = `${origin}/api/actions/title/${encodeURIComponent(listing.title.toBase58())}${cluster === "devnet" ? "?c=devnet" : ""}`;
    const body = {
      type: "action",
      icon: `${PUBLIC_ORIGIN}/api/actions/icon`,
      title: listing.name,
      description: [
        `${formatTokenAmount(listing.price, listing.decimals)} ${listing.symbol} listed.`,
        `${formatTokenAmount(listing.buyerTotal, listing.decimals)} ${listing.symbol} including Tensor's buyer fee; wallet fees and any new account rent are extra.`,
        "You receive the title NFT. Arrange physical handoff on PAR.",
      ].join(" "),
      label: "Buy title",
      links: { actions: [{ type: "transaction", label: "Buy title", href }] },
    };
    return Response.json(body, { headers: actionHeaders(cluster) });
  } catch (problem) {
    return actionError(problem, cluster);
  }
}

type ActionPostRequest = { account?: unknown };

export async function postAction(request: Request, titleAddress: string): Promise<Response> {
  const cluster = clusterFromRequest(request);
  try {
    if (!clusterEnabled(cluster)) throw new BlinkProblem("This PAR purchase link is not enabled yet.", 503);
    await enforceRequestLimit(request, "POST", cluster);
    const contentType = request.headers.get("content-type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new BlinkProblem("Send the wallet account as JSON.", 415);
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_REQUEST_BYTES) throw new BlinkProblem("The purchase request is too large.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new BlinkProblem("Send a valid wallet account.", 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new BlinkProblem("The purchase request is too large.", 413);
      }
      chunks.push(value);
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (!raw) throw new BlinkProblem("Send a valid wallet account.", 400);
    let body: ActionPostRequest;
    try {
      body = JSON.parse(raw) as ActionPostRequest;
    } catch {
      throw new BlinkProblem("Send a valid wallet account.", 400);
    }
    if (typeof body.account !== "string") throw new BlinkProblem("Connect a Solana wallet to continue.", 400);
    const buyer = publicKey(body.account, "buyer wallet");
    const listing = await resolveListing(titleAddress, cluster);
    const buyerAta = getAssociatedTokenAddressSync(listing.mint, buyer);
    const connection = new Connection(serverRpcUrl(cluster), "confirmed");
    let wrappedSolShortfall = BigInt(0);
    if (listing.mint.toBase58() === WSOL) {
      const accountInfo = await connection.getAccountInfo(buyerAta, "confirmed").catch(() => {
        throw new BlinkProblem("PAR could not verify your wrapped-SOL balance.", 503);
      });
      const account = accountInfo
        ? await getAccount(connection, buyerAta, "confirmed").catch(() => {
            throw new BlinkProblem("Your wrapped-SOL account could not be verified.", 409);
          })
        : null;
      const wrappedBalance = account?.amount ?? BigInt(0);
      wrappedSolShortfall = listing.buyerTotal > wrappedBalance ? listing.buyerTotal - wrappedBalance : BigInt(0);
    }
    const transaction = buildTensorPurchaseTransaction({
      title: listing.title,
      mint: listing.mint,
      seller: listing.creator,
      buyer,
      price: listing.price,
      collection: listing.collection,
      wrappedSolShortfall,
    });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    let encoded: string;
    try {
      encoded = serializeBuyerOnlyTransaction(transaction, buyer);
    } catch (problem) {
      throw new BlinkProblem(problem instanceof Error ? problem.message : "The purchase transaction is invalid.", 409);
    }
    return Response.json(
      {
        transaction: encoded,
        message: `${listing.name}: up to ${formatTokenAmount(listing.buyerTotal, listing.decimals)} ${listing.symbol}, including Tensor's buyer fee; wallet fees and any new account rent are extra. You receive the title NFT. Arrange physical handoff on PAR: ${saleUrl(listing.title.toBase58(), cluster)}`,
      },
      { headers: actionHeaders(cluster) },
    );
  } catch (problem) {
    return actionError(problem, cluster);
  }
}