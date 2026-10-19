/** Mainnet: builds the exact Tensor buy the sale page builds for the live listing and simulates it. Never signed or sent. */
import { Connection, Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { buyOnTensorTransaction, buyerTotal, formatTokenAmount, wrappedSolShortfall } from "@/lib/tensor-sale";
import { prepareTransaction, sendPrepared, transactionBytes } from "@/lib/send";
import { readTitle, titleStatus } from "@/lib/title";
import { readRecord } from "@/lib/record";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const APP_ENDPOINT = "https://www.meteora.surf/api/rpc/mainnet";
const TITLE = process.env.TITLE || "FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL";
const BUYER = new PublicKey(process.env.BUYER || "mejmPbxqeMgnKqZeF4du3TkBncRAfLmnof7LnGnnpNf");
const real = new Connection(RPC, "confirmed");
const fakeNonce = Keypair.generate().publicKey, fakeNonceValue = Keypair.generate().publicKey;
const connection = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop === "rpcEndpoint") return APP_ENDPOINT;
    if (prop === "getAccountInfo") return async (key: PublicKey, c?: unknown) => {
      if (!key.equals(fakeNonce)) return target.getAccountInfo(key, c as never);
      const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH); data.writeUInt32LE(1, 0); data.writeUInt32LE(1, 4); BUYER.toBuffer().copy(data, 8); fakeNonceValue.toBuffer().copy(data, 40); data.writeBigUInt64LE(BigInt(5000), 72);
      return { data, executable: false, lamports: 1_447_680, owner: SystemProgram.programId, rentEpoch: 0 };
    };
    const v = Reflect.get(target, prop, receiver); return typeof v === "function" ? v.bind(target) : v;
  },
}) as Connection;
const store = new Map([["par.nonce.v1", JSON.stringify({ [`mainnet-beta:${BUYER.toBase58()}`]: fakeNonce.toBase58() })]]);
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
(async () => {
  const title = await readTitle(RPC, TITLE);
  const record = await readRecord(RPC, title.attributes.record);
  const status = await titleStatus(RPC, "mainnet-beta", { address: title.attributes.record, attributes: record.attributes });
  if (!status?.tensor) throw new Error("not listed on mainnet");
  const mint = new PublicKey(record.attributes.mint);
  const decimals = (await getMint(real, mint, "confirmed")).decimals;
  console.log("listing:", { seller: status.tensor.seller, raw: status.tensor.amount.toString(), shown: formatTokenAmount(status.tensor.amount, decimals), recordDecimals: record.attributes.decimals, mintDecimals: decimals, collection: status.collection });
  console.log("buyer", BUYER.toBase58(), "SOL", (await real.getBalance(BUYER)) / 1e9);
  const total = buyerTotal(status.tensor.amount);
  const wrap = process.env.NOWRAP ? BigInt(0) : await wrappedSolShortfall(connection, mint, BUYER, total);
  console.log("buyer pays raw", total.toString(), "=", formatTokenAmount(total, decimals), "SOL; wrap", wrap.toString());
  const tx = buyOnTensorTransaction({ title: new PublicKey(TITLE), mint, seller: new PublicKey(status.tensor.seller), buyer: BUYER, price: status.tensor.amount, collection: status.collection ? new PublicKey(status.collection) : null, wrappedSolShortfall: wrap });
  const prepared = await prepareTransaction(connection, BUYER, tx, []);
  console.log("prepared: tip", prepared.tipLamports, "fee", prepared.feeLamports, "rent", prepared.rentLamports);
  let asked: Transaction | null = null;
  const sign = Object.assign(async (t: Transaction) => { asked = t; throw new Error("User rejected the request. (captured, not signed)"); }, { cluster: "mainnet-beta" as const });
  await sendPrepared(connection, prepared, sign, "x").catch((e) => console.log("sendPrepared stopped:", (e as Error).message));
  const w = asked as unknown as Transaction;
  console.log("wallet bytes:", transactionBytes(w), "/1232; recentBlockhash is nonce value:", w.recentBlockhash === fakeNonceValue.toBase58());
  console.log("instructions:", w.instructions.map((ix) => ix.programId.toBase58().slice(0, 8) + (ix.programId.equals(SystemProgram.programId) ? `[${ix.data.readUInt32LE(0)}]` : "")).join(" "));
  // Same instructions, minus the advance of the (fake) nonce account, with a real mainnet blockhash.
  const body = new Transaction().add(...w.instructions.slice(1));
  body.feePayer = BUYER; body.recentBlockhash = (await real.getLatestBlockhash("confirmed")).blockhash;
  const sim = await real.simulateTransaction(new VersionedTransaction(body.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  console.log("MAINNET simulation err:", JSON.stringify(sim.value.err), "units", sim.value.unitsConsumed);
  console.log((sim.value.logs || []).slice(-8).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
