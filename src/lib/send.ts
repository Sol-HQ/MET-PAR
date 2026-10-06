import { PublicKey, SystemProgram, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import { formatLamports } from "./format";

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

export function landingCost(prepared: PreparedTransaction): string {
  const fee = `Network fee: ${formatLamports(prepared.feeLamports)}`;
  if (!prepared.tipLamports) return fee;
  return `${fee}. Jito tip: ${formatLamports(prepared.tipLamports)}. The tip sits inside this transaction, so it is paid when the transaction lands.`;
}

export function landingCostMany(parts: Array<PreparedTransaction | null | undefined>): string {
  const ready = parts.filter((part): part is PreparedTransaction => Boolean(part));
  const fee = ready.reduce((sum, part) => sum + part.feeLamports, 0);
  const tip = ready.reduce((sum, part) => sum + part.tipLamports, 0);
  if (!tip) return `Network fee: ${formatLamports(fee)}`;
  return `Network fee: ${formatLamports(fee)}. Jito tip: ${formatLamports(tip)}. The tip sits inside the transaction, so it is paid when the transaction lands.`;
}

function resign(transaction: Transaction, signers: Keypair[]) {
  transaction.signatures = [];
  if (signers.length > 0) transaction.partialSign(...signers);
}

/** Null when the packet is already past the 1232 byte limit. web3.js throws instead of returning the long buffer. */
function packetBytes(transaction: Transaction): number | null {
  try {
    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    return null;
  }
}

export async function prepareTransaction(
  connection: Connection,
  payer: PublicKey,
  transaction: Transaction,
  signers: Keypair[],
): Promise<PreparedTransaction> {
  transaction.feePayer = payer;
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  let tipLamports = 0;
  if (jitoTipLamports(connection.rpcEndpoint) > 0) {
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

async function relayJito(raw: Uint8Array): Promise<string> {
  const response = await fetch("/api/jito", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: btoa(String.fromCharCode(...raw)) }),
  });
  const body = (await response.json().catch(() => null)) as { signature?: string; error?: string } | null;
  if (!response.ok || !body?.signature) throw new Error(body?.error || "Jito did not take the transaction.");
  return body.signature;
}

export async function sendPrepared(
  connection: Connection,
  prepared: PreparedTransaction,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const ready = transactionForWallet(prepared, latest.blockhash, latest.lastValidBlockHeight);
  const signed = await signTransaction(ready.transaction);
  const raw = lockSignedTransaction(signed, ready.expectedMessage, prepared.signers);
  const signature = payerSignature(raw);
  let relayed = "";
  if (prepared.tipLamports > 0) relayed = await relayJito(raw).catch(() => "");
  if (relayed !== signature) {
    const sent = await connection.sendRawTransaction(raw, { skipPreflight: false });
    if (sent !== signature) throw new Error("The network returned a different signature. It was not confirmed.");
  }
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  return signature;
}
