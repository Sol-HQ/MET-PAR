import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { WSOL } from "./constants";
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

/** An edition title sits in its sealed collection. Core needs that collection on every move. */
function collectionKey(collection?: PublicKey) {
  return collection ? { pubkey: collection, isSigner: false, isWritable: false } : absent();
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

export function parseTokenAmount(text: string, decimals = TOKEN_DECIMALS): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 9 ? decimals : TOKEN_DECIMALS;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > places) return null;
  const amount = BigInt(whole) * BigInt(10) ** BigInt(places) + BigInt(fraction.padEnd(places, "0"));
  return amount > BigInt(0) ? amount : null;
}

export function formatTokenAmount(amount: bigint, decimals = TOKEN_DECIMALS): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(amount / scale).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** The creator lists the title through Tensor's program, priced in this token. Tensor holds it while it is listed. */
export function listOnTensorInstruction(input: {
  title: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  price: bigint;
  collection?: PublicKey | null;
}): TransactionInstruction {
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
      collectionKey(input.collection ?? undefined),
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

/**
 * Buys a Tensor listing. The creator receives the list price. The buyer pays the Tensor fee on top.
 * `mint` is the listing's own currency (its list_state), and `tokenProgram` the program that owns that mint: Tensor's
 * buy_core_spl takes SPL Token and Token-2022 currencies (token_interface), and its token accounts follow that program.
 */
export function buyOnTensorInstruction(input: {
  title: PublicKey;
  mint: PublicKey;
  seller: PublicKey;
  buyer: PublicKey;
  price: bigint;
  collection?: PublicKey | null;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const listState = tensorListAddress(input.title);
  const feeVault = feeVaultAddress(listState);
  const sellerTokens = getAssociatedTokenAddressSync(input.mint, input.seller, false, tokenProgram);
  const buyerTokens = getAssociatedTokenAddressSync(input.mint, input.buyer, false, tokenProgram);
  const feeTokens = getAssociatedTokenAddressSync(input.mint, feeVault, true, tokenProgram);
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
      collectionKey(input.collection ?? undefined),
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
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: marketplace, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      absent(),
    ],
  });
}

/**
 * Tensor's buy_core_spl moves SPL tokens out of the buyer's token account. A listing priced in SOL uses the wrapped
 * SOL mint, so a buyer holding only native SOL needs that shortfall wrapped first, in the same transaction.
 * `wrappedSolShortfall` is that amount in lamports. It is 0 for any other mint.
 */
export function buyOnTensorTransaction(input: {
  title: PublicKey;
  mint: PublicKey;
  seller: PublicKey;
  buyer: PublicKey;
  price: bigint;
  collection?: PublicKey | null;
  wrappedSolShortfall?: bigint;
  tokenProgram?: PublicKey;
  /** Close the buyer's wrapped-SOL account after the buy. Only for an account this buy opened. */
  closeWrappedAfter?: boolean;
}): Transaction {
  if (input.price <= BigInt(0)) throw new Error("Listing price must be positive.");
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const total = buyerTotal(input.price);
  const wrap = input.wrappedSolShortfall ?? BigInt(0);
  const isWrappedSol = input.mint.toBase58() === WSOL;
  if (wrap < BigInt(0) || (wrap > BigInt(0) && !isWrappedSol) || wrap > total) {
    throw new Error("Wrapped-SOL funding amount is invalid.");
  }
  if (input.closeWrappedAfter && !isWrappedSol) throw new Error("Only a wrapped-SOL account is closed after a buy.");
  const buyerTokens = getAssociatedTokenAddressSync(input.mint, input.buyer, false, tokenProgram);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(input.buyer, buyerTokens, input.buyer, input.mint, tokenProgram),
  );
  if (wrap > BigInt(0)) {
    transaction.add(
      SystemProgram.transfer({ fromPubkey: input.buyer, toPubkey: buyerTokens, lamports: wrap }),
      createSyncNativeInstruction(buyerTokens, tokenProgram),
    );
  }
  transaction.add(buyOnTensorInstruction({ ...input, tokenProgram }));
  if (input.closeWrappedAfter) {
    transaction.add(createCloseAccountInstruction(buyerTokens, input.buyer, input.buyer, [], tokenProgram));
  }
  return transaction;
}

/**
 * How many lamports the buyer must wrap so the wrapped-SOL account holds the buyer total. Read on the page's own
 * connection, so it is that network's balance. 0 for a listing not priced in wrapped SOL.
 */
export async function wrappedSolShortfall(connection: Connection, mint: PublicKey, buyer: PublicKey, total: bigint): Promise<bigint> {
  if (mint.toBase58() !== WSOL) return BigInt(0);
  const tokens = getAssociatedTokenAddressSync(mint, buyer);
  const info = await connection.getAccountInfo(tokens, "confirmed");
  const held = info ? (await getAccount(connection, tokens, "confirmed")).amount : BigInt(0);
  return total > held ? total - held : BigInt(0);
}

/**
 * The token accounts buy_core_spl pays into: the seller's and Tensor's fee vault's, for the listing's currency. The
 * same addresses buyOnTensorInstruction names. When one does not exist yet, Tensor opens it inside the buy and the
 * buyer pays its rent.
 */
export function tensorPayoutAccounts(input: { title: PublicKey; mint: PublicKey; seller: PublicKey; tokenProgram?: PublicKey }): PublicKey[] {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const feeVault = feeVaultAddress(tensorListAddress(input.title));
  return [
    getAssociatedTokenAddressSync(input.mint, input.seller, false, tokenProgram),
    getAssociatedTokenAddressSync(input.mint, feeVault, true, tokenProgram),
  ];
}

/** SPL Token account size. A Token-2022 account's size depends on the mint's extensions, so it is not priced here. */
const SPL_TOKEN_ACCOUNT_BYTES = 165;

/**
 * Rent the buyer pays for the payout accounts Tensor opens in this buy, read on this connection's network: which of
 * them are missing now, times the rent-exempt minimum for an SPL Token account. Null when it cannot be read, or for a
 * currency that is not an SPL Token mint, so nothing is shown rather than a guess. Display only.
 */
export async function tensorPayoutRent(
  connection: Connection,
  input: { title: PublicKey; mint: PublicKey; seller: PublicKey; tokenProgram?: PublicKey },
): Promise<{ seller: boolean; feeVault: boolean; accounts: number; lamports: number } | null> {
  if (!(input.tokenProgram ?? TOKEN_PROGRAM_ID).equals(TOKEN_PROGRAM_ID)) return null;
  try {
    const infos = await connection.getMultipleAccountsInfo(tensorPayoutAccounts(input), "confirmed");
    if (infos.length !== 2) return null;
    const seller = !infos[0];
    const feeVault = !infos[1];
    const accounts = Number(seller) + Number(feeVault);
    if (accounts === 0) return { seller, feeVault, accounts, lamports: 0 };
    const each = await connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_BYTES, "confirmed");
    return Number.isFinite(each) && each > 0 ? { seller, feeVault, accounts, lamports: accounts * each } : null;
  } catch {
    return null;
  }
}

/** The creator takes the listing down. The title returns to the creator's wallet. */
export function delistOnTensorInstruction(input: {
  title: PublicKey;
  creator: PublicKey;
  collection?: PublicKey | null;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: marketplace,
    data: Buffer.from(DELIST_CORE),
    keys: [
      { pubkey: input.title, isSigner: false, isWritable: true },
      collectionKey(input.collection ?? undefined),
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: tensorListAddress(input.title), isSigner: false, isWritable: true },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: marketplace, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.creator, isSigner: false, isWritable: true },
    ],
  });
}
