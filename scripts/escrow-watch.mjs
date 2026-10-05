/**
 * PAR escrow watcher.
 *
 * GitHub Actions runs one pass about every 5 minutes (`node scripts/escrow-watch.mjs --once`).
 * The signing key and the record-store key stay in GitHub secrets. They are not in the repository.
 * A pass reads the escrow program, marks graduation when a pool has migrated, and finishes any
 * auction whose clock has ended. A missed pass still finishes the same auctions on the next run.
 * `node scripts/escrow-watch.mjs` without `--once` keeps a local loop for a manual check.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { needsGraduationMark, needsSettle, readListingData } from "./escrow-clock.mjs";

const PROGRAM = new PublicKey("FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF");
const TREASURY = new PublicKey("pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u");
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const LISTING_DISC = Buffer.from([218, 32, 50, 73, 43, 134, 26, 58]);
const MARK = Buffer.from([125, 72, 57, 129, 59, 15, 247, 251]);
const SETTLE = Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]);
const INTERVAL_MS = 15 * 60_000;
const GRADUATION_RETRY_MS = 10 * 60_000;
const LOCK = new URL("../keys/escrow-watch.lock", import.meta.url);
const KEY = new URL("../keys/me.json", import.meta.url);

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const prefix = `${name}=`;
  for (const file of [".env.local", ".env"]) {
    const path = new URL(`../${file}`, import.meta.url);
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .find((item) => item.startsWith(prefix));
    const value = line?.slice(prefix.length).trim();
    if (value) return value;
  }
  return "";
}

function envRpc() {
  return envValue("NEXT_PUBLIC_DEVNET_RPC_URL") || "https://api.devnet.solana.com";
}

function indexDb() {
  const url = envValue("SUPABASE_URL").replace(/\/$/, "");
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? { url, key } : null;
}

function loadPayer() {
  const fromEnv = envValue("WATCHER_KEY");
  const raw = fromEnv || readFileSync(KEY, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function indexRest(path, init = {}) {
  const db = indexDb();
  if (!db) return null;
  const headers = {
    apikey: db.key,
    authorization: `Bearer ${db.key}`,
    "content-type": "application/json",
  };
  if (init.prefer) headers.prefer = init.prefer;
  const response = await fetch(`${db.url}/rest/v1/${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`The record store answered ${response.status}.`);
  return response;
}

async function writeBeat(result) {
  await indexRest("jobs?on_conflict=name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      name: "escrow-watch",
      cluster: "devnet",
      last_at: new Date().toISOString(),
      ok: result.ok,
      note: result.note.slice(0, 180),
      watched: result.watched,
      marked: result.marked,
      settled: result.settled,
      wake_at: null,
    }),
  });
}

async function wakeWaiting() {
  const response = await indexRest("jobs?select=wake_at&name=eq.escrow-watch&limit=1");
  if (!response) return false;
  const rows = await response.json();
  return Boolean(rows[0]?.wake_at);
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
  const bytes = asset instanceof PublicKey ? asset.toBuffer() : asset;
  return PublicKey.findProgramAddressSync([Buffer.from("listing"), bytes], PROGRAM)[0];
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
      const mintKey = new PublicKey(listing.mint);
      const creatorKey = new PublicKey(listing.creator);
      const mintOwner = listing.tokenProgram;
      const open = (holder) =>
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          getAssociatedTokenAddressSync(mintKey, holder, true, mintOwner),
          holder,
          mintKey,
          mintOwner,
        );
      const sig = await send(connection, payer, [open(creatorKey), open(TREASURY), settleInstruction(payer.publicKey, listing)]);
      settled += 1;
      console.log(`finished auction ${sig}`);
    } catch (error) {
      console.log(`finish failed, will try again: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  console.log(`watching ${real.length} listings, marked ${marked}, finished ${settled}`);
  return { watched: real.length, marked, settled };
}

async function runPass(connection, payer, graduationTried) {
  const result = { ok: true, note: "", watched: 0, marked: 0, settled: 0 };
  try {
    const counts = await pass(connection, payer, graduationTried);
    result.watched = counts.watched;
    result.marked = counts.marked;
    result.settled = counts.settled;
  } catch (error) {
    result.ok = false;
    result.note = error instanceof Error ? error.message : "pass failed";
    console.log(`pass failed, will try again: ${result.note}`);
  }
  try {
    await writeBeat(result);
  } catch (error) {
    console.log(`the record of this pass did not save: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return result;
}

async function main() {
  const once = process.argv.includes("--once");
  if (!once) takeLock();
  const payer = loadPayer();
  const connection = new Connection(envRpc(), "confirmed");
  console.log(
    once
      ? `watcher ${payer.publicKey.toBase58()} on the practice network, one pass`
      : `watcher ${payer.publicKey.toBase58()} on the practice network, every ${INTERVAL_MS / 60000} minutes`,
  );
  const graduationTried = new Map();
  if (once) {
    await runPass(connection, payer, graduationTried);
    return;
  }
  for (;;) {
    await runPass(connection, payer, graduationTried);
    const until = Date.now() + INTERVAL_MS;
    while (Date.now() < until) {
      let wake = false;
      try {
        wake = await wakeWaiting();
      } catch {
        wake = false;
      }
      if (wake) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, until - Date.now())));
    }
  }
}

main();
