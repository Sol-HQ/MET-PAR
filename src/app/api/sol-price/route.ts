const SOL_MINT = "So11111111111111111111111111111111111111112";

async function jupiterPrice(): Promise<number | null> {
  const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { cache: "no-store" });
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, { usdPrice?: number }>;
  const usd = Number(body[SOL_MINT]?.usdPrice);
  return usd > 0 ? usd : null;
}

async function coinbasePrice(): Promise<number | null> {
  const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { cache: "no-store" });
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: { amount?: string } };
  const usd = Number(body.data?.amount);
  return usd > 0 ? usd : null;
}

export async function GET() {
  try {
    const usd = (await jupiterPrice()) ?? (await coinbasePrice());
    if (!usd) return Response.json({ error: "The SOL price is not available." }, { status: 503 });
    return Response.json({ usd }, { headers: { "cache-control": "public, max-age=20" } });
  } catch {
    return Response.json({ error: "The SOL price is not available." }, { status: 503 });
  }
}
