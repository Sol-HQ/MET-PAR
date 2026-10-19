/**
 * Tensor end to end, read-only. Every step is built with the app's own builders (src/lib/tensor-sale.ts,
 * src/lib/token-pay.ts) and run through simulateTransaction with sigVerify off. Nothing is signed or sent.
 * Several signers in one simulated transaction (list then buy) stand in for steps that would be separate.
 */
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buyOnTensorTransaction, buyerTotal, delistOnTensorInstruction, feeVaultAddress, listOnTensorInstruction } from "@/lib/tensor-sale";
import { planFromBalance } from "@/lib/token-pay";
import { readTensorListing, tensorListAddress } from "@/lib/title";
import { readPayToken } from "@/lib/coin-read";
import { USDC_MAINNET, WSOL } from "@/lib/constants";

const MAIN = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const DEV = process.env.DEVNET_RPC || "https://solana-devnet.api.onfinality.io/public";
const wsol = new PublicKey(WSOL);

function amountOf(data: string[] | undefined | null): bigint | null {
  if (!data) return null;
  const bytes = Buffer.from(data[0], "base64");
  return bytes.length >= 72 ? bytes.readBigUInt64LE(64) : null;
}
function alive(a: { lamports: number } | null | undefined): string {
  return a && a.lamports > 0 ? `open (${a.lamports} lamports)` : "closed";
}
function ownerOfCore(data: string[] | undefined | null): string | null {
  if (!data) return null;
  return new PublicKey(Buffer.from(data[0], "base64").subarray(1, 33)).toBase58();
}

async function sim(c: Connection, label: string, payer: PublicKey, ixs: TransactionInstruction[], watch: PublicKey[]) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  const r = await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: watch.map((k) => k.toBase58()) },
  });
  console.log(`\n== ${label}\nerr: ${JSON.stringify(r.value.err)} units: ${r.value.unitsConsumed}`);
  if (r.value.err) console.log((r.value.logs || []).slice(-8).join("\n"));
  return r.value;
}

async function _findWsolWhale(c: Connection, min: bigint): Promise<PublicKey | null> {
  const largest = await c.getTokenLargestAccounts(wsol, "confirmed");
  for (const row of largest.value.slice(0, 20)) {
    const info = await c.getAccountInfo(row.address, "confirmed");
    if (!info) continue;
    const owner = new PublicKey(info.data.subarray(32, 64));
    if (!PublicKey.isOnCurve(owner.toBytes())) continue;
    if (!getAssociatedTokenAddressSync(wsol, owner).equals(row.address)) continue;
    if (BigInt(row.amount) < min) continue;
    const sol = await c.getBalance(owner, "confirmed");
    if (sol > 50_000_000) return owner;
  }
  return null;
}

async function mainnet() {
  const c = new Connection(MAIN, "confirmed");
  const title = new PublicKey("FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL");
  const collection = new PublicKey("DeLYS76csbh6GcMb4Bcad58bxbMM1mdoTZFpivHMaPoZ");
  const listing = await readTensorListing(c, title);
  if (!listing) throw new Error("The mainnet listing is gone.");
  const seller = new PublicKey(listing.seller);
  const currency = new PublicKey(listing.currency!);
  const pay = await readPayToken(c, currency.toBase58());
  const total = buyerTotal(listing.amount);
  console.log("MAINNET listing", { address: listing.address, seller: listing.seller, currency: listing.currency, raw: listing.amount.toString(), pay, buyerTotal: total.toString(), fee: (total - listing.amount).toString() });
  const listState = tensorListAddress(title);
  const feeVault = feeVaultAddress(listState);
  const watch = [title, getAssociatedTokenAddressSync(currency, seller), getAssociatedTokenAddressSync(currency, feeVault, true)];
  const sellerBefore = amountOf((await c.getAccountInfo(watch[1]))?.data ? [(await c.getAccountInfo(watch[1]))!.data.toString("base64")] : null) ?? BigInt(0);
  const vaultBefore = amountOf((await c.getAccountInfo(watch[2]))?.data ? [(await c.getAccountInfo(watch[2]))!.data.toString("base64")] : null) ?? BigInt(0);

  const sellerExisted = Boolean(await c.getAccountInfo(watch[1]));
  const vaultExisted = Boolean(await c.getAccountInfo(watch[2]));
  const buyer = new PublicKey(process.env.BUYER || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  const buyerWsol = getAssociatedTokenAddressSync(wsol, buyer);
  const existing = await c.getAccountInfo(buyerWsol, "confirmed");
  console.log("buyer", buyer.toBase58(), "SOL", (await c.getBalance(buyer)) / 1e9, "WSOL account exists:", Boolean(existing));

  // 1. 0 WSOL: a fresh wallet with no wrapped-SOL account, funded with 1 SOL by a whale in the same simulation.
  const { Keypair } = await import("@solana/web3.js");
  const whale = new PublicKey(process.env.WHALE || "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
  const fresh = Keypair.generate().publicKey;
  const freshWsol = getAssociatedTokenAddressSync(wsol, fresh);
  const zero = planFromBalance({ mint: wsol, tokenProgram: TOKEN_PROGRAM_ID, owner: fresh, existed: false, held: BigInt(0), need: total });
  const tx0 = buyOnTensorTransaction({ title, mint: currency, seller, buyer: fresh, price: listing.amount, collection, wrappedSolShortfall: zero.wrap, tokenProgram: zero.tokenProgram, closeWrappedAfter: !zero.existed });
  const r0 = await sim(c, `fresh wallet, 0 WSOL, no WSOL account (wrap ${zero.wrap}, close after: ${!zero.existed})`, whale, [SystemProgram.transfer({ fromPubkey: whale, toPubkey: fresh, lamports: 1_000_000_000 }), ...tx0.instructions], [...watch, freshWsol, fresh]);
  if (!r0.err) {
    const a = r0.accounts!;
    console.log("title owner after:", ownerOfCore(a[0]?.data), "(buyer:", fresh.toBase58() + ")");
    console.log("seller received:", (amountOf(a[1]?.data)! - sellerBefore).toString(), "of list price", listing.amount.toString());
    console.log("fee vault received:", (amountOf(a[2]?.data)! - vaultBefore).toString(), "(app shows", (total - listing.amount).toString() + ")");
    console.log("buyer WSOL account after:", alive(a[3]), "buyer SOL left:", a[4]?.lamports, "; 1 SOL - total =", 1_000_000_000 - Number(total), "; seller WSOL account existed before:", sellerExisted, "; fee vault WSOL account existed before:", vaultExisted);
  }

  // 2. Partial WSOL: the buyer already holds 0.1 SOL wrapped (set up first in the same simulation), then the app wraps the rest.
  const held = BigInt(100_000_000);
  const setup = [
    createAssociatedTokenAccountIdempotentInstruction(buyer, buyerWsol, buyer, wsol),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: buyerWsol, lamports: held }),
    createSyncNativeInstruction(buyerWsol),
  ];
  const partial = planFromBalance({ mint: wsol, tokenProgram: TOKEN_PROGRAM_ID, owner: buyer, existed: true, held, need: total });
  const tx1 = buyOnTensorTransaction({ title, mint: currency, seller, buyer, price: listing.amount, collection, wrappedSolShortfall: partial.wrap, tokenProgram: partial.tokenProgram });
  const r1 = await sim(c, `buy with 0.1 WSOL held (wrap ${partial.wrap}, account kept)`, buyer, [...setup, ...tx1.instructions], [...watch, buyerWsol]);
  if (!r1.err) console.log("buyer WSOL left:", amountOf(r1.accounts![3]?.data)?.toString(), "title owner:", ownerOfCore(r1.accounts![0]?.data));

  // 3. Plenty of WSOL: a real wallet that holds far more wrapped SOL than the total. Nothing is wrapped.
  const whaleWsol = getAssociatedTokenAddressSync(wsol, whale);
  const whaleHeld = (await c.getAccountInfo(whaleWsol))!.data.readBigUInt64LE(64);
  const plenty = planFromBalance({ mint: wsol, tokenProgram: TOKEN_PROGRAM_ID, owner: whale, existed: true, held: whaleHeld, need: total });
  const tx2 = buyOnTensorTransaction({ title, mint: currency, seller, buyer: whale, price: listing.amount, collection, wrappedSolShortfall: plenty.wrap, tokenProgram: plenty.tokenProgram });
  const r2 = await sim(c, `buy by ${whale.toBase58()} holding ${whaleHeld} WSOL (wrap ${plenty.wrap}, ${tx2.instructions.length} instructions)`, whale, tx2.instructions, [...watch, whaleWsol]);
  if (!r2.err) console.log("whale WSOL spent:", (whaleHeld - amountOf(r2.accounts![3]?.data)!).toString(), "= total", total.toString());

  // 4. Delist by the seller: the title returns to the seller.
  const r3 = await sim(c, "delist by the seller", seller, [delistOnTensorInstruction({ title, creator: seller, collection })], [title, listState]);
  if (!r3.err) console.log("title owner after delist:", ownerOfCore(r3.accounts![0]?.data), "list state after:", alive(r3.accounts![1]));

  // 5. Double listing while listed.
  await sim(c, "list again while listed (double listing)", seller, [listOnTensorInstruction({ title, creator: seller, mint: wsol, price: listing.amount, collection })], [title]);

  // 6. Change price = delist and list at the new price (Tensor's edit is not used by the app), here in USDC, then a USDC buyer.
  const usdc = new PublicKey(USDC_MAINNET);
  const usdcLargest = await c.getTokenLargestAccounts(usdc, "confirmed").catch(() => ({ value: [] as { address: PublicKey; amount: string }[] }));
  let usdcBuyer: PublicKey | null = process.env.USDC_BUYER ? new PublicKey(process.env.USDC_BUYER) : null;
  for (const row of usdcBuyer ? [] : usdcLargest.value.slice(0, 20)) {
    const info = await c.getAccountInfo(row.address);
    if (!info) continue;
    const owner = new PublicKey(info.data.subarray(32, 64));
    if (PublicKey.isOnCurve(owner.toBytes()) && getAssociatedTokenAddressSync(usdc, owner).equals(row.address) && (await c.getBalance(owner)) > 50_000_000) {
      usdcBuyer = owner;
      break;
    }
  }
  const usdcPrice = BigInt(1_000_000);
  const relist = [
    delistOnTensorInstruction({ title, creator: seller, collection }),
    listOnTensorInstruction({ title, creator: seller, mint: usdc, price: usdcPrice, collection }),
  ];
  const r4 = await sim(c, "change price: delist then list at 1 USDC", seller, relist, [title, listState]);
  if (!r4.err) {
    const state = Buffer.from(r4.accounts![1]!.data[0], "base64");
    console.log("list state after relist owner of title:", ownerOfCore(r4.accounts![0]?.data), "list_state bytes", state.length);
  }
  if (usdcBuyer) {
    const usdcBuy = buyOnTensorTransaction({ title, mint: usdc, seller, buyer: usdcBuyer, price: usdcPrice, collection, tokenProgram: TOKEN_PROGRAM_ID });
    const sellerUsdc = getAssociatedTokenAddressSync(usdc, seller);
    const r5 = await sim(c, `relist in USDC then buy by ${usdcBuyer.toBase58()} (Core asset, non-SOL currency)`, usdcBuyer, [...relist, ...usdcBuy.instructions], [title, sellerUsdc]);
    if (!r5.err) console.log("title owner:", ownerOfCore(r5.accounts![0]?.data), "seller USDC account:", amountOf(r5.accounts![1]?.data)?.toString());
  } else console.log("\n== no USDC buyer found by the public RPC; set USDC_BUYER to run the USDC buy");
}

async function devnet() {
  const c = new Connection(DEV, "confirmed");
  const title = new PublicKey("4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi");
  const collection = new PublicKey("7WCvRVVEFaa2fPsdCe1HgYw1yT5diUnuuxHcL5s3yxvc");
  const creator = new PublicKey("RPS3j1r791zUDTwDwv3E1TRAK1H5qVYi1aHLd3gnBmY");
  const buyer = new PublicKey(process.env.DEV_BUYER || "mejmPbxqeMgnKqZeF4du3TkBncRAfLmnof7LnGnnpNf");
  const price = BigInt(200_000_000);
  const total = buyerTotal(price);
  const listState = tensorListAddress(title);
  const buyerWsol = getAssociatedTokenAddressSync(wsol, buyer);
  const existing = await c.getAccountInfo(buyerWsol, "confirmed");
  console.log("\nDEVNET buyer", buyer.toBase58(), "SOL", (await c.getBalance(buyer)) / 1e9, "WSOL account exists:", Boolean(existing));
  const list = listOnTensorInstruction({ title, creator, mint: wsol, price, collection });
  const plan = planFromBalance({ mint: wsol, tokenProgram: TOKEN_PROGRAM_ID, owner: buyer, existed: Boolean(existing), held: existing ? existing.data.readBigUInt64LE(64) : BigInt(0), need: total });
  const buy = buyOnTensorTransaction({ title, mint: wsol, seller: creator, buyer, price, collection, wrappedSolShortfall: plan.wrap, tokenProgram: plan.tokenProgram, closeWrappedAfter: !plan.existed });
  const sellerWsol = getAssociatedTokenAddressSync(wsol, creator);
  const r = await sim(c, `list 0.2 SOL then buy (wrap ${plan.wrap})`, buyer, [list, ...buy.instructions], [title, sellerWsol, buyerWsol, listState]);
  if (!r.err) console.log("title owner:", ownerOfCore(r.accounts![0]?.data), "seller WSOL:", amountOf(r.accounts![1]?.data)?.toString(), "buyer WSOL account:", alive(r.accounts![2]), "list state:", alive(r.accounts![3]));
  const d = await sim(c, "list then delist", creator, [list, delistOnTensorInstruction({ title, creator, collection })], [title, listState]);
  if (!d.err) console.log("title owner after delist:", ownerOfCore(d.accounts![0]?.data));
  await sim(c, "list twice (double listing)", creator, [list, listOnTensorInstruction({ title, creator, mint: wsol, price, collection })], [title]);
}

(async () => {
  if (!process.env.SKIP_MAINNET) await mainnet();
  if (!process.env.SKIP_DEVNET) await devnet();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
