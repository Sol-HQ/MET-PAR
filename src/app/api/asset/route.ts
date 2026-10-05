import { poolAssets } from "@/lib/asset-on-pool";
import type { ClusterName } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cluster: ClusterName = url.searchParams.get("cluster") === "devnet" ? "devnet" : "mainnet-beta";
  const pool = url.searchParams.get("pool") || "";
  if (pool && !ADDRESS.test(pool)) return Response.json({ assets: [] });
  try {
    const assets = await poolAssets(cluster, pool || undefined);
    return Response.json({ assets }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ assets: [] }, { headers: { "cache-control": "no-store" } });
  }
}
