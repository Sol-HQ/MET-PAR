import { head, put } from "@vercel/blob";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { acceptedQuoteMints, HIDDEN_POOLS, rpcUrl, type ClusterName } from "@/lib/constants";
import { checkQuoteMint } from "@/lib/quote-gate";
import { hasIndex, listPools, savePool } from "@/lib/store";

const PATH = "platform/listings.json";

type Listing = {
  pool: string;
  cluster: ClusterName;
  config: string;
};

async function readListings(): Promise<Listing[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  try {
    const existing = await head(PATH);
    const response = await fetch(existing.downloadUrl, {
      cache: "no-store",
      headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { pools?: Listing[] };
    return Array.isArray(body.pools) ? body.pools : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const cluster = new URL(request.url).searchParams.get("cluster");
  const pools = hasIndex()
    ? await listPools(cluster === "devnet" || cluster === "mainnet-beta" ? cluster : null)
    : await readListings();
  const visible = pools.filter((item) => !HIDDEN_POOLS.has(item.pool));
  const filtered = cluster === "devnet" || cluster === "mainnet-beta" ? visible.filter((item) => item.cluster === cluster) : visible;
  return Response.json({ pools: filtered }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { pool?: string; cluster?: ClusterName };
  if (body.cluster !== "devnet" && body.cluster !== "mainnet-beta") {
    return Response.json({ error: "That network is not a PAR cluster." }, { status: 400 });
  }
  let poolKey: PublicKey;
  try {
    poolKey = new PublicKey(body.pool || "");
  } catch {
    return Response.json({ error: "That pool address is not valid." }, { status: 400 });
  }
  const connection = new Connection(rpcUrl(body.cluster), "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const pool = await client.state.getPool(poolKey);
  if (!pool) return Response.json({ error: "No pool at that address." }, { status: 400 });
  const config = await client.state.getPoolConfig(pool.poolState.config);
  if (!config || config.feeClaimer.toBase58() !== PLATFORM_FEE_CLAIMER) {
    return Response.json({ error: "That pool does not pay the platform wallet." }, { status: 400 });
  }
  if (!acceptedQuoteMints(body.cluster).includes(config.quoteMint.toBase58())) {
    const quote = await checkQuoteMint(connection, config.quoteMint.toBase58());
    if (!quote.ok) {
      return Response.json({ error: quote.message }, { status: 400 });
    }
  }
  const listing: Listing = {
    pool: poolKey.toBase58(),
    cluster: body.cluster,
    config: pool.poolState.config.toBase58(),
  };
  if (hasIndex()) {
    if (!HIDDEN_POOLS.has(listing.pool)) await savePool(listing);
    const indexed = await listPools(body.cluster);
    return Response.json({ pools: indexed.filter((item) => !HIDDEN_POOLS.has(item.pool)) });
  }
  const pools = (await readListings()).filter((item) => !HIDDEN_POOLS.has(item.pool));
  if (!HIDDEN_POOLS.has(listing.pool) && !pools.some((item) => item.pool === listing.pool)) pools.unshift(listing);
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ error: "Listing storage is not configured." }, { status: 503 });
  }
  await put(PATH, JSON.stringify({ pools: pools.slice(0, 200) }), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });
  return Response.json({ pools: pools.filter((item) => item.cluster === body.cluster) });
}
