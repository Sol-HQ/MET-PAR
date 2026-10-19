import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { WSOL } from "./constants";

/**
 * How a buyer pays `need` units of a price token, whatever that token is.
 *
 * - The token program is the mint account's owner (SPL Token or Token-2022), never assumed.
 * - Wrapped SOL is detected only by its exact mint address. Then the buyer's shortfall is wrapped from native SOL in the
 *   same transaction, and a wrapped-SOL account this payment opened is closed again afterwards, so nothing is left behind.
 * - Any other token is paid from the buyer's associated token account. A shortfall there cannot be fixed by the app.
 */
export type TokenPayPlan = {
  mint: PublicKey;
  tokenProgram: PublicKey;
  account: PublicKey;
  /** The buyer's token account existed before this payment. */
  existed: boolean;
  held: bigint;
  need: bigint;
  /** Lamports to wrap. 0 unless the token is wrapped SOL and the account holds less than `need`. */
  wrap: bigint;
  /** Units still missing after any wrap. Above 0 means the payment cannot go through. */
  short: bigint;
  wrappedSol: boolean;
};

export function isWsol(mint: PublicKey | string): boolean {
  return (typeof mint === "string" ? mint : mint.toBase58()) === WSOL;
}

/** The token program that owns this mint. Fails for anything that is not an SPL Token or Token-2022 mint. */
export async function mintTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error("That price token does not exist on this network.");
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
  throw new Error("That price token is not an SPL token.");
}

/** Pure part of the plan, so it can be tested without a network. `held` is the buyer's current balance. */
export function planFromBalance(input: {
  mint: PublicKey;
  tokenProgram: PublicKey;
  owner: PublicKey;
  existed: boolean;
  held: bigint;
  need: bigint;
  lamports?: bigint;
}): TokenPayPlan {
  const wrappedSol = isWsol(input.mint);
  const account = getAssociatedTokenAddressSync(input.mint, input.owner, true, input.tokenProgram);
  const missing = input.need > input.held ? input.need - input.held : BigInt(0);
  let wrap = BigInt(0);
  let short = missing;
  if (wrappedSol && missing > BigInt(0)) {
    const spare = input.lamports ?? missing;
    wrap = spare >= missing ? missing : spare;
    short = missing - wrap;
  }
  return { mint: input.mint, tokenProgram: input.tokenProgram, account, existed: input.existed, held: input.held, need: input.need, wrap, short, wrappedSol };
}

/** Reads the buyer's balance of the price token on this connection's network and plans the payment. */
export async function planTokenPayment(connection: Connection, mint: PublicKey, owner: PublicKey, need: bigint): Promise<TokenPayPlan> {
  const tokenProgram = await mintTokenProgram(connection, mint);
  const account = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const info = await connection.getAccountInfo(account, "confirmed");
  let held = BigInt(0);
  if (info && info.data.length >= 72) held = info.data.readBigUInt64LE(64);
  let lamports: bigint | undefined;
  if (isWsol(mint)) {
    // Keep enough native SOL for fees and the account rent.
    const balance = BigInt(await connection.getBalance(owner, "confirmed"));
    const reserve = BigInt(10_000_000);
    lamports = balance > reserve ? balance - reserve : BigInt(0);
  }
  return planFromBalance({ mint, tokenProgram, owner, existed: Boolean(info), held, need, lamports });
}

/** Instructions around the payment: open the account if needed, wrap SOL, and close a wrapped-SOL account it opened. */
export function paymentInstructions(plan: TokenPayPlan, owner: PublicKey): { before: TransactionInstruction[]; after: TransactionInstruction[] } {
  const before: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(owner, plan.account, owner, plan.mint, plan.tokenProgram),
  ];
  if (plan.wrappedSol && plan.wrap > BigInt(0)) {
    before.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: plan.account, lamports: plan.wrap }),
      createSyncNativeInstruction(plan.account, plan.tokenProgram),
    );
  }
  const after: TransactionInstruction[] = [];
  if (plan.wrappedSol && !plan.existed) {
    after.push(createCloseAccountInstruction(plan.account, owner, owner, [], plan.tokenProgram));
  }
  return { before, after };
}

/** Opens a token account for someone else (seller, treasury, payout wallet) with the mint's own token program. */
export function openTokenAccount(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
    owner,
    mint,
    tokenProgram,
  );
}

/** What a wallet's wrapped-SOL account holds, read on this connection's network. Null when it has none. */
export type WrappedSolHolding = { account: PublicKey; amount: bigint; lamports: bigint; closable: boolean; reason: string };

/**
 * The wrapped-SOL account a Tensor sale pays a seller into is the seller's associated token account for the wrapped
 * SOL mint under SPL Token. Closing it returns every lamport in it (the wrapped amount and its rent) as native SOL to
 * the owner. That is the whole unwrap: one closeAccount, signed by the owner. Nothing else is moved.
 */
export async function readWrappedSol(connection: Connection, owner: PublicKey): Promise<WrappedSolHolding | null> {
  const mint = new PublicKey(WSOL);
  const account = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(account, "confirmed");
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length < 165) return null;
  const data = info.data;
  const amount = data.readBigUInt64LE(64);
  // Account layout: mint 0..32, owner 32..64, amount 64..72, delegate option 72..108, state 108.
  const holder = new PublicKey(data.subarray(32, 64));
  const delegated = data.readUInt32LE(72) === 1;
  const state = data[108];
  let reason = "";
  if (!holder.equals(owner)) reason = "That wrapped-SOL account belongs to another wallet.";
  else if (state !== 1) reason = state === 2 ? "That wrapped-SOL account is frozen." : "That wrapped-SOL account is not open.";
  else if (delegated) reason = "Another program may spend from that wrapped-SOL account. Remove the delegate in your wallet first.";
  return { account, amount, lamports: BigInt(info.lamports), closable: reason === "", reason };
}

/** Unwrap: close the owner's wrapped-SOL account to the owner. The SOL in it, and its rent, come back as native SOL. */
export function unwrapSolInstruction(owner: PublicKey): TransactionInstruction {
  const account = getAssociatedTokenAddressSync(new PublicKey(WSOL), owner, false, TOKEN_PROGRAM_ID);
  return createCloseAccountInstruction(account, owner, owner, [], TOKEN_PROGRAM_ID);
}
