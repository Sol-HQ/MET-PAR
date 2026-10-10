import {
  ComputeBudgetProgram,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { noteFreshBlockhash } from "./chain-beat";
import { explorerTx, type ClusterName } from "./constants";
import { formatLamports } from "./format";
import { explainTx } from "./tx-error";
import { reportTx, ReportedTxError } from "./tx-notice";

/** One mainnet signature. Above Jito's 1000 lamport minimum, and small enough to show before the wallet opens. */
export const JITO_TIP_LAMPORTS = 200_000;

/** Live list from Jito getTipAccounts. One is picked at random so the tips do not pile onto one account. */
export const JITO_TIP_ACCOUNTS = [
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
] as const;

const TX_BYTES = 1232;

export type PreparedTransaction = {
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
  feeLamports: number;
  /** SOL locked into the new accounts this transaction creates. It is not a fee and it is not spent on the curve. */
  rentLamports: number;
  /** 0 on the practice network, and 0 when the tip would push the transaction past the size limit. */
  tipLamports: number;
  /** Keypairs this page holds. The wallet signs first. These sign the same message afterward. */
  signers: Keypair[];
};

/** The practice network has no Jito block engine. A local RPC does not either. */
export function jitoTipLamports(endpoint: string): number {
  if (/devnet|localhost|127\.0\.0\.1/i.test(endpoint)) return 0;
  return JITO_TIP_LAMPORTS;
}

function transferToTip(programId: PublicKey | undefined, data: Uint8Array, destination: PublicKey | undefined): boolean {
  if (!programId?.equals(SystemProgram.programId) || !destination) return false;
  if (data.length < 12 || data[0] !== 2) return false;
  return new Set<string>(JITO_TIP_ACCOUNTS).has(destination.toBase58());
}

/** True when the signed bytes pay a Jito tip account. Reads both legacy and versioned transactions. */
export function transactionCarriesJitoTip(raw: Uint8Array): boolean {
  try {
    const transaction = Transaction.from(Buffer.from(raw));
    return transaction.instructions.some((instruction) =>
      transferToTip(instruction.programId, instruction.data, instruction.keys[1]?.pubkey),
    );
  } catch {
    // Versioned transactions fail Transaction.from.
  }
  try {
    const transaction = VersionedTransaction.deserialize(raw);
    const keys = transaction.message.getAccountKeys();
    return transaction.message.compiledInstructions.some((instruction) => {
      const program = keys.get(instruction.programIdIndex);
      const destination = keys.get(instruction.accountKeyIndexes[1] ?? -1);
      return transferToTip(program, Uint8Array.from(instruction.data), destination);
    });
  } catch {
    return false;
  }
}

export function landingCost(prepared: PreparedTransaction): string {
  const parts: string[] = [];
  if (prepared.rentLamports > 0) parts.push(`Account rent: ${formatLamports(prepared.rentLamports)}`);
  parts.push(`Network fee: ${formatLamports(prepared.feeLamports)}`);
  if (prepared.tipLamports > 0) {
    parts.push(
      `Jito tip: ${formatLamports(prepared.tipLamports)}. The tip sits inside this transaction, so it is paid when the transaction lands.`,
    );
  }
  return parts.join(". ");
}

export function landingCostMany(prepared: Array<PreparedTransaction | null | undefined>): string {
  const ready = prepared.filter((part): part is PreparedTransaction => Boolean(part));
  const rent = ready.reduce((sum, part) => sum + part.rentLamports, 0);
  const fee = ready.reduce((sum, part) => sum + part.feeLamports, 0);
  const tip = ready.reduce((sum, part) => sum + part.tipLamports, 0);
  const lines: string[] = [];
  if (rent > 0) lines.push(`Account rent: ${formatLamports(rent)}`);
  lines.push(`Network fee: ${formatLamports(fee)}`);
  if (tip > 0) lines.push(`Jito tip: ${formatLamports(tip)}. The tip sits inside the transaction, so it is paid when the transaction lands.`);
  return lines.join(". ");
}

function resign(transaction: Transaction, signers: Keypair[]) {
  transaction.signatures = [];
  if (signers.length > 0) transaction.partialSign(...signers);
}

/** The serialized size, including when web3.js refuses to return a packet over 1232 bytes. */
export function transactionBytes(transaction: Transaction): number | null {
  try {
    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    const match = /Transaction too large: (\d+) > \d+/.exec(message);
    return match ? Number(match[1]) : null;
  }
}

/** Null when the packet is already past the 1232 byte limit. web3.js throws instead of returning the long buffer. */
function packetBytes(transaction: Transaction): number | null {
  const bytes = transactionBytes(transaction);
  return bytes !== null && bytes <= TX_BYTES ? bytes : null;
}

/** SOL this transaction locks into new accounts. A transfer, including a landing tip, is not rent. */
function accountRentLamports(transaction: Transaction): number {
  let rent = 0;
  for (const instruction of transaction.instructions) {
    if (!instruction.programId.equals(SystemProgram.programId) || instruction.data.length < 12) continue;
    const kind = instruction.data.readUInt32LE(0);
    if (kind !== 0 && kind !== 3) continue;
    const lamports = Number(instruction.data.readBigUInt64LE(4));
    if (lamports > 0 && lamports < 100_000_000_000) rent += lamports;
  }
  return rent;
}

export async function prepareTransaction(
  connection: Connection,
  payer: PublicKey,
  transaction: Transaction,
  signers: Keypair[],
  options?: { tip?: boolean; latest?: { blockhash: string; lastValidBlockHeight: number } },
): Promise<PreparedTransaction> {
  transaction.feePayer = payer;
  const latest = options?.latest ?? (await connection.getLatestBlockhash("confirmed"));
  noteFreshBlockhash(latest);
  transaction.recentBlockhash = latest.blockhash;
  let tipLamports = 0;
  if (options?.tip !== false && jitoTipLamports(connection.rpcEndpoint) > 0) {
    const account = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(account),
        lamports: JITO_TIP_LAMPORTS,
      }),
    );
    tipLamports = JITO_TIP_LAMPORTS;
  }
  resign(transaction, signers);
  if (tipLamports > 0) {
    const bytes = packetBytes(transaction);
    if (bytes === null || bytes > TX_BYTES) {
      transaction.instructions.pop();
      tipLamports = 0;
      resign(transaction, signers);
    }
  }
  const bytes = packetBytes(transaction);
  const fee = bytes === null ? null : await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  return {
    transaction,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    feeLamports: fee?.value ?? 0,
    rentLamports: accountRentLamports(transaction),
    tipLamports,
    signers,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** A fresh blockhash on a copy of the reviewed transaction. The copy is what the wallet signs. */
export function transactionForWallet(
  prepared: PreparedTransaction,
  blockhash: string,
  lastValidBlockHeight: number,
): { transaction: Transaction; expectedMessage: Uint8Array } {
  const rebuilt = Transaction.from(prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
  rebuilt.feePayer = prepared.transaction.feePayer;
  rebuilt.recentBlockhash = blockhash;
  rebuilt.lastValidBlockHeight = lastValidBlockHeight;
  rebuilt.signatures = [];
  const transaction = Transaction.from(rebuilt.serialize({ requireAllSignatures: false, verifySignatures: false }));
  transaction.feePayer = rebuilt.feePayer;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  return { transaction, expectedMessage: Uint8Array.from(transaction.serializeMessage()) };
}

/**
 * Rejects a wallet that changed the message. Extra keypairs sign after the wallet, on that same message.
 * Solflare returns a new transaction and does not keep signatures that were attached before it signed.
 */
export function lockSignedTransaction(signed: Transaction, expectedMessage: Uint8Array, signers: Keypair[]): Uint8Array {
  if (!sameBytes(signed.serializeMessage(), expectedMessage)) {
    throw new Error("The wallet changed the transaction. It was not sent.");
  }
  if (signers.length > 0) signed.partialSign(...signers);
  try {
    return signed.serialize();
  } catch {
    throw new Error("The wallet did not sign this transaction. It was not sent.");
  }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  const digits = [0];
  for (let index = zeroes; index < bytes.length; index += 1) {
    let carry = bytes[index];
    for (let place = 0; place < digits.length; place += 1) {
      carry += digits[place] << 8;
      digits[place] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeroes);
  for (let index = digits.length - 1; index >= 0; index -= 1) out += BASE58[digits[index]];
  return out;
}

function payerSignature(raw: Uint8Array): string {
  if (raw[0] < 1 || raw.length < 65) throw new Error("The wallet did not sign this transaction. It was not sent.");
  return encodeBase58(raw.subarray(1, 65));
}

function rawToBase64(raw: Uint8Array): string {
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function cloneTransaction(transaction: Transaction): Transaction {
  // A packet has no blockhash until prepareTransaction stamps the fresh one.
  // Serializing here throws "recentBlockhash required" and the stamp never happens.
  const copy = new Transaction();
  copy.feePayer = transaction.feePayer;
  if (transaction.recentBlockhash) copy.recentBlockhash = transaction.recentBlockhash;
  if (transaction.lastValidBlockHeight) copy.lastValidBlockHeight = transaction.lastValidBlockHeight;
  if (transaction.instructions.length > 0) copy.add(...transaction.instructions);
  return copy;
}

const NONCE_STORE = "par.nonce.v1";
const PRIORITY_MICRO_LAMPORTS = 100_000;

function nonceAdvance(nonce: PublicKey, payer: PublicKey) {
  return SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: payer });
}

/** The packet size after a durable-nonce advance is added. The advance lets the signer read without the signature aging out. */
export function bytesWithDurableNonce(transaction: Transaction, payer: PublicKey): number | null {
  const copy = cloneTransaction(transaction);
  copy.feePayer = payer;
  if (!copy.recentBlockhash) copy.recentBlockhash = "11111111111111111111111111111111";
  copy.instructions.unshift(nonceAdvance(new PublicKey(new Uint8Array(32).fill(8)), payer));
  return transactionBytes(copy);
}

function storedNonce(payer: string): PublicKey | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const map = JSON.parse(localStorage.getItem(NONCE_STORE) || "{}") as Record<string, string>;
    return map[payer] ? new PublicKey(map[payer]) : null;
  } catch {
    return null;
  }
}

function rememberNonce(payer: string, nonce: PublicKey) {
  if (typeof localStorage === "undefined") return;
  try {
    const map = JSON.parse(localStorage.getItem(NONCE_STORE) || "{}") as Record<string, string>;
    map[payer] = nonce.toBase58();
    localStorage.setItem(NONCE_STORE, JSON.stringify(map));
  } catch {
    /* The nonce account still exists. The next visit creates another if this browser forgets it. */
  }
}

async function readNonceValue(connection: Connection, nonce: PublicKey): Promise<string | null> {
  const info = await connection.getAccountInfo(nonce, "confirmed");
  if (!info) return null;
  try {
    return NonceAccount.fromAccountData(info.data).nonce;
  } catch {
    return null;
  }
}

function expiryText(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : "";
  return /block height exceeded|blockhash not found|transaction expired/i.test(message);
}

async function landedState(connection: Connection, signature: string): Promise<"ok" | "err" | "missing"> {
  const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const row = status.value[0];
  if (!row) return "missing";
  if (row.err) return "err";
  if (row.confirmationStatus === "processed" || row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized") {
    return "ok";
  }
  return "missing";
}

/** The same signed bytes can be handed to the network more than once. Only one copy can land. */
async function pushSigned(connection: Connection, raw: Uint8Array, tip: boolean): Promise<void> {
  const rpc = connection
    .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 })
    .then(() => true, () => false);
  const jito = tip ? relayJito(raw).then(() => true, () => false) : Promise.resolve(false);
  const [rpcOk, jitoOk] = await Promise.all([rpc, jito]);
  if (!rpcOk && !jitoOk) throw new Error("The network did not take the transaction.");
}

async function relayJito(raw: Uint8Array): Promise<string> {
  const response = await fetch("/api/jito", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: rawToBase64(raw) }),
  });
  const body = (await response.json().catch(() => null)) as { signature?: string; error?: string } | null;
  if (!response.ok || !body?.signature) throw new Error(body?.error || "Jito did not take the transaction.");
  return body.signature;
}

/** One Jito bundle. Do not also send the parts on ordinary RPC, or they can land one at a time. */
async function relayBundle(raws: Uint8Array[]): Promise<string> {
  const response = await fetch("/api/jito", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: raws.map(rawToBase64) }),
  });
  const body = (await response.json().catch(() => null)) as { bundle?: string; error?: string } | null;
  if (!response.ok || !body?.bundle) throw new Error(body?.error || "Jito did not take the bundle.");
  return body.bundle;
}

/**
 * One shared blockhash. The tip sits on the last packet that can still hold it, so the bundle pays Jito once.
 */
export async function prepareBundle(
  connection: Connection,
  payer: PublicKey,
  parts: Array<{ transaction: Transaction; signers: Keypair[] }>,
): Promise<PreparedTransaction[]> {
  const latest = await connection.getLatestBlockhash("confirmed");
  let tipAt = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const trial = await prepareTransaction(connection, payer, cloneTransaction(parts[index].transaction), parts[index].signers, {
      tip: true,
      latest,
    });
    if (trial.tipLamports > 0) {
      tipAt = index;
      break;
    }
  }
  const prepared: PreparedTransaction[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    prepared.push(
      await prepareTransaction(connection, payer, cloneTransaction(parts[index].transaction), parts[index].signers, {
        tip: index === tipAt,
        latest,
      }),
    );
  }
  return prepared;
}

function clusterOf(endpoint: string): ClusterName {
  return /devnet/i.test(endpoint) ? "devnet" : "mainnet-beta";
}

function reportFailure(connection: Connection, cause: unknown, signature?: string): never {
  const text = explainTx(cause);
  const onChain = Boolean(cause && typeof cause === "object" && "onChain" in cause && (cause as { onChain?: boolean }).onChain);
  const expired = cause instanceof Error && /block height exceeded|blockhash not found|transaction expired/i.test(cause.message);
  reportTx({
    kind: "bad",
    text,
    href: signature && (onChain || expired) ? explorerTx(signature, clusterOf(connection.rpcEndpoint)) : undefined,
  });
  throw new ReportedTxError(text);
}

/** Confirms the signature, then reports that it landed or that the program rejected it. */
export async function finishSignature(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  landed: string,
  resend?: { raw: Uint8Array; tip: boolean } | { bundle: Uint8Array[] },
): Promise<void> {
  let stop = false;
  const repeater = resend
    ? (async () => {
        while (!stop) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (stop) return;
          if ("bundle" in resend) await relayBundle(resend.bundle).catch(() => undefined);
          else await pushSigned(connection, resend.raw, resend.tip).catch(() => undefined);
        }
      })()
    : null;
  try {
    const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (confirmed.value.err) {
      const looked = await connection
        .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
      const failure = new Error("The transaction landed and failed.");
      Object.assign(failure, { logs: looked?.meta?.logMessages ?? [], err: confirmed.value.err, signature, onChain: true });
      throw failure;
    }
    reportTx({ kind: "ok", text: landed, href: explorerTx(signature, clusterOf(connection.rpcEndpoint)) });
  } catch (cause) {
    if (cause instanceof ReportedTxError) throw cause;
    if (expiryText(cause) && (await landedState(connection, signature).catch(() => "missing" as const)) === "ok") {
      reportTx({ kind: "ok", text: landed, href: explorerTx(signature, clusterOf(connection.rpcEndpoint)) });
      return;
    }
    reportFailure(connection, cause, signature);
  } finally {
    stop = true;
    void repeater;
  }
}

/** Sends already-signed bytes to RPC, and to Jito when those bytes carry a tip. */
export async function sendSignedRaw(
  connection: Connection,
  raw: Uint8Array,
  blockhash: string,
  lastValidBlockHeight: number,
  landed: string,
): Promise<string> {
  const signature = payerSignature(raw);
  const tip = transactionCarriesJitoTip(raw);
  await pushSigned(connection, raw, tip);
  await finishSignature(connection, signature, blockhash, lastValidBlockHeight, landed, { raw, tip });
  return signature;
}

async function ensureNonceAccount(
  connection: Connection,
  payer: PublicKey,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
): Promise<PublicKey | null> {
  const saved = storedNonce(payer.toBase58());
  if (saved && (await readNonceValue(connection, saved))) return saved;
  reportTx({
    kind: "ok",
    text: "One short signature creates a durable account. After that, a signature can stay open while you read it. This is not the record.",
  });
  const nonceKey = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const create = new Transaction().add(
    SystemProgram.createNonceAccount({
      fromPubkey: payer,
      noncePubkey: nonceKey.publicKey,
      authorizedPubkey: payer,
      lamports,
    }),
  );
  await sendAging(
    connection,
    await prepareTransaction(connection, payer, create, [nonceKey], { tip: false }),
    signTransaction,
    "A durable signature account is ready. Later signatures can stay open while you read them.",
    null,
  );
  rememberNonce(payer.toBase58(), nonceKey.publicKey);
  return nonceKey.publicKey;
}

function walletCopy(
  prepared: PreparedTransaction,
  blockhash: string,
  lastValidBlockHeight: number,
  payer: PublicKey,
  nonce: { pubkey: PublicKey; value: string } | null,
): { transaction: Transaction; expectedMessage: Uint8Array; durable: boolean } {
  const ready = transactionForWallet(prepared, blockhash, lastValidBlockHeight);
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS });
  if (nonce) {
    const stamped = cloneTransaction(ready.transaction);
    stamped.feePayer = payer;
    stamped.recentBlockhash = nonce.value;
    stamped.lastValidBlockHeight = lastValidBlockHeight;
    stamped.instructions.unshift(nonceAdvance(nonce.pubkey, payer));
    const withFee = cloneTransaction(stamped);
    withFee.instructions.splice(1, 0, price);
    const chosen = (transactionBytes(withFee) ?? 9_999) <= TX_BYTES ? withFee : stamped;
    if ((transactionBytes(chosen) ?? 9_999) <= TX_BYTES) {
      chosen.recentBlockhash = nonce.value;
      chosen.feePayer = payer;
      chosen.lastValidBlockHeight = lastValidBlockHeight;
      chosen.signatures = [];
      const packed = Transaction.from(chosen.serialize({ requireAllSignatures: false, verifySignatures: false }));
      packed.feePayer = payer;
      packed.recentBlockhash = nonce.value;
      packed.lastValidBlockHeight = lastValidBlockHeight;
      return { transaction: packed, expectedMessage: Uint8Array.from(packed.serializeMessage()), durable: true };
    }
  }
  const withFee = cloneTransaction(ready.transaction);
  withFee.feePayer = payer;
  withFee.recentBlockhash = blockhash;
  withFee.lastValidBlockHeight = lastValidBlockHeight;
  withFee.instructions.unshift(price);
  if ((transactionBytes(withFee) ?? 9_999) <= TX_BYTES) {
    withFee.signatures = [];
    const packed = Transaction.from(withFee.serialize({ requireAllSignatures: false, verifySignatures: false }));
    packed.feePayer = payer;
    packed.recentBlockhash = blockhash;
    packed.lastValidBlockHeight = lastValidBlockHeight;
    return { transaction: packed, expectedMessage: Uint8Array.from(packed.serializeMessage()), durable: false };
  }
  return { transaction: ready.transaction, expectedMessage: ready.expectedMessage, durable: false };
}

/** Asks for the signature, sends it, and checks the chain over HTTP. A durable nonce does not age out while the wallet is open. */
async function sendAging(
  connection: Connection,
  prepared: PreparedTransaction,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
  landed: string,
  noncePubkey: PublicKey | null,
): Promise<string> {
  const payer = prepared.transaction.feePayer;
  if (!payer) throw new Error("The transaction has no fee payer.");
  let signature = "";
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await connection.getLatestBlockhash("processed");
      noteFreshBlockhash(latest);
      const nonceValue = noncePubkey ? await readNonceValue(connection, noncePubkey) : null;
      const nonce = noncePubkey && nonceValue ? { pubkey: noncePubkey, value: nonceValue } : null;
      const ready = walletCopy(prepared, latest.blockhash, latest.lastValidBlockHeight, payer, nonce);
      const signed = await signTransaction(ready.transaction);
      const raw = lockSignedTransaction(signed, ready.expectedMessage, prepared.signers);
      signature = payerSignature(raw);
      const tip = transactionCarriesJitoTip(raw);
      await pushSigned(connection, raw, tip);
      try {
        await waitForLanded(connection, signature, latest.lastValidBlockHeight, ready.durable, () => pushSigned(connection, raw, tip));
        reportTx({ kind: "ok", text: landed, href: explorerTx(signature, clusterOf(connection.rpcEndpoint)) });
        return signature;
      } catch (cause) {
        if ((await landedState(connection, signature).catch(() => "missing" as const)) === "ok") {
          reportTx({ kind: "ok", text: landed, href: explorerTx(signature, clusterOf(connection.rpcEndpoint)) });
          return signature;
        }
        const message = cause instanceof Error ? cause.message : "";
        if (/user rejected|rejected the request|user (cancelled|canceled)|approval denied/i.test(message)) throw cause;
        if (!expiryText(cause) || ready.durable || attempt === 2) throw cause;
        reportTx({
          kind: "bad",
          text: "That signature aged out while it was open. Approve the same transaction again. Nothing was charged.",
        });
        signature = "";
      }
    }
    throw new Error("block height exceeded");
  } catch (cause) {
    if (cause instanceof ReportedTxError) throw cause;
    if (signature && (await landedState(connection, signature).catch(() => "missing" as const)) === "ok") {
      reportTx({ kind: "ok", text: landed, href: explorerTx(signature, clusterOf(connection.rpcEndpoint)) });
      return signature;
    }
    reportFailure(connection, cause, signature || undefined);
  }
}

async function waitForLanded(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  durable: boolean,
  resend: () => Promise<void>,
): Promise<void> {
  const started = Date.now();
  const limit = durable ? 180_000 : 90_000;
  while (Date.now() - started < limit) {
    const state = await landedState(connection, signature);
    if (state === "ok") return;
    if (state === "err") {
      const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const failure = new Error("The transaction landed and failed.");
      Object.assign(failure, { err: status.value[0]?.err, signature, onChain: true });
      throw failure;
    }
    if (!durable) {
      const height = await connection.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) {
        if ((await landedState(connection, signature)) === "ok") return;
        throw new Error("block height exceeded");
      }
    }
    await resend().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if ((await landedState(connection, signature)) === "ok") return;
  throw new Error(durable ? "The transaction was sent. It has not reached a block yet." : "block height exceeded");
}

export async function sendPrepared(
  connection: Connection,
  prepared: PreparedTransaction,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
  landed = "Transaction confirmed.",
): Promise<string> {
  const payer = prepared.transaction.feePayer;
  if (!payer) throw new Error("The transaction has no fee payer.");
  const noncePubkey = await ensureNonceAccount(connection, payer, signTransaction);
  return sendAging(connection, prepared, signTransaction, landed, noncePubkey);
}

/**
 * Signs each packet, then hands the set to Jito as one bundle. They land in order or not at all.
 * One leftover packet uses the ordinary send, which still tips Jito when the tip is inside it.
 */
export async function sendPreparedBundle(
  connection: Connection,
  prepared: PreparedTransaction[],
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
  landed: string[],
): Promise<string[]> {
  if (prepared.length === 0) return [];
  if (prepared.length === 1) {
    return [await sendPrepared(connection, prepared[0], signTransaction, landed[0])];
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  noteFreshBlockhash(latest);
  const raws: Uint8Array[] = [];
  const signatures: string[] = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const ready = transactionForWallet(prepared[index], latest.blockhash, latest.lastValidBlockHeight);
      const signed = await signTransaction(ready.transaction);
      const raw = lockSignedTransaction(signed, ready.expectedMessage, prepared[index].signers);
      raws.push(raw);
      signatures.push(payerSignature(raw));
    }
    await relayBundle(raws);
    for (let index = 0; index < signatures.length; index += 1) {
      await finishSignature(connection, signatures[index], latest.blockhash, latest.lastValidBlockHeight, landed[index] || "Transaction confirmed.", {
        bundle: raws,
      });
    }
    return signatures;
  } catch (cause) {
    if (cause instanceof ReportedTxError) throw cause;
    reportFailure(connection, cause, signatures[0] || undefined);
  }
}
