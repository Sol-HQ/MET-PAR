/**
 * PAR escrow watcher.
 *
 * One process on this machine. It is not a Vercel route and not a GitHub Action.
 * About every 15 minutes it reads the escrow program from the chain, marks graduation
 * when a pool has migrated, and finishes any auction whose clock has ended.
 * If it misses a pass, the next pass still finishes the same auctions.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { needsGraduationMark, needsSettle, readListingData } from "./escrow-clock.mjs";

const PROGRAM = new PublicKey("AGcNqaLNfR7h2bdGi39vEMTKNyfX8qLt4mgmbhmtgWvh");
const TREASURY = new PublicKey("pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u");
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const LISTING_DISC = Buffer.from([218, 32, 50, 73, 43, 134, 26, 58]);
const MARK = Buffer.from([125, 72, 57, 129, 59, 15, 247, 251]);
const SETTLE = Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]);
const INTERVAL_MS = 15 * 60_000;
const GRADUATION_RETRY_MS = 10 * 60_000;
const LOCK = new URL("../keys/escrow-watch.lock", import.meta.url);
const KEY = new URL("../keys/me.json", import.meta.url);

function envRpc() {
  for (const name of [".env.local", ".env"]) {
    const path = new URL(`../${name}`, import.meta.url);
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .find((item) => item.startsWith("NEXT_PUBLIC_DEVNET_RPC_URL="));
    const value = line?.slice("NEXT_PUBLIC_DEVNET_RPC_URL=".length).trim();
    if (value) return value;
  }
  return "https://api.devnet.solana.com";
}

function takeLock() {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    try {
      process.kill(pid, 0);
      console.log("A watcher is already running.");
      process.exit(0);
    } catch {
      unlinkSync(LOCK);
    }
  }
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => {
    try {
      if (existsSync(LOCK) && readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
    } catch {
      /* the next start clears a stale lock */
    }
  });
}

function listingAddress(asset) {
  return PublicKey.findProgramAddressSync([Buffer.from("listing"), asset], PROGRAM)[0];
}

async function send(connection, payer, instructions) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

function markInstruction(asset, pool) {
  return new TransactionInstruction({
    programId: PROGRAM,
    data: MARK,
    keys: [
      { pubkey: listingAddress(asset), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool), isSigner: false, isWritable: false },
    ],
  });
}

function settleInstruction(payer, listing) {
  const asset = new PublicKey(listing.asset);
  const mint = new PublicKey(listing.mint);
  const creator = new PublicKey(listing.creator);
  const winner = new PublicKey(listing.highBidder);
  const listingKey = listingAddress(asset);
  const mintOwner = listing.tokenProgram;
  const ata = (owner) => getAssociatedTokenAddressSync(mint, owner, true, mintOwner);
  return new TransactionInstruction({
    programId: PROGRAM,
    data: SETTLE,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: listingKey, isSigner: false, isWritable: true },
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: winner, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: ata(listingKey), isSigner: false, isWritable: true },
      { pubkey: ata(creator), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: false },
      { pubkey: ata(TREASURY), isSigner: false, isWritable: true },
      { pubkey: mintOwner, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

async function pass(connection, payer, graduationTried) {
  const fetched = await connection.getProgramAccounts(PROGRAM, { commitment: "confirmed" });
  const now = Math.floor(Date.now() / 1000);
  let settled = 0;
  let marked = 0;
  const real = [];
  for (const account of fetched) {
    if (!account.account.data.subarray(0, 8).equals(LISTING_DISC)) continue;
    const listing = readListingData(account.account.data);
    if (listing) real.push(listing);
  }
  for (const listing of real) {
    if (needsGraduationMark(listing)) {
      const id = Buffer.from(listing.asset).toString("hex");
      const last = graduationTried.get(id) ?? 0;
      if (now * 1000 - last < GRADUATION_RETRY_MS) continue;
      graduationTried.set(id, Date.now());
      try {
        const sig = await send(connection, payer, [markInstruction(listing.asset, listing.pool)]);
        marked += 1;
        console.log(`marked graduation ${sig}`);
      } catch {
        /* the pool has not migrated yet, or it was already marked */
      }
      continue;
    }
    if (!needsSettle(listing, now)) continue;
    const mintInfo = await connection.getAccountInfo(new PublicKey(listing.mint), "confirmed");
    if (!mintInfo) continue;
    listing.tokenProgram = mintInfo.owner;
    try {
      const sig = await send(connection, payer, [settleInstruction(payer.publicKey, listing)]);
      settled += 1;
      console.log(`finished auction ${sig}`);
    } catch (error) {
      console.log(`finish failed, will try again: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  console.log(`watching ${real.length} listings, marked ${marked}, finished ${settled}`);
}

async function main() {
  takeLock();
  const secret = Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const connection = new Connection(envRpc(), "confirmed");
  console.log(`watcher ${payer.publicKey.toBase58()} on the practice network, every ${INTERVAL_MS / 60000} minutes`);
  const graduationTried = new Map();
  for (;;) {
    try {
      await pass(connection, payer, graduationTried);
    } catch (error) {
      console.log(`pass failed, will try again: ${error instanceof Error ? error.message : "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main();
