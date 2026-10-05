import { watchOnce } from "@/lib/watch-pass";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return Response.json({ error: "This pass is not authorized." }, { status: 401 });
  }
  try {
    const result = await watchOnce();
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const note = error instanceof Error ? error.message : "The pass failed.";
    return Response.json({ ok: false, note }, { status: 500 });
  }
}
