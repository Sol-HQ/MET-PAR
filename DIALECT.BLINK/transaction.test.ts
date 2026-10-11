import assert from "node:assert/strict";
import test from "node:test";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { WSOL } from "../src/lib/constants";
import { TENSOR_MARKETPLACE } from "../src/lib/title";
import { buildTensorPurchaseTransaction, serializeBuyerOnlyTransaction } from "./transaction";

const title = Keypair.generate().publicKey;
const seller = Keypair.generate().publicKey;
const collection = Keypair.generate().publicKey;
const price = BigInt(300_000_000);

function build(mint: PublicKey, buyer = Keypair.generate().publicKey, wrappedSolShortfall = BigInt(0)) {
  return buildTensorPurchaseTransaction({ title, seller, mint, buyer, collection, price, wrappedSolShortfall });
}

test("SPL purchase has one buyer signer and only expected ATA and Tensor instructions", () => {
  const buyer = Keypair.generate().publicKey;
  const transaction = build(Keypair.generate().publicKey, buyer);
  transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const encoded = serializeBuyerOnlyTransaction(transaction, buyer);
  const decoded = Transaction.from(Buffer.from(encoded, "base64"));
  assert.equal(decoded.feePayer?.toBase58(), buyer.toBase58());
  assert.equal(decoded.instructions.length, 2);
  assert.equal(decoded.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(decoded.instructions[1].programId.toBase58(), TENSOR_MARKETPLACE);
  assert.equal(decoded.compileMessage().header.numRequiredSignatures, 1);
});

test("SOL-priced purchase wraps only the specified WSOL shortfall", () => {
  const buyer = Keypair.generate().publicKey;
  const shortfall = BigInt(125_000_000);
  const transaction = build(new PublicKey(WSOL), buyer, shortfall);
  transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const decoded = Transaction.from(Buffer.from(serializeBuyerOnlyTransaction(transaction, buyer), "base64"));
  assert.equal(decoded.instructions.length, 4);
  assert.equal(decoded.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(decoded.instructions[1].programId.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(decoded.instructions[2].programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(decoded.instructions[3].programId.toBase58(), TENSOR_MARKETPLACE);
  assert.equal(decoded.compileMessage().header.numRequiredSignatures, 1);
});

test("existing WSOL balance requires no wrap instructions", () => {
  const transaction = build(new PublicKey(WSOL));
  assert.equal(transaction.instructions.length, 2);
});

test("invalid or excessive WSOL funding is rejected", () => {
  assert.throws(() => build(Keypair.generate().publicKey, Keypair.generate().publicKey, BigInt(1)));
  assert.throws(() => build(new PublicKey(WSOL), Keypair.generate().publicKey, BigInt(999_000_000)));
});

test("extra required signers and oversized transactions are rejected", () => {
  const buyer = Keypair.generate().publicKey;
  const transaction = build(Keypair.generate().publicKey, buyer);
  transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
  transaction.add({
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }],
    programId: SystemProgram.programId,
    data: Buffer.alloc(0),
  });
  assert.throws(() => serializeBuyerOnlyTransaction(transaction, buyer), /unexpected signer/);
  const oversized = new Transaction();
  oversized.feePayer = buyer;
  oversized.recentBlockhash = Keypair.generate().publicKey.toBase58();
  oversized.add({
    keys: Array.from({ length: 24 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })),
    programId: SystemProgram.programId,
    data: Buffer.alloc(1100),
  });
  assert.throws(() => serializeBuyerOnlyTransaction(oversized, buyer), /too large/);
});
