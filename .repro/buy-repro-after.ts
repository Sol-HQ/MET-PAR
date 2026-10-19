/** Post-fix: the exact devnet buy the sale page now hands the wallet. Never signs, never sends. Read-only RPC + simulate. */
import { Connection, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { StandardWalletAdapter } from "../node_modules/@solana/wallet-standard-wallet-adapter-react/node_modules/@solana/wallet-standard-wallet-adapter-base/lib/esm/adapter.js";
import { getMint } from "@solana/spl-token";
import { buyOnTensorTransaction, buyerTotal, wrappedSolShortfall, formatTokenAmount } from "@/lib/tensor-sale";
import { bytesWithDurableNonce, prepareTransaction, sendPrepared, transactionBytes } from "@/lib/send";
import { clusterSignTransaction } from "@/lib/cluster-wallet";
import { readTitle, titleStatus } from "@/lib/title";
import { readRecord } from "@/lib/record";

const RPC = process.env.RPC || "https://solana-devnet.api.onfinality.io/public";
const APP_ENDPOINT = "https://www.meteora.surf/api/rpc/devnet";
const TITLE = "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi";
const BUYER = new PublicKey(process.env.BUYER || "mejmPbxqeMgnKqZeF4du3TkBncRAfLmnof7LnGnnpNf");
const real = new Connection(RPC, "confirmed");
const connection = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop === "rpcEndpoint") return APP_ENDPOINT;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Connection;
// A browser that already used PAR on mainnet holds a legacy nonce entry keyed by payer only. It must not touch devnet.
const store = new Map<string, string>([["par.nonce.v1", JSON.stringify({ [BUYER.toBase58()]: Keypair.generate().publicKey.toBase58() })]]);
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
const captured: Array<{ chain: unknown; transaction: Uint8Array }> = [];
const account = { address: BUYER.toBase58(), publicKey: BUYER.toBytes(), chains: ["solana:mainnet", "solana:devnet", "solana:testnet"], features: ["solana:signTransaction"] };
const fakeWallet = {
  version: "1.0.0", name: "Fake Solflare", icon: "data:image/svg+xml;base64,", chains: account.chains, accounts: [account],
  features: {
    "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
    "standard:events": { version: "1.0.0", on: () => () => {} },
    "solana:signTransaction": {
      version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: Array<{ chain?: unknown; transaction: Uint8Array }>) => {
        for (const input of inputs) captured.push({ chain: input.chain, transaction: input.transaction });
        throw new Error("CAPTURED (not signed, not sent)");
      },
    },
  },
};
(async () => {
  const title = await readTitle(RPC, TITLE);
  const record = await readRecord(RPC, title.attributes.record);
  const status = await titleStatus(RPC, "devnet", { address: title.attributes.record, attributes: record.attributes });
  if (!status?.tensor) throw new Error("not listed");
  const mint = new PublicKey(record.attributes.mint);
  const decimals = (await getMint(connection, mint, "confirmed")).decimals;
  console.log("page decimals now from mint:", decimals, "-> listing shown as", formatTokenAmount(status.tensor.amount, decimals), "SOL (raw", status.tensor.amount.toString() + ")");
  const total = buyerTotal(status.tensor.amount);
  const wrap = await wrappedSolShortfall(connection, mint, BUYER, total);
  console.log("buyer total raw", total.toString(), "wrap shortfall", wrap.toString());
  const tx = buyOnTensorTransaction({ title: new PublicKey(TITLE), mint, seller: new PublicKey(status.tensor.seller), buyer: BUYER, price: status.tensor.amount, collection: status.collection ? new PublicKey(status.collection) : null, wrappedSolShortfall: wrap });
  console.log("instructions:", tx.instructions.map((ix) => ix.programId.toBase58()));
  const prepared = await prepareTransaction(connection, BUYER, tx, []);
  console.log("prepared: tip", prepared.tipLamports, "fee", prepared.feeLamports);
  (globalThis as { window?: unknown }).window ??= globalThis; (globalThis as { document?: unknown }).document ??= {};
  const adapter = new StandardWalletAdapter({ wallet: fakeWallet as never });
  await adapter.connect();
  const sign = clusterSignTransaction(adapter as never, "devnet", adapter.signTransaction.bind(adapter) as never)!;
  await sendPrepared(connection, prepared, sign as never, "x").catch((e) => console.log("sendPrepared stopped:", (e as Error).message));
  console.log("wallet requests:", captured.length);
  const got = captured[0];
  const asked = Transaction.from(Buffer.from(got.transaction));
  console.log("chain passed to wallet:", got.chain);
  console.log("recentBlockhash:", asked.recentBlockhash);
  console.log("instructions:", asked.instructions.map((ix) => ix.programId.toBase58() + (ix.programId.equals(SystemProgram.programId) ? ` [sys ix ${ix.data.readUInt32LE(0)}]` : "")));
  console.log("isBlockhashValid on DEVNET:", (await real.isBlockhashValid(asked.recentBlockhash!, { commitment: "confirmed" })).value);
  console.log("bytes:", transactionBytes(asked));
  const sim = await real.simulateTransaction(new VersionedTransaction(asked.compileMessage()), { sigVerify: false });
  console.log("devnet simulation of the exact wallet bytes: err", JSON.stringify(sim.value.err), "units", sim.value.unitsConsumed);
  console.log((sim.value.logs || []).slice(-6).join("\n"));
  // Mainnet size check: same wrapped buy plus a nonce advance and compute price must still fit 1232 bytes.
  const mainnetShape = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...prepared.transaction.instructions);
  mainnetShape.feePayer = BUYER; mainnetShape.recentBlockhash = asked.recentBlockhash;
  console.log("mainnet shape bytes with nonce advance + compute price + tip:", bytesWithDurableNonce(mainnetShape, BUYER), "(limit 1232)");
  console.log("legacy nonce entry untouched:", store.get("par.nonce.v1"));
})().catch((e) => { console.error(e); process.exit(1); });
