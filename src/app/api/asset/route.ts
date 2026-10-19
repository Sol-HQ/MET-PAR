import { poolAssets } from "@/lib/asset-on-pool";
import type { ClusterName } from "@/lib/constants";
import { hasIndex, listItems } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cluster: ClusterName = url.searchParams.get("cluster") === "devnet" ? "devnet" : "mainnet-beta";
  const pool = url.searchParams.get("pool") || "";
  if (pool && !ADDRESS.test(pool)) return Response.json({ assets: [] });
  try {
    const saved = hasIndex() ? await listItems(cluster, 100).catch(() => []) : [];
    const assets = await poolAssets(cluster, pool || undefined, saved.map((item) => item.record));
    return Response.json({ assets }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ assets: [], error: "The records could not be read." }, { headers: { "cache-control": "no-store" } });
  }
}
