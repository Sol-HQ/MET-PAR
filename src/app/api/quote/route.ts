import { Connection } from "@solana/web3.js";
import { rpcUrl } from "@/lib/constants";
import { checkQuoteMint, type QuoteCheck } from "@/lib/quote-gate";

const blocked = (mint: string, message: string): QuoteCheck => ({
  ok: false,
  mint,
  decimals: 0,
  symbol: "",
  badge: null,
  path: "blocked",
  message,
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cluster = url.searchParams.get("cluster");
  const mint = url.searchParams.get("mint") || "";
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    return Response.json(blocked(mint, "That network is not a PAR cluster."), { status: 400 });
  }
  try {
    const quote = await checkQuoteMint(new Connection(rpcUrl(cluster), "confirmed"), mint);
    return Response.json(quote);
  } catch {
    return Response.json(blocked(mint, "The network did not answer that mint. Try the check again."));
  }
}
