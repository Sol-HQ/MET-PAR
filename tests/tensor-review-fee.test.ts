/**
 * The Tensor review screen's network fee is the fee of the copy the wallet signs. Run: npx tsx --test tests/*.test.ts
 * No network: every Connection here is a stub. Nothing is signed or sent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ComputeBudgetProgram, Keypair, Message, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WSOL } from "../src/lib/constants";
import { JITO_TIP_LAMPORTS, landingCost, prepareTransaction, sendPrepared, walletFeeLamports, type SignTransaction } from "../src/lib/send";
import { buyOnTensorInstruction, buyOnTensorTransaction, buyerTotal, tensorPayoutAccounts, tensorPayoutRent } from "../src/lib/tensor-sale";

const MAINNET = "https://www.meteora.surf/api/rpc/mainnet";
const DEVNET = "https://www.meteora.surf/api/rpc/devnet";
const SIGNATURE_FEE = 5000;
const STAND_IN = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
const BUILTINS = new Set([SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58()]);

/**
 * The runtime's fee for a message with no compute-unit limit instruction: 5,000 lamports per signature, plus the
 * priority price times the default limit (200,000 units per instruction, 3,000 for a builtin, at most 1,400,000).
 */
function modelFee(message: Message): number {
  let limit = 0;
  let microLamports = BigInt(0);
  for (const ix of message.compiledInstructions) {
    const program = message.accountKeys[ix.programIdIndex].toBase58();
    limit += BUILTINS.has(program) ? 3_000 : 200_000;
    if (program === ComputeBudgetProgram.programId.toBase58() && ix.data[0] === 3) {
      microLamports = Buffer.from(ix.data).readBigUInt64LE(1);
    }
  }
  limit = Math.min(limit, 1_400_000);
  const priority = (BigInt(limit) * microLamports + BigInt(999_999)) / BigInt(1_000_000);
  return message.header.numRequiredSignatures * SIGNATURE_FEE + Number(priority);
}

function stubConnection(endpoint: string, nonce?: { pubkey: PublicKey; authority: PublicKey; value: PublicKey }) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const priced: Message[] = [];
  const connection = {
    rpcEndpoint: endpoint,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1_000 }),
    getFeeForMessage: async (message: Message) => {
      priced.push(message);
      return { context: { slot: 1 }, value: modelFee(message) };
    },
    getAccountInfo: async (key: PublicKey) => {
      if (!nonce || !key.equals(nonce.pubkey)) return null;
      const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
      data.writeUInt32LE(1, 0);
      data.writeUInt32LE(1, 4);
      nonce.authority.toBuffer().copy(data, 8);
      nonce.value.toBuffer().copy(data, 40);
      data.writeBigUInt64LE(BigInt(5000), 72);
      return { data, executable: false, lamports: 1_056_640, owner: SystemProgram.programId, rentEpoch: 0 };
    },
    sendRawTransaction: async () => {
      throw new Error("a test never sends");
    },
  } as unknown as Connection;
  return { connection, priced, blockhash };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
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

/** The 0.3 SOL listing shape: buyer with no wrapped-SOL account, so the whole total is wrapped and the account is closed. */
function solBuy(buyer: PublicKey) {
  const price = BigInt(300_000_000);
  return buyOnTensorTransaction({
    title: Keypair.generate().publicKey,
    mint: new PublicKey(WSOL),
    seller: Keypair.generate().publicKey,
    buyer,
    price,
    collection: Keypair.generate().publicKey,
    wrappedSolShortfall: buyerTotal(price),
    tokenProgram: TOKEN_PROGRAM_ID,
    closeWrappedAfter: true,
  });
}

function sameShape(left: Message, right: Message, skipKey?: PublicKey) {
  assert.deepEqual(left.header, right.header);
  assert.equal(left.serialize().length, right.serialize().length, "same packet size");
  assert.equal(left.compiledInstructions.length, right.compiledInstructions.length);
  left.compiledInstructions.forEach((ix, index) => {
    const other = right.compiledInstructions[index];
    assert.ok(left.accountKeys[ix.programIdIndex].equals(right.accountKeys[other.programIdIndex]), `program of instruction ${index}`);
    assert.deepEqual(Buffer.from(ix.data), Buffer.from(other.data), `data of instruction ${index}`);
    // The nonce account is the only key allowed to differ: the wallet's own one versus the estimate's stand-in.
    const keys = (m: Message, i: typeof ix) =>
      i.accountKeyIndexes.map((k) => m.accountKeys[k].toBase58()).map((k) => (k === skipKey?.toBase58() || k === STAND_IN ? "nonce" : k));
    assert.deepEqual(keys(left, ix), keys(right, other), `accounts of instruction ${index}`);
  });
}

test("mainnet Tensor buy: the fee shown is the fee of the copy the wallet signs, not of the bare packet", async () => {
  const buyer = Keypair.generate().publicKey;
  const nonce = { pubkey: Keypair.generate().publicKey, authority: buyer, value: Keypair.generate().publicKey };
  memoryStorage({ "par.nonce.v1": JSON.stringify({ [`mainnet-beta:${buyer.toBase58()}`]: nonce.pubkey.toBase58() }) });
  const { connection, priced } = stubConnection(MAINNET, nonce);
  const prepared = await prepareTransaction(connection, buyer, solBuy(buyer), []);
  assert.equal(prepared.tipLamports, JITO_TIP_LAMPORTS);
  // The old number: the packet before the priority price and the nonce advance. Signature fee only.
  assert.equal(prepared.feeLamports, SIGNATURE_FEE);

  priced.length = 0;
  const walletFee = await walletFeeLamports(connection, prepared);
  assert.equal(priced.length, 1);
  const estimate = priced[0];
  // Nonce advance, priority price, ATA create, wrap transfer, sync, BuyCoreSpl, close, Jito tip.
  // 4 programs at 200,000 units and 4 builtins at 3,000: 812,000 units at 100,000 micro-lamports = 81,200 lamports.
  assert.equal(walletFee, 86_200);

  // The priced message has the same shape as what sendPrepared hands the wallet. Only the nonce account differs.
  const { sign, seen } = capturingSigner("mainnet-beta");
  await assert.rejects(sendPrepared(connection, prepared, sign));
  assert.equal(seen.length, 1);
  const asked = seen[0].compileMessage();
  const advance = seen[0].instructions[0];
  assert.ok(advance.programId.equals(SystemProgram.programId) && advance.data.readUInt32LE(0) === 4);
  assert.equal(seen[0].recentBlockhash, nonce.value.toBase58());
  sameShape(estimate, asked, nonce.pubkey);
  assert.equal(modelFee(asked), walletFee, "the wallet's own message prices the same");

  // Only an explicit fee changes the line. Every other review screen passes nothing and reads as before.
  assert.equal(
    landingCost(prepared),
    "Network fee: 0.000005 SOL (5,000 lamports). Jito tip: 0.0002 SOL (200,000 lamports). The tip sits inside this transaction, so it is paid when the transaction lands.",
  );
  assert.match(landingCost(prepared, walletFee), /^Network fee: 0\.0000862 SOL \(86,200 lamports\)\. Jito tip: 0\.0002 SOL/);
  assert.match(landingCost(prepared, null), /^Network fee: could not be read from the network\. Your wallet shows it before you approve\. Jito tip/);
});

test("devnet: no nonce advance and no tip; the fee still includes the priority price the wallet copy carries", async () => {
  const buyer = Keypair.generate().publicKey;
  memoryStorage();
  const { connection, priced } = stubConnection(DEVNET);
  const prepared = await prepareTransaction(connection, buyer, solBuy(buyer), []);
  assert.equal(prepared.tipLamports, 0);
  priced.length = 0;
  const walletFee = await walletFeeLamports(connection, prepared);
  const { sign, seen } = capturingSigner("devnet");
  await assert.rejects(sendPrepared(connection, prepared, sign));
  assert.equal(seen.length, 1);
  sameShape(priced[0], seen[0].compileMessage());
  // Priority price, ATA, transfer, sync, BuyCoreSpl, close: 4 x 200,000 + 2 x 3,000 = 806,000 units = 80,600 lamports.
  assert.equal(walletFee, SIGNATURE_FEE + 80_600);
});

test("the fee cannot be read: null, never a stand-in number", async () => {
  const buyer = Keypair.generate().publicKey;
  memoryStorage();
  const { connection } = stubConnection(MAINNET);
  const prepared = await prepareTransaction(connection, buyer, solBuy(buyer), []);
  const failing = { ...connection, rpcEndpoint: MAINNET, getFeeForMessage: async () => ({ context: { slot: 1 }, value: null }) } as unknown as Connection;
  assert.equal(await walletFeeLamports(failing, prepared), null);
  const throwing = { ...connection, rpcEndpoint: MAINNET, getFeeForMessage: async () => { throw new Error("rpc down"); } } as unknown as Connection;
  assert.equal(await walletFeeLamports(throwing, prepared), null);
  const unknown = { ...connection, rpcEndpoint: "https://rpc.example.com" } as unknown as Connection;
  assert.equal(await walletFeeLamports(unknown, prepared), null);
});

test("walletFeeLamports leaves the prepared transaction untouched", async () => {
  const buyer = Keypair.generate().publicKey;
  memoryStorage();
  const { connection } = stubConnection(MAINNET);
  const prepared = await prepareTransaction(connection, buyer, solBuy(buyer), []);
  const before = prepared.transaction.serializeMessage();
  const count = prepared.transaction.instructions.length;
  await walletFeeLamports(connection, prepared);
  assert.equal(prepared.transaction.instructions.length, count);
  assert.deepEqual(prepared.transaction.serializeMessage(), before);
});

test("Tensor payout accounts are the ones the buy instruction pays into", () => {
  const title = Keypair.generate().publicKey;
  const seller = Keypair.generate().publicKey;
  const mint = new PublicKey(WSOL);
  const ix = buyOnTensorInstruction({ title, mint, seller, buyer: Keypair.generate().publicKey, price: BigInt(1) });
  const [sellerTokens, feeTokens] = tensorPayoutAccounts({ title, mint, seller });
  assert.ok(ix.keys[8].pubkey.equals(sellerTokens), "seller token account");
  assert.ok(ix.keys[1].pubkey.equals(feeTokens), "fee vault token account");
});

test("Tensor payout rent: only the missing accounts, at the network's rent-exempt minimum for a token account", async () => {
  const title = Keypair.generate().publicKey;
  const seller = Keypair.generate().publicKey;
  const mint = new PublicKey(WSOL);
  const sizes: number[] = [];
  const rentConnection = (present: [boolean, boolean]) =>
    ({
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((_key, index) => (present[index] ? { lamports: 1 } : null)),
      getMinimumBalanceForRentExemption: async (bytes: number) => {
        sizes.push(bytes);
        return 1_488_440;
      },
    }) as unknown as Connection;
  assert.deepEqual(await tensorPayoutRent(rentConnection([false, false]), { title, mint, seller }), { seller: true, feeVault: true, accounts: 2, lamports: 2_976_880 });
  assert.deepEqual(await tensorPayoutRent(rentConnection([true, false]), { title, mint, seller }), { seller: false, feeVault: true, accounts: 1, lamports: 1_488_440 });
  assert.deepEqual(await tensorPayoutRent(rentConnection([true, true]), { title, mint, seller }), { seller: false, feeVault: false, accounts: 0, lamports: 0 });
  assert.deepEqual(sizes, [165, 165]);
  // Token-2022 account size depends on the mint's extensions: not priced, so no number is shown.
  assert.equal(await tensorPayoutRent(rentConnection([false, false]), { title, mint, seller, tokenProgram: TOKEN_2022_PROGRAM_ID }), null);
  const down = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); } } as unknown as Connection;
  assert.equal(await tensorPayoutRent(down, { title, mint, seller }), null);
});
