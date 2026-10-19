/** Simulates (sigVerify off, never signed or sent) the exact deposit OpenEscrow builds for the screenshot's inputs. */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { deserializeAssetV1 } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { ESCROW_PROGRAM, escrowDepositAllowed, escrowDepositOpenInstruction } from "@/lib/title";
import { parseTokenAmount } from "@/lib/tensor-sale";
import { readClassicMint } from "@/lib/coin-read";
import { WSOL } from "@/lib/constants";
const RPC = process.env.RPC || "https://solana-devnet.api.onfinality.io/public";
const c = new Connection(RPC, "confirmed");
const CREATOR = new PublicKey(process.env.CREATOR || "RPS3j1r791zUDTwDwv3E1TRAK1H5qVYi1aHLd3gnBmY");
const TITLE = new PublicKey(process.env.TITLE || "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi");
const RECORD = new PublicKey(process.env.RECORD || "9vSeor8BrXwMC4KUTEeFzRmqgA8GQLadV61KRijWkf75");
(async () => {
  console.log("escrowDepositAllowed(devnet, creator) =", escrowDepositAllowed("devnet", CREATOR.toBase58()), "(this alone disables the button)");
  const info = await c.getAccountInfo(TITLE);
  const a = deserializeAssetV1({ publicKey: publicKey(TITLE.toBase58()), executable: false, owner: publicKey(info!.owner.toBase58()), lamports: { basisPoints: BigInt(info!.lamports), identifier: "SOL", decimals: 9 } as never, data: info!.data, exists: true } as never) as never as Record<string, any>;
  console.log("title updateAuthority:", JSON.stringify(a.updateAuthority), "attributes plugin authority:", JSON.stringify(a.attributes?.authority));
  const pay = await readClassicMint(c, WSOL);
  console.log("token read:", pay.symbol, pay.decimals);
  const raw = parseTokenAmount("0.20", pay.decimals)!;
  const ix = escrowDepositOpenInstruction({ program: new PublicKey(ESCROW_PROGRAM.devnet), creator: CREATOR, title: TITLE, record: RECORD, mint: new PublicKey(pay.mint), price: raw, delayDays: 0, burnPercent: 0, sale: "fixed", payouts: [] });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = CREATOR;
  tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  const sim = await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  console.log("devnet simulation err:", JSON.stringify(sim.value.err));
  console.log((sim.value.logs || []).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
