import { remindOpenHolds } from "@/lib/handoff-server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return Response.json({ error: "This pass is not authorized." }, { status: 401 });
  }
  const devnet = await remindOpenHolds("devnet").catch(() => ({ checked: 0, retry: true }));
  const mainnet = await remindOpenHolds("mainnet-beta").catch(() => ({ checked: 0, retry: true }));
  const retry = devnet.retry || mainnet.retry;
  return Response.json(
    { ok: !retry, devnet: devnet.checked, mainnet: mainnet.checked },
    { status: retry ? 500 : 200, headers: { "cache-control": "no-store" } },
  );
}
