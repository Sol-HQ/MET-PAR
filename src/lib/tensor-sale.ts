import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { CORE_PROGRAM_ID } from "./record";
import { TENSOR_MARKETPLACE, TENSOR_TAKER_FEE_PERCENT, tensorListAddress } from "./title";

const FEE_PROGRAM = new PublicKey("TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A");
const LIST_CORE = Uint8Array.from([173, 76, 167, 125, 118, 71, 1, 153]);
const BUY_CORE_SPL = Uint8Array.from([234, 28, 37, 122, 114, 239, 233, 208]);
const DELIST_CORE = Uint8Array.from([56, 24, 231, 2, 227, 19, 14, 68]);
const TOKEN_DECIMALS = 6;

const marketplace = new PublicKey(TENSOR_MARKETPLACE);
const core = new PublicKey(CORE_PROGRAM_ID);

function absent() {
  return { pubkey: marketplace, isSigner: false, isWritable: false };
}

export function feeVaultAddress(listState: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), Buffer.from([listState.toBytes()[31]])],
    FEE_PROGRAM,
  )[0];
}

/** What the buyer pays. Tensor adds its fee on top of the creator's price. */
export function buyerTotal(price: bigint): bigint {
  return price + (price * BigInt(TENSOR_TAKER_FEE_PERCENT) + BigInt(99)) / BigInt(100);
}

export function parseTokenAmount(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > TOKEN_DECIMALS) return null;
  const amount = BigInt(whole) * BigInt(10) ** BigInt(TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, "0"));
  return amount > BigInt(0) ? amount : null;
}

export function formatTokenAmount(amount: bigint): string {
  const scale = BigInt(10) ** BigInt(TOKEN_DECIMALS);
  const fraction = (amount % scale).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return `${(amount / scale).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** The creator lists the title through Tensor's program, priced in this token. Tensor holds it while it is listed. */
export function listOnTensorInstruction(input: { title: PublicKey; creator: PublicKey; mint: PublicKey; price: bigint }): TransactionInstruction {
  const data = Buffer.alloc(52);
  data.set(LIST_CORE, 0);
  data.writeBigUInt64LE(input.price, 8);
  data[17] = 1;
  data.set(input.mint.toBytes(), 18);
  return new TransactionInstruction({
    programId: marketplace,
    data,
    keys: [
      { pubkey: input.title, isSigner: false, isWritable: true },
      absent(),
      { pubkey: tensorListAddress(input.title), isSigner: false, isWritable: true },
      { pubkey: input.creator, isSigner: true, isWritable: false },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: marketplace, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.creator, isSigner: true, isWritable: true },
      absent(),
    ],
  });
}

/** Buys a Tensor listing. The creator receives the list price. The buyer pays the Tensor fee on top. */
export function buyOnTensorInstruction(input: {
  title: PublicKey;
  mint: PublicKey;
  seller: PublicKey;
  buyer: PublicKey;
  price: bigint;
}): TransactionInstruction {
  const listState = tensorListAddress(input.title);
  const feeVault = feeVaultAddress(listState);
  const sellerTokens = getAssociatedTokenAddressSync(input.mint, input.seller);
  const buyerTokens = getAssociatedTokenAddressSync(input.mint, input.buyer);
  const feeTokens = getAssociatedTokenAddressSync(input.mint, feeVault, true);
  const data = Buffer.alloc(16);
  data.set(BUY_CORE_SPL, 0);
  data.writeBigUInt64LE(buyerTotal(input.price), 8);
  return new TransactionInstruction({
    programId: marketplace,
    data,
    keys: [
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: feeTokens, isSigner: false, isWritable: true },
      { pubkey: input.buyer, isSigner: false, isWritable: false },
      { pubkey: listState, isSigner: false, isWritable: true },
      { pubkey: input.title, isSigner: false, isWritable: true },
      absent(),
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.seller, isSigner: false, isWritable: true },
      { pubkey: sellerTokens, isSigner: false, isWritable: true },
      { pubkey: input.buyer, isSigner: true, isWritable: true },
      { pubkey: buyerTokens, isSigner: false, isWritable: true },
      absent(),
      absent(),
      absent(),
      absent(),
      { pubkey: input.seller, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: marketplace, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      absent(),
    ],
  });
}

export function buyOnTensorTransaction(input: {
  title: PublicKey;
  mint: PublicKey;
  seller: PublicKey;
  buyer: PublicKey;
  price: bigint;
}): Transaction {
  const buyerTokens = getAssociatedTokenAddressSync(input.mint, input.buyer);
  return new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(input.buyer, buyerTokens, input.buyer, input.mint),
    buyOnTensorInstruction(input),
  );
}

/** The creator takes the listing down. The title returns to the creator's wallet. */
export function delistOnTensorInstruction(input: { title: PublicKey; creator: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: marketplace,
    data: Buffer.from(DELIST_CORE),
    keys: [
      { pubkey: input.title, isSigner: false, isWritable: true },
      absent(),
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: tensorListAddress(input.title), isSigner: false, isWritable: true },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: marketplace, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.creator, isSigner: false, isWritable: true },
    ],
  });
}
