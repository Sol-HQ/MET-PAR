import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey } from "@solana/web3.js";
import { acceptedQuoteMints, rpcUrl, type ClusterName } from "@/lib/constants";
import { readCopy, writeCopy } from "@/lib/record-copy";
import { readRecord, RECORD_VAULT, sha256Hex } from "@/lib/record";
import { hasIndex, hasItem, saveItem } from "@/lib/store";
import { ESCROW_PROGRAM, listingAddress, readTitle, TITLE_KIND, type TitleRail } from "@/lib/title";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

type Sheet = {
  name?: string;
  record?: {
    token?: { config?: string; quoteMint?: string };
    title?: { address?: string; heldBy?: string; sale?: { opensDaysAfterGraduation?: number; burnPercent?: number } };
  };
};

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    asset?: string;
    cluster?: string;
    sheet?: string;
    signatures?: { record?: string; title?: string; deposit?: string };
  } | null;
  const asset = body?.asset || "";
  const sheet = body?.sheet || "";
  const cluster: ClusterName = body?.cluster === "devnet" ? "devnet" : "mainnet-beta";
  if (!ADDRESS.test(asset) || !sheet || sheet.length > 110_000) return fail("Send the record address and its record sheet.", 400);
  if (!hasIndex() && !process.env.BLOB_READ_WRITE_TOKEN) return fail("The PAR copy is not configured.", 503);

  const already = hasIndex() ? await hasItem(cluster, asset) : Boolean(await readCopy(cluster, asset));
  if (already) return Response.json({ saved: true, already: true });

  const endpoint = rpcUrl(cluster);
  const record = await readRecord(endpoint, asset);
  if (!record.exists) return fail("That record is not on chain yet.", 404);
  const hash = await sha256Hex(new TextEncoder().encode(sheet));
  if (hash !== record.attributes["sheet sha256"]) return fail("That record sheet does not match the hash on the record.", 409);
  if (record.attributes["title held by"] === "escrow program" && cluster !== "devnet") {
    return fail("The escrow is not on this network.", 409);
  }

  const titleAddress = record.attributes.title || "";
  if (!hasIndex()) {
    await writeCopy(cluster, asset, sheet);
    return Response.json({ saved: true });
  }
  if (!ADDRESS.test(titleAddress)) return fail("That record names no title.", 409);
  if (record.owner !== RECORD_VAULT[cluster] || !record.frozenForever || !record.attributesLocked) {
    return fail("The program vault does not hold this master locked.", 409);
  }

  const parsed = JSON.parse(sheet) as Sheet;
  const facts = record.attributes;
  const rail: TitleRail = facts["title held by"] === "escrow program" ? "escrow" : "creator";
  const title = await readTitle(endpoint, titleAddress);
  if (!title.exists) return fail("The title is not on chain yet.", 404);
  if (title.attributes.title !== TITLE_KIND || title.attributes.record !== asset || title.attributes.mint !== facts.mint) {
    return fail("The title does not name this record and token.", 409);
  }
  if (title.attributes["held by"] !== facts["title held by"]) return fail("The title and record disagree on who holds the title.", 409);
  if (!title.locked || !title.clean) return fail("The title can still be changed, moved, or frozen by someone.", 409);
  if (parsed.record?.title?.address !== titleAddress) return fail("The record sheet names a different title.", 409);

  let listing: string | null = null;
  if (rail === "escrow") {
    if (cluster !== "devnet" || !ESCROW_PROGRAM[cluster]) return fail("The escrow is not on this network.", 409);
    listing = listingAddress(new PublicKey(titleAddress), new PublicKey(ESCROW_PROGRAM[cluster])).toBase58();
    if (title.owner !== listing) return fail("The escrow does not hold the title yet.", 409);
  } else if (title.owner !== facts.creator) {
    return fail("The creator wallet does not hold the title.", 409);
  }

  const noCoin = facts.coin === "none";
  const config = parsed.record?.token?.config || "";
  const quoteMint = parsed.record?.token?.quoteMint || "";
  const sale = parsed.record?.title?.sale;
  let delay = Number(sale?.opensDaysAfterGraduation);
  let burn = Number(sale?.burnPercent);
  if (noCoin) {
    if (facts.pool !== "none") return fail("A title with no coin names a pool.", 409);
    delay = 0;
    burn = 0;
  } else {
    if (!ADDRESS.test(config) || !acceptedQuoteMints(cluster).includes(quoteMint)) return fail("The record sheet template or quote is not valid.", 409);
    const derived = deriveDbcPoolAddress(new PublicKey(quoteMint), new PublicKey(facts.mint), new PublicKey(config)).toBase58();
    if (derived !== facts.pool) return fail("The template does not lead to the pool on the record.", 409);
    if (!Number.isInteger(delay) || delay < 1 || delay > 365 || !Number.isInteger(burn) || burn < 0 || burn > 98) {
      return fail("The record sheet sale terms are not valid.", 409);
    }
  }
  const signatures = Object.fromEntries(
    Object.entries(body?.signatures ?? {}).filter(([, value]) => typeof value === "string" && SIGNATURE.test(value)),
  );

  await saveItem(
    {
      cluster,
      record: asset,
      title: titleAddress,
      mint: facts.mint,
      pool: facts.pool,
      config,
      creator: facts.creator,
      vault: record.owner,
      rail,
      listing,
      name: record.name,
      symbol: facts.symbol || "",
      quote: facts.quote || "",
      sheet_uri: record.uri,
      sheet_sha256: hash,
      image_sha256: facts["image sha256"] || "",
      sale_delay_days: delay,
      burn_percent: burn,
      sheet,
    },
    signatures,
  );
  return Response.json({ saved: true });
}
