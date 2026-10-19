/**
 * Reproduces, without signing or sending, the exact transaction the devnet sale page hands to the wallet
 * when a second wallet presses "Buy" on the no-coin RWA title PZ-4CO (devnet).
 * Read-only RPC calls only (getAccountInfo, getLatestBlockhash, getFeeForMessage, simulateTransaction with sigVerify=false).
 */
import { Connection, Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { StandardWalletAdapter } from "../node_modules/@solana/wallet-standard-wallet-adapter-react/node_modules/@solana/wallet-standard-wallet-adapter-base/lib/esm/adapter.js";
import { getChainForEndpoint } from "@solana/wallet-standard-util";
import { buyOnTensorTransaction, buyerTotal } from "@/lib/tensor-sale";
import { prepareTransaction, sendPrepared } from "@/lib/send";
import { readTitle, titleStatus } from "@/lib/title";
import { readRecord } from "@/lib/record";

const RPC = process.env.RPC || "https://solana-devnet.api.onfinality.io/public";
// In the browser the app's endpoint is `${origin}/api/rpc/devnet` (src/lib/constants.ts:102).
const APP_ENDPOINT = "https://www.meteora.surf/api/rpc/devnet";
const TITLE = "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi";
const BUYER = new PublicKey(process.env.BUYER || "mejmPbxqeMgnKqZeF4du3TkBncRAfLmnof7LnGnnpNf"); // any funded devnet wallet; never signs

const real = new Connection(RPC, "confirmed");
const fakeNonce = Keypair.generate().publicKey;
const fakeNonceValue = Keypair.generate().publicKey; // a nonce value is a hash, not a recent blockhash on any cluster
function nonceData(): Buffer {
  const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
  data.writeUInt32LE(1, 0); // version current
  data.writeUInt32LE(1, 4); // initialized
  BUYER.toBuffer().copy(data, 8);
  fakeNonceValue.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(5000n, 72);
  return data;
}
// The connection the page would hold, endpoint string and all, backed by a real devnet RPC for reads.
const connection = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop === "rpcEndpoint") return APP_ENDPOINT;
    if (prop === "getAccountInfo") {
      return async (key: PublicKey, c?: unknown) =>
        key.equals(fakeNonce) ? { data: nonceData(), executable: false, lamports: 1_447_680, owner: SystemProgram.programId, rentEpoch: 0 } : target.getAccountInfo(key, c as never);
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Connection;

// A wallet that has bought before on this browser has a nonce stored (src/lib/send.ts:273-308).
const store = new Map<string, string>([["par.nonce.v1", JSON.stringify({ [BUYER.toBase58()]: fakeNonce.toBase58() })]]);
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };

// A Wallet Standard wallet (how Solflare's extension is seen by @solana/wallet-adapter-react) that records what it is asked to sign.
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
  console.log("Listing on devnet:", { seller: status.tensor.seller, rawAmount: status.tensor.amount.toString(), currency: status.tensor.currency, collection: status.collection });
  console.log("record 'decimals' attribute:", JSON.stringify(record.attributes.decimals), "-> page falls back to 6 (src/app/t/[title]/page.tsx:301-302). WSOL has 9.");
  console.log("Shown as", Number(status.tensor.amount) / 1e6, "SOL; actually", Number(status.tensor.amount) / 1e9, "SOL. Buyer total raw:", buyerTotal(status.tensor.amount).toString());

  // Exactly what SaleTrade.buy() builds (src/components/SaleTrade.tsx:143-153).
  const tx = buyOnTensorTransaction({
    title: new PublicKey(TITLE), mint: new PublicKey(record.attributes.mint), seller: new PublicKey(status.tensor.seller),
    buyer: BUYER, price: status.tensor.amount, collection: status.collection ? new PublicKey(status.collection) : null,
  });
  console.log("SaleTrade instructions:", tx.instructions.map((ix) => ix.programId.toBase58()));
  const prepared = await prepareTransaction(connection, BUYER, tx, []);
  console.log("prepared: tip", prepared.tipLamports, "fee", prepared.feeLamports, "blockhash", prepared.blockhash);

  (globalThis as { window?: unknown }).window ??= globalThis; (globalThis as { document?: unknown }).document ??= {};
  const adapter = new StandardWalletAdapter({ wallet: fakeWallet as never });
  await adapter.connect();
  console.log("wallet-adapter would use chain for sendTransaction only:", getChainForEndpoint(APP_ENDPOINT));
  await sendPrepared(connection, prepared, (t) => adapter.signTransaction(t as Transaction) as Promise<Transaction>, "x").catch((e) => console.log("sendPrepared stopped:", (e as Error).message));
  const got = captured[0];
  if (!got) throw new Error("nothing captured");
  const signedTx = Transaction.from(Buffer.from(got.transaction));
  console.log("\n=== What the wallet received ===");
  console.log("chain passed to wallet:", got.chain === undefined ? "undefined (wallet must guess)" : got.chain);
  console.log("recentBlockhash:", signedTx.recentBlockhash, signedTx.recentBlockhash === fakeNonceValue.toBase58() ? "(the durable NONCE value, not a devnet blockhash)" : "");
  console.log("instructions:", signedTx.instructions.map((ix) => ix.programId.toBase58() + (ix.programId.equals(SystemProgram.programId) ? ` [sys ix ${ix.data.readUInt32LE(0)}]` : "")));
  const valid = await real.isBlockhashValid(signedTx.recentBlockhash!, { commitment: "processed" }).catch(() => null);
  console.log("isBlockhashValid on DEVNET for that recentBlockhash:", valid?.value);

  // Simulate the same purchase with a plain devnet blockhash (no nonce), no signature check. Read-only.
  const plain = new Transaction().add(...tx.instructions);
  plain.feePayer = BUYER;
  plain.recentBlockhash = (await real.getLatestBlockhash("confirmed")).blockhash;
  const sim = await real.simulateTransaction(new VersionedTransaction(plain.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  console.log("\n=== Devnet simulation of the SaleTrade buy (no wrap) ===");
  console.log("err:", JSON.stringify(sim.value.err));
  console.log((sim.value.logs || []).slice(-12).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
