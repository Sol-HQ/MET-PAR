/**
 * Devnet stays devnet, mainnet stays mainnet. Run: npx tsx --test tests/*.test.ts
 * No network: every Connection here is a stub that records what the send path asks of it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { clusterOfEndpoint, requireClusterOfEndpoint, walletChain, WSOL } from "../src/lib/constants";
import {
  JITO_TIP_LAMPORTS,
  jitoTipLamports,
  prepareTransaction,
  sendPrepared,
  usesDurableNonce,
  walletBlockhashCommitment,
  type SignTransaction,
} from "../src/lib/send";
import { clusterSignAllTransactions, clusterSignTransaction, turboSignTransaction } from "../src/lib/cluster-wallet";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buyOnTensorTransaction, wrappedSolShortfall } from "../src/lib/tensor-sale";
import { POST as jitoPost } from "../src/app/api/jito/route";
import { POST as payRoutePost } from "../src/app/api/pay-route/route";

const DEVNET = "https://www.meteora.surf/api/rpc/devnet";
const MAINNET = "https://www.meteora.surf/api/rpc/mainnet";
const TENSOR_MARKETPLACE = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp";
const NONCE_ADVANCE = 4;

test("cluster is read from the PAR proxy path and from named hosts, never guessed", () => {
  assert.equal(clusterOfEndpoint(DEVNET), "devnet");
  assert.equal(clusterOfEndpoint(MAINNET), "mainnet-beta");
  assert.equal(clusterOfEndpoint("http://localhost:3000/api/rpc/devnet"), "devnet");
  assert.equal(clusterOfEndpoint("https://api.devnet.solana.com"), "devnet");
  assert.equal(clusterOfEndpoint("https://devnet.helius-rpc.com/?api-key=x"), "devnet");
  assert.equal(clusterOfEndpoint("https://api.mainnet-beta.solana.com"), "mainnet-beta");
  assert.equal(clusterOfEndpoint("https://mainnet.helius-rpc.com/?api-key=x"), "mainnet-beta");
  // The old regex read anything without "devnet" as mainnet. Unknown now stays unknown.
  assert.equal(clusterOfEndpoint("https://rpc.example.com"), null);
  assert.equal(clusterOfEndpoint("https://mydevnetnode.example.com"), null);
  assert.throws(() => requireClusterOfEndpoint("https://rpc.example.com"), /cannot tell which Solana network/);
  assert.equal(walletChain("devnet"), "solana:devnet");
  assert.equal(walletChain("mainnet-beta"), "solana:mainnet");
});

test("Jito tips only on a connection PAR names as mainnet", () => {
  assert.equal(jitoTipLamports(MAINNET), JITO_TIP_LAMPORTS);
  assert.equal(jitoTipLamports("https://api.mainnet-beta.solana.com"), JITO_TIP_LAMPORTS);
  assert.equal(jitoTipLamports(DEVNET), 0);
  assert.equal(jitoTipLamports("http://localhost:3000/api/rpc/mainnet"), 0);
  assert.equal(jitoTipLamports("https://rpc.example.com"), 0);
});

test("durable nonce and blockhash commitment: mainnet unchanged, devnet plain recent blockhash", () => {
  assert.equal(usesDurableNonce("mainnet-beta"), true);
  assert.equal(walletBlockhashCommitment("mainnet-beta"), "processed");
  assert.equal(usesDurableNonce("devnet"), false);
  assert.equal(walletBlockhashCommitment("devnet"), "confirmed");
});

/** A fake Wallet Standard adapter that records each solana:signTransaction input and then rejects. */
function fakeStandardAdapter(owner: PublicKey, chains = ["solana:mainnet", "solana:devnet"]) {
  const inputs: Array<{ chain?: string; transaction: Uint8Array }> = [];
  const adapter = {
    standard: true,
    publicKey: owner,
    wallet: {
      accounts: [{ address: owner.toBase58(), chains }],
      features: {
        "solana:signTransaction": {
          signTransaction: async (...items: Array<{ chain?: string; transaction: Uint8Array }>) => {
            inputs.push(...items);
            throw { code: 4001, message: "User rejected the request." };
          },
        },
      },
    },
  };
  return { adapter: adapter as never, inputs };
}

function oneTransfer(payer: PublicKey) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.feePayer = payer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

test("devnet signature requests name solana:devnet; mainnet uses the adapter's own signTransaction unchanged", async () => {
  const owner = Keypair.generate().publicKey;
  const { adapter, inputs } = fakeStandardAdapter(owner);
  let adapterCalls = 0;
  const original = async <T,>(tx: T) => {
    adapterCalls += 1;
    return tx;
  };
  const devnet = clusterSignTransaction(adapter, "devnet", original)!;
  assert.equal(devnet.cluster, "devnet");
  await assert.rejects(devnet(oneTransfer(owner)), /User rejected the request/);
  assert.equal(inputs.at(-1)?.chain, "solana:devnet");
  assert.equal(adapterCalls, 0);

  const many = clusterSignAllTransactions(adapter, "devnet", async (txs) => txs)!;
  await assert.rejects(many([oneTransfer(owner), oneTransfer(owner)]));
  assert.deepEqual(inputs.slice(-2).map((input) => input.chain), ["solana:devnet", "solana:devnet"]);

  const mainnet = clusterSignTransaction(adapter, "mainnet-beta", original)!;
  assert.equal(mainnet.cluster, "mainnet-beta");
  const before = inputs.length;
  await mainnet(oneTransfer(owner));
  assert.equal(adapterCalls, 1);
  assert.equal(inputs.length, before);
});

test("a wallet account that does not offer devnet is refused before it is asked", async () => {
  const owner = Keypair.generate().publicKey;
  const { adapter, inputs } = fakeStandardAdapter(owner, ["solana:mainnet"]);
  const devnet = clusterSignTransaction(adapter, "devnet", async (tx) => tx)!;
  await assert.rejects(devnet(oneTransfer(owner)), /does not offer Solana Devnet/);
  assert.equal(inputs.length, 0);
});

test("a non-standard adapter (Solflare SDK adapter built with the network) keeps its own function, tagged", async () => {
  const owner = Keypair.generate().publicKey;
  let called = 0;
  const sign = clusterSignTransaction({ publicKey: owner } as never, "devnet", async (tx) => {
    called += 1;
    return tx;
  })!;
  await sign(oneTransfer(owner));
  assert.equal(called, 1);
  assert.equal(sign.cluster, "devnet");
});

test("Turbo payment signing is refused on devnet and passed through on mainnet", async () => {
  const fn = async () => "signed";
  assert.equal(turboSignTransaction("mainnet-beta", fn), fn);
  await assert.rejects((turboSignTransaction("devnet", fn) as () => Promise<string>)(), /paid on Solana mainnet/);
});

/** Records every RPC call the send path makes. The wallet in these tests always rejects, so nothing is sent. */
function stubConnection(endpoint: string, nonceAccount?: { pubkey: PublicKey; authority: PublicKey; value: PublicKey }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    rpcEndpoint: endpoint,
    commitment: "confirmed",
    async getLatestBlockhash(...args: unknown[]) {
      calls.push({ method: "getLatestBlockhash", args });
      return { blockhash, lastValidBlockHeight: 1000 };
    },
    async getAccountInfo(key: PublicKey, ...args: unknown[]) {
      calls.push({ method: "getAccountInfo", args: [key.toBase58(), ...args] });
      if (nonceAccount && key.equals(nonceAccount.pubkey)) {
        const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
        data.writeUInt32LE(1, 0);
        data.writeUInt32LE(1, 4);
        nonceAccount.authority.toBuffer().copy(data, 8);
        nonceAccount.value.toBuffer().copy(data, 40);
        data.writeBigUInt64LE(BigInt(5000), 72);
        return { data, owner: SystemProgram.programId, lamports: 1_500_000, executable: false };
      }
      return null;
    },
    async getMinimumBalanceForRentExemption(...args: unknown[]) {
      calls.push({ method: "getMinimumBalanceForRentExemption", args });
      return 1_447_680;
    },
    async getFeeForMessage() {
      return { value: 5000 };
    },
    async simulateTransaction() {
      return { value: { err: null, unitsConsumed: 1000, logs: [] } };
    },
    async getSignatureStatuses() {
      return { value: [null] };
    },
    async sendRawTransaction() {
      calls.push({ method: "sendRawTransaction", args: [] });
      throw new Error("stub never sends");
    },
  };
  return { connection: connection as unknown as Connection, calls, blockhash };
}

function capturingSigner(cluster: "devnet" | "mainnet-beta") {
  const seen: Transaction[] = [];
  const sign = Object.assign(
    async (tx: Transaction): Promise<Transaction> => {
      seen.push(tx);
      throw new Error("User rejected the request.");
    },
    { cluster },
  ) as SignTransaction;
  return { sign, seen };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

test("devnet send: no nonce account, a real devnet blockhash at confirmed, no Jito tip", async () => {
  const payer = Keypair.generate().publicKey;
  const store = memoryStorage({ "par.nonce.v1": JSON.stringify({ [payer.toBase58()]: Keypair.generate().publicKey.toBase58() }) });
  const { connection, calls, blockhash } = stubConnection(DEVNET);
  const prepared = await prepareTransaction(connection, payer, oneTransfer(payer), [], {});
  assert.equal(prepared.tipLamports, 0);
  calls.length = 0; // prepareTransaction's own simulation blockhash is not what the wallet sees.
  const { sign, seen } = capturingSigner("devnet");
  await assert.rejects(sendPrepared(connection, prepared, sign));
  assert.equal(seen.length, 1, "exactly one wallet request: the transaction itself, no nonce-account request");
  const asked = seen[0];
  assert.equal(asked.recentBlockhash, blockhash);
  assert.ok(!asked.instructions.some((ix) => ix.programId.equals(SystemProgram.programId) && ix.data.readUInt32LE(0) === NONCE_ADVANCE));
  assert.deepEqual(calls.filter((call) => call.method === "getLatestBlockhash").map((call) => call.args[0]), ["confirmed"]);
  assert.ok(!calls.some((call) => call.method === "getMinimumBalanceForRentExemption"), "no nonce account is created on devnet");
  assert.ok(!calls.some((call) => call.method === "sendRawTransaction"));
  // A legacy mainnet nonce entry (keyed by payer only) is never used for devnet.
  assert.ok(!calls.some((call) => call.method === "getAccountInfo"));
  assert.equal(store.size, 1);
});

test("mainnet send keeps the durable nonce, reads the legacy nonce entry, and asks at processed", async () => {
  const payer = Keypair.generate().publicKey;
  const noncePubkey = Keypair.generate().publicKey;
  const nonceValue = Keypair.generate().publicKey;
  memoryStorage({ "par.nonce.v1": JSON.stringify({ [payer.toBase58()]: noncePubkey.toBase58() }) });
  const { connection, calls } = stubConnection(MAINNET, { pubkey: noncePubkey, authority: payer, value: nonceValue });
  const prepared = await prepareTransaction(connection, payer, oneTransfer(payer), [], {});
  assert.equal(prepared.tipLamports, JITO_TIP_LAMPORTS);
  calls.length = 0;
  const { sign, seen } = capturingSigner("mainnet-beta");
  await assert.rejects(sendPrepared(connection, prepared, sign));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].recentBlockhash, nonceValue.toBase58());
  const advance = seen[0].instructions[0];
  assert.ok(advance.programId.equals(SystemProgram.programId) && advance.data.readUInt32LE(0) === NONCE_ADVANCE);
  assert.ok(advance.keys[0].pubkey.equals(noncePubkey));
  assert.deepEqual(calls.filter((call) => call.method === "getLatestBlockhash").map((call) => call.args[0]), ["processed"]);
});

test("a page connection and a wallet request on different networks are refused before anything is signed", async () => {
  const payer = Keypair.generate().publicKey;
  memoryStorage();
  const { connection } = stubConnection(DEVNET);
  const prepared = await prepareTransaction(connection, payer, oneTransfer(payer), [], {});
  const { sign, seen } = capturingSigner("mainnet-beta");
  await assert.rejects(sendPrepared(connection, prepared, sign), /connected to Devnet but the wallet request is for Mainnet/);
  assert.equal(seen.length, 0);
  const unknown = stubConnection("https://rpc.example.com").connection;
  await assert.rejects(sendPrepared(unknown, prepared, capturingSigner("devnet").sign), /cannot tell which Solana network/);
});

test("SOL-priced Tensor buy wraps exactly the WSOL shortfall; other mints never wrap", async () => {
  const buyer = Keypair.generate().publicKey;
  const base = {
    title: Keypair.generate().publicKey,
    seller: Keypair.generate().publicKey,
    buyer,
    collection: Keypair.generate().publicKey,
    price: BigInt(200_000_000),
  };
  const wrapped = buyOnTensorTransaction({ ...base, mint: new PublicKey(WSOL), wrappedSolShortfall: BigInt(202_000_000) });
  assert.deepEqual(
    wrapped.instructions.map((ix) => ix.programId.toBase58()),
    [
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TENSOR_MARKETPLACE,
    ],
  );
  const plain = buyOnTensorTransaction({ ...base, mint: new PublicKey(WSOL) });
  assert.equal(plain.instructions.length, 2);
  assert.throws(() => buyOnTensorTransaction({ ...base, mint: Keypair.generate().publicKey, wrappedSolShortfall: BigInt(1) }));

  const token = { getAccountInfo: async () => null } as unknown as Connection;
  assert.equal(await wrappedSolShortfall(token, Keypair.generate().publicKey, buyer, BigInt(1)), BigInt(0));
});

test("mainnet-only server routes refuse a request that names devnet", async () => {
  const post = (body: unknown) =>
    new Request("https://www.meteora.surf/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const jito = await jitoPost(post({ cluster: "devnet", transaction: "AA==" }));
  assert.equal(jito.status, 400);
  const pay = await payRoutePost(post({ cluster: "devnet", inputMint: WSOL, outputMint: WSOL, amount: "1", slippageBps: 50 }));
  assert.equal(pay.status, 400);
});
