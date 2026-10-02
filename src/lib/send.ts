import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export type PreparedTransaction = {
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
  feeLamports: number;
};

export async function prepareTransaction(
  connection: Connection,
  payer: PublicKey,
  transaction: Transaction,
  signers: Keypair[],
): Promise<PreparedTransaction> {
  transaction.feePayer = payer;
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  if (signers.length > 0) transaction.partialSign(...signers);
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  return {
    transaction,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    feeLamports: fee.value ?? 0,
  };
}

export async function sendPrepared(
  connection: Connection,
  prepared: PreparedTransaction,
  signTransaction: (transaction: Transaction) => Promise<Transaction>,
): Promise<string> {
  const signed = await signTransaction(prepared.transaction);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
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
