import { Connection } from "@solana/web3.js";
import { CLOCK_SYSVAR, readClock } from "@/lib/chain-beat";
import { publicRpcUrl, type ClusterName } from "@/lib/constants";

/** Clock and recent blockhash from the keyless public RPC. Shared cache, so visitors do not each hit Helius. */
export async function GET(request: Request) {
  const named = new URL(request.url).searchParams.get("c");
  const cluster: ClusterName = named === "mainnet" ? "mainnet-beta" : "devnet";
  const connection = new Connection(publicRpcUrl(cluster), "confirmed");
  try {
    const [clockInfo, latest] = await Promise.all([
      connection.getAccountInfo(CLOCK_SYSVAR, "confirmed"),
      connection.getLatestBlockhash("confirmed"),
    ]);
    const clock = clockInfo?.data ? readClock(Uint8Array.from(clockInfo.data)) : null;
    return Response.json(
      {
        unixTimestamp: clock?.unixTimestamp ?? 0,
        slot: clock?.slot ?? 0,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      { headers: { "cache-control": "public, max-age=8, s-maxage=12, stale-while-revalidate=24" } },
    );
  } catch {
    return Response.json({ error: "The Solana clock could not be read." }, { status: 502 });
  }
}
