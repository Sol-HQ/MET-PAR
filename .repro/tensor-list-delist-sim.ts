/** Simulates (never signs or sends) the list and delist instructions SaleTrade builds. */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { delistOnTensorInstruction, listOnTensorInstruction, parseTokenAmount } from "@/lib/tensor-sale";
async function sim(label: string, rpc: string, payer: PublicKey, ix: ReturnType<typeof listOnTensorInstruction>) {
  const c = new Connection(rpc, "confirmed");
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ix);
  tx.feePayer = payer; tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  const r = await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  console.log(label, "err:", JSON.stringify(r.value.err), "units", r.value.unitsConsumed);
  if (r.value.err) console.log((r.value.logs || []).slice(-6).join("\n"));
}
(async () => {
  const DEV = process.env.DEVNET_RPC || "https://solana-devnet.api.onfinality.io/public";
  const MAIN = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
  const devCreator = new PublicKey("RPS3j1r791zUDTwDwv3E1TRAK1H5qVYi1aHLd3gnBmY");
  await sim("DEVNET list 0.2 SOL (raw " + parseTokenAmount("0.2", 9) + ")", DEV, devCreator, listOnTensorInstruction({ title: new PublicKey("4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi"), creator: devCreator, mint: new PublicKey("So11111111111111111111111111111111111111112"), price: parseTokenAmount("0.2", 9)!, collection: new PublicKey("7WCvRVVEFaa2fPsdCe1HgYw1yT5diUnuuxHcL5s3yxvc") }));
  const mainSeller = new PublicKey("ZERoZWcmzTH6YwzwjtAqzmpBrP3GxPFLD5pQNFMcqVC");
  await sim("MAINNET delist (seller)", MAIN, mainSeller, delistOnTensorInstruction({ title: new PublicKey("FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL"), creator: mainSeller, collection: new PublicKey("DeLYS76csbh6GcMb4Bcad58bxbMM1mdoTZFpivHMaPoZ") }));
})().catch((e) => { console.error(e); process.exit(1); });
