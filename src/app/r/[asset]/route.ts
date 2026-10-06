import { Connection, PublicKey } from "@solana/web3.js";
import { rpcUrl, type ClusterName } from "@/lib/constants";
import { readTokenName } from "@/lib/load-pool";
import { readCopy } from "@/lib/record-copy";
import { PUBLIC_ORIGIN, RECORD_VAULT, readRecord, recordChecks, sha256Hex } from "@/lib/record";
import { poolPath, salePath, titleStatus } from "@/lib/title";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Sheet = { image?: string; description?: string; record?: { token?: { pool?: string } } };

async function loadSheet(uri: string, cluster: ClusterName, asset: string): Promise<{ text: string; from: string } | null> {
  if (uri.startsWith("https://")) {
    try {
      const response = await fetch(uri, { cache: "no-store" });
      if (response.ok) return { text: await response.text(), from: "arweave" };
    } catch {}
  }
  const copy = await readCopy(cluster, asset);
  return copy ? { text: copy, from: "par" } : null;
}

export async function GET(request: Request, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  const url = new URL(request.url);
  const cluster: ClusterName = url.searchParams.get("c") === "devnet" ? "devnet" : "mainnet-beta";
  const mint = url.searchParams.get("m") || "";
  if (!ADDRESS.test(asset) || !ADDRESS.test(mint)) return new Response("Not found", { status: 404 });

  const endpoint = rpcUrl(cluster);
  const [read, token] = await Promise.all([
    readRecord(endpoint, asset),
    readTokenName(new Connection(endpoint, "confirmed"), new PublicKey(mint)).catch(() => ({ name: "", symbol: "", uri: "" })),
  ]);

  let sheetHash: string | null = null;
  let sheet: Sheet = {};
  let sheetFrom = "";
  if (read.exists) {
    const loaded = await loadSheet(read.uri, cluster, asset);
    if (loaded) {
      sheetHash = await sha256Hex(new TextEncoder().encode(loaded.text));
      sheetFrom = loaded.from;
      try {
        sheet = JSON.parse(loaded.text) as Sheet;
      } catch {}
    }
  }
  const pool = read.attributes.pool || "";
  const checks = recordChecks(read, { mint, vault: RECORD_VAULT[cluster], sheetSha256: read.exists ? sheetHash : undefined });
  const title = read.exists ? await titleStatus(endpoint, cluster, { address: asset, attributes: read.attributes }) : null;
  const verified = checks.every((check) => check.ok);
  const network = cluster === "devnet" ? "?cluster=devnet" : "";
  const body = {
    name: token.name,
    symbol: token.symbol,
    description: read.exists
      ? read.attributes.coin === "none"
        ? `One title to one object. A buyer pays in ${token.symbol || "the named token"}. The sale is a fixed price or a bid. The master is ${asset}, sent to the program vault with the record sheet.`
        : `A payment token and a meme. It pays for the title to one real object. The meme is the joy and heart of the object. It is not a share, and it pays nothing. Its master is ${asset}, sent to the program vault with the record sheet.`
      : `Its record ${asset} has not been minted. Without the record this token is only half of the asset.`,
    image: typeof sheet.image === "string" ? sheet.image : "",
    external_url: ADDRESS.test(pool)
      ? `${PUBLIC_ORIGIN}${poolPath(pool, cluster)}`
      : title?.address
        ? `${PUBLIC_ORIGIN}${salePath(title.address, cluster)}`
        : PUBLIC_ORIGIN,
    record: {
      address: asset,
      network: cluster,
      status: read.exists ? (verified ? "verified" : "mismatch") : "missing",
      owner: read.owner,
      vault: RECORD_VAULT[cluster],
      sheet: read.uri,
      sheetFrom,
      pool,
      checks,
      explorer: `https://explorer.solana.com/address/${asset}${network}`,
      attributes: read.attributes,
    },
    title,
  };
  return Response.json(body, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": verified && !title ? "public, max-age=300, s-maxage=86400" : "no-store",
    },
  });
}
