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
  };
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
  const signed = await signTransaction(prepared.transaction);
  const raw = signed.serialize();
  let signature = "";
  if (prepared.tipLamports > 0) {
    signature = await relayJito(raw).catch(() => "");
  }
  if (!signature) {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  }
  await connection.confirmTransaction(
    {
      signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    "confirmed",
  );
  return signature;
}
