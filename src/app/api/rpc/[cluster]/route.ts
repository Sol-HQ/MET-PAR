import { serverRpcUrl, type ClusterName } from "@/lib/constants";

const MAX_BODY = 200_000;

function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/** Forwards JSON-RPC from this site's pages to the keyed RPC held in server env. */
export async function POST(request: Request, context: { params: Promise<{ cluster: string }> }) {
  const { cluster: named } = await context.params;
  const cluster: ClusterName | null = named === "devnet" ? "devnet" : named === "mainnet" ? "mainnet-beta" : null;
  if (!cluster) return Response.json({ error: "Unknown network." }, { status: 404 });
  if (!sameSite(request)) return Response.json({ error: "This RPC serves PAR pages only." }, { status: 403 });

  const body = await request.text();
  if (!body || body.length > MAX_BODY) return Response.json({ error: "Send one JSON-RPC request." }, { status: 400 });

  const upstream = await fetch(serverRpcUrl(cluster), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
  });
}
