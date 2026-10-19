import { PublicKey, Transaction } from "@solana/web3.js";
import { buyOnTensorTransaction } from "../src/lib/tensor-sale";

export type TensorPurchaseInput = {
  title: PublicKey;
  collection: PublicKey | null;
  seller: PublicKey;
  mint: PublicKey;
  buyer: PublicKey;
  price: bigint;
  wrappedSolShortfall?: bigint;
};

/** Build only PAR's existing single-title Tensor Core/SPL purchase transaction. The sale page builds the same one. */
export function buildTensorPurchaseTransaction(input: TensorPurchaseInput): Transaction {
  const transaction = buyOnTensorTransaction(input);
  transaction.feePayer = input.buyer;
  return transaction;
}

/** Reject any accidental server, seller, or cosigner signature requirement before returning a Blink transaction. */
export function serializeBuyerOnlyTransaction(transaction: Transaction, buyer: PublicKey): string {
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 1 || message.accountKeys[0]?.toBase58() !== buyer.toBase58()) {
    throw new Error("The purchase transaction requires an unexpected signer.");
  }
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (serialized.length > 1232) throw new Error("This purchase is too large for a standard Solana transaction.");
  return serialized.toString("base64");
}
