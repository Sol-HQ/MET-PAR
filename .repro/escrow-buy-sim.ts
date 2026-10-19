/** Devnet: simulates the exact EscrowTrade buy for the one live escrow listing, with a buyer that holds the price token. Never signed. */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ESCROW_PROGRAM, escrowBuyInstruction, readListing, readPayouts } from "@/lib/title";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
const RPC = process.env.RPC || "https://solana-devnet.api.onfinality.io/public";
const c = new Connection(RPC, "confirmed");
const TITLE = new PublicKey("6BpdLJb1FVwPoS5E8t91CsCZfX5xj5KVBKHh9pQCc8ea");
(async () => {
  const program = new PublicKey(ESCROW_PROGRAM.devnet);
  const listing = (await readListing(c, program, TITLE))!;
  const mintKey = new PublicKey(listing.mint);
  const mintInfo = await c.getAccountInfo(mintKey);
  const owner = mintInfo!.owner;
  const largest = await c.getTokenLargestAccounts(mintKey);
  let buyer: PublicKey | null = null;
  for (const row of largest.value) {
    const acct = await getAccount(c, row.address, "confirmed", owner).catch(() => null);
    if (!acct || acct.amount < listing.price) continue;
    if ((!process.env.ALLOW_CREATOR && acct.owner.toBase58() === listing.creator) || !PublicKey.isOnCurve(acct.owner.toBytes())) continue;
    if ((await c.getBalance(acct.owner)) < 10_000_000) continue;
    buyer = acct.owner; break;
  }
  if (!buyer && process.env.BUYER) buyer = new PublicKey(process.env.BUYER);
  if (!buyer) throw new Error("no funded holder found");
  const payees = await readPayouts(c, program, TITLE);
  const creatorKey = new PublicKey(listing.creator), treasury = new PublicKey(PLATFORM_FEE_CLAIMER);
  const ata = (h: PublicKey) => getAssociatedTokenAddressSync(mintKey, h, true, owner);
  const named = payees.map((r) => ({ wallet: new PublicKey(r.wallet), amount: r.amount }));
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createAssociatedTokenAccountIdempotentInstruction(buyer, ata(buyer), buyer, mintKey, owner),
    createAssociatedTokenAccountIdempotentInstruction(buyer, ata(creatorKey), creatorKey, mintKey, owner),
    createAssociatedTokenAccountIdempotentInstruction(buyer, ata(treasury), treasury, mintKey, owner),
    ...named.map((r) => createAssociatedTokenAccountIdempotentInstruction(buyer!, ata(r.wallet), r.wallet, mintKey, owner)),
    escrowBuyInstruction({ program, buyer, creator: creatorKey, title: TITLE, mint: mintKey, tokenProgram: owner, price: listing.price, payees: named.map((r) => r.wallet) }),
  );
  tx.feePayer = buyer; tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  console.log("listing", { mint: listing.mint, price: listing.price.toString(), sale: listing.sale, payees: payees.length, buyer: buyer.toBase58() });
  const r = await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  console.log("DEVNET escrow buy err:", JSON.stringify(r.value.err), "units", r.value.unitsConsumed);
  console.log((r.value.logs || []).slice(-6).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
