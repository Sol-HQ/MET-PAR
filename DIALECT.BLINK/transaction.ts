import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { buyerTotal, buyOnTensorInstruction } from "../src/lib/tensor-sale";
import { WSOL } from "../src/lib/constants";

export type TensorPurchaseInput = {
  title: PublicKey;
  collection: PublicKey | null;
  seller: PublicKey;
  mint: PublicKey;
  buyer: PublicKey;
  price: bigint;
  wrappedSolShortfall?: bigint;
};

/** Build only PAR's existing single-title Tensor Core/SPL purchase transaction. */
export function buildTensorPurchaseTransaction(input: TensorPurchaseInput): Transaction {
  if (input.price <= BigInt(0)) throw new Error("Listing price must be positive.");
  const total = buyerTotal(input.price);
  const isWrappedSol = input.mint.toBase58() === WSOL;
  const wrap = input.wrappedSolShortfall ?? BigInt(0);
  if (wrap < BigInt(0) || (wrap > BigInt(0) && !isWrappedSol) || wrap > total) {
    throw new Error("Wrapped-SOL funding amount is invalid.");
  }

  const buyerAta = getAssociatedTokenAddressSync(input.mint, input.buyer);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(input.buyer, buyerAta, input.buyer, input.mint),
  );
  if (wrap > BigInt(0)) {
    transaction.add(
      SystemProgram.transfer({ fromPubkey: input.buyer, toPubkey: buyerAta, lamports: wrap }),
      createSyncNativeInstruction(buyerAta),
    );
  }
  transaction.add(
    buyOnTensorInstruction({
      title: input.title,
      mint: input.mint,
      seller: input.seller,
      buyer: input.buyer,
      price: input.price,
      collection: input.collection,
    }),
  );
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
