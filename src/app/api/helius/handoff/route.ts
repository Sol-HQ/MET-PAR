import { noteHolder, syncHeliusHook, titlesInPayload, webhookAuthorized } from "@/lib/handoff-server";
import type { ClusterName } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 1_500_000;

export async function POST(request: Request) {
  if (!webhookAuthorized(request.headers.get("authorization"))) {
    return Response.json({ error: "This notice is not authorized." }, { status: 401 });
  }
  const cluster: ClusterName = new URL(request.url).searchParams.get("c") === "devnet" ? "devnet" : "mainnet-beta";
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ ok: true, skipped: "large" });
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ ok: true, skipped: "body" });
  }
  await syncHeliusHook(cluster).catch(() => undefined);
  const titles = await titlesInPayload(cluster, payload);
  let retry = false;
  for (const title of titles) {
    const noted = await noteHolder(cluster, title).catch(() => null);
    if (noted?.retry) retry = true;
  }
  if (retry) return Response.json({ ok: false }, { status: 500 });
  return Response.json({ ok: true, titles: titles.length });
}
