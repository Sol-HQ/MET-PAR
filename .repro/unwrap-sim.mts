// Read-only: simulate Unwrap SOL (the exact instruction the app builds) on mainnet and devnet. Nothing is signed or sent.
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readWrappedSol, unwrapSolInstruction } from "../src/lib/token-pay";
const cases = [
  ["mainnet", "https://api.mainnet-beta.solana.com", process.argv[2] ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
  ["devnet", "https://solana-devnet.api.onfinality.io/public", "RPS3j1r791zUDTwDwv3E1TRAK1H5qVYi1aHLd3gnBmY"],
] as const;
for (const [name, rpc, who] of cases) {
  const c = new Connection(rpc, "confirmed");
  const owner = new PublicKey(who);
  const holding = await readWrappedSol(c, owner);
  if (!holding) { console.log(name, who, "no wrapped-SOL account"); continue; }
  const before = await c.getBalance(owner, "confirmed");
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [unwrapSolInstruction(owner)] }).compileToV0Message();
  const sim = await c.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [owner.toBase58(), holding.account.toBase58()] },
  });
  const after = sim.value.accounts?.[0]?.lamports ?? NaN;
  const ataAfter = sim.value.accounts?.[1];
  const fee = 5000;
  console.log(JSON.stringify({
    network: name, owner: who, wsolAccount: holding.account.toBase58(), wrappedAmount: holding.amount.toString(),
    accountLamports: holding.lamports.toString(), closable: holding.closable, err: sim.value.err,
    ownerBefore: before, ownerAfter: after, gained: after - before, expectedGain: Number(holding.lamports) - fee,
    match: after - before === Number(holding.lamports) - fee,
    wsolAccountAfter: ataAfter === null ? "closed" : ataAfter ? `lamports ${ataAfter.lamports}` : "unknown",
    units: sim.value.unitsConsumed, logs: sim.value.logs,
  }, null, 1));
  await new Promise((r) => setTimeout(r, 1500));
}
