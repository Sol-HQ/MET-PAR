import { PublicKey, SystemProgram, Transaction, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
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
  return Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** The same signed bytes can be handed to the network more than once. Only one copy can land. */
async function pushSigned(connection: Connection, raw: Uint8Array, tip: boolean): Promise<void> {
  const sends: Promise<unknown>[] = [connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })];
  if (tip) sends.push(relayJito(raw));
  await Promise.all(sends.map((send) => send.catch(() => undefined)));
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
          else await pushSigned(connection, resend.raw, resend.tip);
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

export async function sendPrepared(
  connection: Connection,
  prepared: PreparedTransaction,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
  landed = "Transaction confirmed.",
): Promise<string> {
  let signature = "";
  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    const ready = transactionForWallet(prepared, latest.blockhash, latest.lastValidBlockHeight);
    const signed = await signTransaction(ready.transaction);
    const raw = lockSignedTransaction(signed, ready.expectedMessage, prepared.signers);
    signature = payerSignature(raw);
    const simulation = await connection.simulateTransaction(signed);
    if (simulation.value.err) {
      const errText = JSON.stringify(simulation.value.err);
      const failure = new Error(/BlockhashNotFound|blockhash/i.test(errText) ? "blockhash not found" : "The transaction was not sent.");
      Object.assign(failure, { logs: simulation.value.logs ?? [], err: simulation.value.err });
      throw failure;
    }
    const tip = prepared.tipLamports > 0;
    await pushSigned(connection, raw, tip);
    await finishSignature(connection, signature, latest.blockhash, latest.lastValidBlockHeight, landed, { raw, tip });
    return signature;
  } catch (cause) {
    if (cause instanceof ReportedTxError) throw cause;
    reportFailure(connection, cause, signature || undefined);
  }
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
