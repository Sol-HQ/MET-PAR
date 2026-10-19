/**
 * par-escrow program tests. They load the built program (escrow/target/deploy/par_escrow.so, built with
 * `--features short-days`, so one day is one second) into LiteSVM at its real address, next to the real Metaplex Core
 * program and copies of real devnet accounts (fixtures/, from `npm run fixtures`). The app's own instruction builders
 * (src/lib/title.ts, src/lib/token-pay.ts) build every instruction. Nothing is sent to any network.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  addCollectionPluginV1,
  addPluginV1,
  burnV1,
  create,
  createPlugin,
  deserializeAssetV1,
  deserializeCollectionV1,
  mplCore,
  PluginType,
  removePluginV1,
  transferV1,
  updateCollection,
  updatePluginV1,
  updateV2,
} from "@metaplex-foundation/mpl-core";
import { createNoopSigner, createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import {
  ESCROW_PROGRAM,
  coreCollectionOf,
  editionCollectionInstructions,
  escrowBidInstruction,
  escrowBuyInstruction,
  escrowDepositInstruction,
  escrowDepositOpenInstruction,
  escrowReclaimInstruction,
  escrowSettleInstruction,
  escrowOffered,
  escrowDepositAllowed,
  listingAddress,
  markGraduatedInstruction,
  sealedAuthority,
  titleInstructions,
} from "../../src/lib/title";
import { paymentInstructions, planFromBalance, openTokenAccount } from "../../src/lib/token-pay";
import { WSOL } from "../../src/lib/constants";
import { recordInstruction } from "../../src/lib/record";

const here = dirname(fileURLToPath(import.meta.url));
const PROGRAM = new PublicKey(ESCROW_PROGRAM.devnet);
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const TREASURY = new PublicKey("pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u");
const NATIVE = new PublicKey(WSOL);
const ENDPOINT = "http://127.0.0.1:8899";
const NEW_SO = join(here, "..", "target", "deploy", "par_escrow.so");
const OLD_SO = join(here, "fixtures", "par_escrow_deployed.so");
const CORE_SO = join(here, "fixtures", "mpl_core.so");
const FIXTURES = JSON.parse(readFileSync(join(here, "fixtures", "devnet-accounts.json"), "utf8"));
const SOL = BigInt(1_000_000_000);

type Svm = LiteSVM;

function boot(programPath = NEW_SO): Svm {
  for (const path of [programPath, CORE_SO]) {
    if (!existsSync(path)) throw new Error(`${path} is missing. Build the program and run npm run fixtures first.`);
  }
  const svm = new LiteSVM();
  svm.addProgramFromFile(CORE, CORE_SO);
  svm.addProgramFromFile(PROGRAM, programPath);
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(1_800_000_000);
  svm.setClock(clock);
  if (!svm.getAccount(NATIVE)) {
    // Wrapped SOL mint: decimals 9, initialized, no authority.
    const data = Buffer.alloc(MINT_SIZE);
    data[44] = 9;
    data[45] = 1;
    svm.setAccount(NATIVE, { lamports: 1_461_600, data, owner: TOKEN_PROGRAM_ID, executable: false });
  }
  return svm;
}

function warp(svm: Svm, seconds: number) {
  const clock = svm.getClock();
  clock.unixTimestamp = clock.unixTimestamp + BigInt(seconds);
  clock.slot = clock.slot + BigInt(Math.max(1, seconds * 2));
  svm.setClock(clock);
  svm.expireBlockhash();
}

let nonce = 0;
function send(svm: Svm, payer: Keypair, instructions: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction();
  // A distinct no-op so identical transactions do not collide.
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
  nonce += 1;
  tx.add(...instructions);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  const unique = new Map<string, Keypair>();
  for (const signer of [payer, ...signers]) unique.set(signer.publicKey.toBase58(), signer);
  tx.sign(...unique.values());
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (result instanceof FailedTransactionMetadata) {
    const logs = result.meta().logs();
    const code = logs.map((line) => /Error Code: (\w+)/.exec(line)?.[1]).find(Boolean);
    return { ok: false as const, code: code ?? String(result.err()), logs };
  }
  return { ok: true as const, code: "", logs: result.logs() };
}

function expectOk(result: ReturnType<typeof send>, what: string) {
  assert.equal(result.ok, true, `${what} failed: ${result.code}\n${result.logs.slice(-12).join("\n")}`);
}

function expectError(result: ReturnType<typeof send>, code: string, what: string) {
  assert.equal(result.ok, false, `${what} should have failed with ${code}`);
  assert.equal(result.code, code, `${what}: expected ${code}, got ${result.code}\n${result.logs.slice(-8).join("\n")}`);
}

function wallet(svm: Svm, sol = 100): Keypair {
  const key = Keypair.generate();
  svm.airdrop(key.publicKey, BigInt(sol) * SOL);
  return key;
}

function newMint(svm: Svm, payer: Keypair, decimals: number, program = TOKEN_PROGRAM_ID): PublicKey {
  const mint = Keypair.generate();
  expectOk(
    send(
      svm,
      payer,
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: 1_461_600,
          space: MINT_SIZE,
          programId: program,
        }),
        createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null, program),
      ],
      [mint],
    ),
    "create mint",
  );
  return mint.publicKey;
}

function fund(svm: Svm, authority: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint, program = TOKEN_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  expectOk(
    send(svm, authority, [
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, owner, mint, program),
      createMintToInstruction(mint, ata, authority.publicKey, amount, [], program),
    ]),
    "fund",
  );
  return ata;
}

function balance(svm: Svm, mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID): bigint {
  const account = svm.getAccount(getAssociatedTokenAddressSync(mint, owner, true, program));
  if (!account) return BigInt(0);
  return Buffer.from(account.data).readBigUInt64LE(64);
}

function coreOwner(svm: Svm, asset: PublicKey): string {
  const account = svm.getAccount(asset);
  assert.ok(account, "asset missing");
  return new PublicKey(Buffer.from(account.data).subarray(1, 33)).toBase58();
}

function umiFor(creator: PublicKey) {
  const umi = createUmi(ENDPOINT).use(mplCore());
  const signer = createNoopSigner(umiKey(creator.toBase58()));
  umi.use(signerIdentity(signer));
  return { umi, signer };
}

/** The record: a Core asset the creator owns. The escrow only checks that Core owns it. */
function record(svm: Svm, creator: Keypair): PublicKey {
  const asset = Keypair.generate();
  const { umi, signer } = umiFor(creator.publicKey);
  const ix = create(umi, {
    asset: createSignerFromKeypair(umi, fromWeb3JsKeypair(asset)),
    name: "Record",
    uri: "https://example.com/r.json",
    owner: signer.publicKey,
    payer: signer,
  })
    .getInstructions()
    .map(toWeb3JsInstruction);
  expectOk(send(svm, creator, ix, [asset]), "record");
  return asset.publicKey;
}

/** The app's own mint path (RecordCreate): edition 1 of a new collection, sealed in the same transaction. */
function sealedTitle(svm: Svm, creator: Keypair, opts: { seal?: boolean; extraPlugins?: unknown[] } = {}) {
  const collection = Keypair.generate();
  const asset = Keypair.generate();
  expectOk(
    send(
      svm,
      creator,
      editionCollectionInstructions({ endpoint: ENDPOINT, collection, creator: creator.publicKey, name: "Title", uri: "https://example.com/c.json" }),
      [collection],
    ),
    "collection",
  );
  if (opts.seal === false || opts.extraPlugins) {
    const { umi, signer } = umiFor(creator.publicKey);
    let builder = create(umi, {
      asset: createSignerFromKeypair(umi, fromWeb3JsKeypair(asset)),
      collection: { publicKey: umiKey(collection.publicKey.toBase58()) },
      name: "Title",
      uri: "https://example.com/t.json",
      owner: signer.publicKey,
      payer: signer,
      authority: signer,
      plugins: [
        { type: "Attributes", attributeList: [{ key: "kind", value: "PAR title v1" }], authority: { type: "None" } },
        { type: "Edition", number: 1, authority: { type: "None" } },
        ...((opts.extraPlugins ?? []) as never[]),
      ],
    });
    if (opts.seal !== false) {
      builder = builder.add(
        updateCollection(umi, {
          collection: umiKey(collection.publicKey.toBase58()),
          payer: signer,
          authority: signer,
          newUpdateAuthority: umiKey(sealedAuthority(collection.publicKey).toBase58()),
        }),
      );
    }
    expectOk(send(svm, creator, builder.getInstructions().map(toWeb3JsInstruction), [asset]), "title");
  } else {
    expectOk(
      send(
        svm,
        creator,
        titleInstructions({
          endpoint: ENDPOINT,
          asset,
          collection: collection.publicKey,
          creator: creator.publicKey,
          name: "Title",
          uri: "https://example.com/t.json",
          attributes: [{ key: "kind", value: "PAR title v1" }],
        }),
        [asset],
      ),
      "title",
    );
  }
  const read = svm.getAccount(asset.publicKey)!;
  assert.equal(coreCollectionOf(Buffer.from(read.data))?.toBase58(), collection.publicKey.toBase58());
  return { title: asset.publicKey, collection: collection.publicKey };
}

/** The older escrow-rail title: standalone, update authority None. */
function standaloneTitle(svm: Svm, creator: Keypair): PublicKey {
  const asset = Keypair.generate();
  expectOk(
    send(
      svm,
      creator,
      titleInstructions({ endpoint: ENDPOINT, asset, creator: creator.publicKey, name: "Title", uri: "https://example.com/t.json", attributes: [] }),
      [asset],
    ),
    "standalone title",
  );
  return asset.publicKey;
}

/** A title whose update authority is still the creator's wallet. */
function mutableTitle(svm: Svm, creator: Keypair): PublicKey {
  const asset = Keypair.generate();
  const { umi, signer } = umiFor(creator.publicKey);
  const ix = create(umi, {
    asset: createSignerFromKeypair(umi, fromWeb3JsKeypair(asset)),
    name: "Title",
    uri: "https://example.com/t.json",
    owner: signer.publicKey,
    updateAuthority: signer.publicKey,
    payer: signer,
  })
    .getInstructions()
    .map(toWeb3JsInstruction);
  expectOk(send(svm, creator, ix, [asset]), "mutable title");
  return asset.publicKey;
}

/** A DBC pool account with only the bytes the escrow reads: discriminator, base mint at 136, migrated flag at 305. */
function pool(svm: Svm, coin: PublicKey, migrated: boolean): PublicKey {
  const key = Keypair.generate().publicKey;
  setPool(svm, key, coin, migrated);
  return key;
}

function setPool(svm: Svm, key: PublicKey, coin: PublicKey, migrated: boolean) {
  const data = Buffer.alloc(424);
  Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]).copy(data, 0);
  coin.toBuffer().copy(data, 136);
  data[305] = migrated ? 1 : 0;
  svm.setAccount(key, { lamports: 4_000_000, data, owner: DBC, executable: false });
}

/** Everything a buyer sends, built the way EscrowTrade builds it. */
function buyInstructions(svm: Svm, input: { buyer: Keypair; creator: PublicKey; title: PublicKey; mint: PublicKey; price: bigint; payees?: PublicKey[]; collection?: PublicKey | null; tokenProgram?: PublicKey; openSale?: boolean }) {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(input.mint, input.buyer.publicKey, true, tokenProgram);
  const existing = svm.getAccount(ata);
  const held = existing ? Buffer.from(existing.data).readBigUInt64LE(64) : BigInt(0);
  const plan = planFromBalance({ mint: input.mint, tokenProgram, owner: input.buyer.publicKey, existed: Boolean(existing), held, need: input.price });
  const pay = paymentInstructions(plan, input.buyer.publicKey);
  return {
    plan,
    instructions: [
      ...pay.before,
      openTokenAccount(input.buyer.publicKey, input.creator, input.mint, tokenProgram),
      openTokenAccount(input.buyer.publicKey, TREASURY, input.mint, tokenProgram),
      ...(input.payees ?? []).map((payee) => openTokenAccount(input.buyer.publicKey, payee, input.mint, tokenProgram)),
      escrowBuyInstruction({
        program: PROGRAM,
        buyer: input.buyer.publicKey,
        creator: input.creator,
        title: input.title,
        mint: input.mint,
        tokenProgram,
        price: input.price,
        openSale: input.openSale ?? true,
        payees: input.payees,
        collection: input.collection,
      }),
      ...pay.after,
    ],
  };
}

function openDeposit(input: { creator: Keypair; title: PublicKey; record: PublicKey; mint: PublicKey; price: bigint; burn?: number; collection?: PublicKey | null; sale?: "fixed" | "auction"; delay?: number; payouts?: { wallet: PublicKey; amount: bigint }[] }) {
  return escrowDepositOpenInstruction({
    program: PROGRAM,
    creator: input.creator.publicKey,
    title: input.title,
    record: input.record,
    mint: input.mint,
    collection: input.collection,
    price: input.price,
    delayDays: input.delay ?? 0,
    burnPercent: input.burn ?? 0,
    sale: input.sale,
    payouts: input.payouts,
  });
}

describe("par-escrow, no-coin RWA in its sealed collection", () => {
  test("priced in SOL: deposit, buyer with 0 wrapped SOL wraps and buys, payouts in SOL, title moves", () => {
    const svm = boot();
    const creator = wallet(svm);
    const buyer = wallet(svm);
    const { title, collection } = sealedTitle(svm, creator);
    const price = BigInt(500_000_000);
    expectOk(send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price, collection })]), "deposit_open");
    assert.equal(coreOwner(svm, title), listingAddress(title, PROGRAM).toBase58());
    const before = svm.getBalance(buyer.publicKey)!;
    const { plan, instructions } = buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price, collection });
    assert.equal(plan.wrap, price, "the whole price is wrapped from 0");
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(coreOwner(svm, title), buyer.publicKey.toBase58());
    assert.equal(balance(svm, NATIVE, creator.publicKey), price - price / BigInt(50));
    assert.equal(balance(svm, NATIVE, TREASURY), price / BigInt(50));
    assert.equal(svm.getAccount(getAssociatedTokenAddressSync(NATIVE, buyer.publicKey)), null, "the buyer's wrapped-SOL account opened for this buy is closed");
    assert.ok(before - svm.getBalance(buyer.publicKey)! >= price);
  });

  test("priced in SOL with some wrapped SOL already held: only the shortfall is wrapped, the account stays", () => {
    const svm = boot();
    const creator = wallet(svm);
    const buyer = wallet(svm);
    const { title, collection } = sealedTitle(svm, creator);
    const price = BigInt(300_000_000);
    expectOk(send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price, collection })]), "deposit_open");
    const held = BigInt(100_000_000);
    const pre = paymentInstructions(
      planFromBalance({ mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, owner: buyer.publicKey, existed: false, held: BigInt(0), need: held }),
      buyer.publicKey,
    ).before;
    expectOk(send(svm, buyer, pre), "pre-wrap");
    const { plan, instructions } = buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price, collection });
    assert.equal(plan.wrap, price - held);
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(balance(svm, NATIVE, buyer.publicKey), BigInt(0));
    assert.ok(svm.getAccount(getAssociatedTokenAddressSync(NATIVE, buyer.publicKey)), "a wrapped-SOL account the buyer already had is left open");
  });

  test("priced in SOL with plenty of wrapped SOL: nothing is wrapped", () => {
    const plan = planFromBalance({ mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, owner: Keypair.generate().publicKey, existed: true, held: BigInt(5) * SOL, need: SOL });
    assert.equal(plan.wrap, BigInt(0));
    assert.equal(plan.short, BigInt(0));
    assert.equal(paymentInstructions(plan, Keypair.generate().publicKey).before.length, 1, "only the idempotent account open");
  });

  test("priced in another token (USDC-like, 6 decimals), burn 0, and a named payout", () => {
    const svm = boot();
    const creator = wallet(svm);
    const buyer = wallet(svm);
    const payee = Keypair.generate().publicKey;
    const usdc = newMint(svm, creator, 6);
    const { title, collection } = sealedTitle(svm, creator);
    const price = BigInt(100_000_000);
    fund(svm, creator, usdc, buyer.publicKey, price);
    expectOk(
      send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: usdc, price, burn: 0, collection, payouts: [{ wallet: payee, amount: BigInt(10_000_000) }] })]),
      "deposit_open",
    );
    const { instructions } = buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: usdc, price, payees: [payee], collection });
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(coreOwner(svm, title), buyer.publicKey.toBase58());
    assert.equal(balance(svm, usdc, TREASURY), BigInt(2_000_000));
    assert.equal(balance(svm, usdc, payee), BigInt(10_000_000));
    assert.equal(balance(svm, usdc, creator.publicKey), BigInt(88_000_000));
    assert.equal(balance(svm, usdc, buyer.publicKey), BigInt(0));
  });

  test("auction priced in SOL: two bids, refund, clock ends, settle (claim) sends the title to the winner", () => {
    const svm = boot();
    const creator = wallet(svm);
    const first = wallet(svm);
    const second = wallet(svm);
    const { title, collection } = sealedTitle(svm, creator);
    expectOk(send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price: BigInt(100_000_000), collection, sale: "auction" })]), "deposit_open auction");
    const bid = (bidder: Keypair, amount: bigint, previous: PublicKey | null) => {
      const plan = planFromBalance({ mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, owner: bidder.publicKey, existed: false, held: BigInt(0), need: amount });
      const pay = paymentInstructions(plan, bidder.publicKey);
      return send(svm, bidder, [
        ...pay.before,
        escrowBidInstruction({ program: PROGRAM, bidder: bidder.publicKey, title, mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, amount, previousBidder: previous }),
      ]);
    };
    expectOk(bid(first, BigInt(100_000_000), null), "first bid");
    expectOk(bid(second, BigInt(150_000_000), first.publicKey), "second bid");
    assert.equal(balance(svm, NATIVE, first.publicKey), BigInt(100_000_000), "the first bidder is refunded in wrapped SOL");
    const settle = () =>
      send(svm, creator, [
        openTokenAccount(creator.publicKey, creator.publicKey, NATIVE, TOKEN_PROGRAM_ID),
        openTokenAccount(creator.publicKey, TREASURY, NATIVE, TOKEN_PROGRAM_ID),
        escrowSettleInstruction({ program: PROGRAM, payer: creator.publicKey, creator: creator.publicKey, winner: second.publicKey, title, mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, openSale: true, collection }),
      ]);
    expectError(settle(), "ClockRunning", "settle before the clock ends");
    warp(svm, 80);
    expectError(
      send(svm, creator, [
        openTokenAccount(creator.publicKey, creator.publicKey, NATIVE, TOKEN_PROGRAM_ID),
        openTokenAccount(creator.publicKey, TREASURY, NATIVE, TOKEN_PROGRAM_ID),
        escrowSettleInstruction({ program: PROGRAM, payer: creator.publicKey, creator: creator.publicKey, winner: second.publicKey, title, mint: NATIVE, tokenProgram: TOKEN_PROGRAM_ID, openSale: true }),
      ]),
      "WrongCollection",
      "settle without the collection",
    );
    expectOk(settle(), "settle");
    assert.equal(coreOwner(svm, title), second.publicKey.toBase58());
    assert.equal(balance(svm, NATIVE, creator.publicKey), BigInt(147_000_000));
    assert.equal(balance(svm, NATIVE, TREASURY), BigInt(3_000_000));
  });

  test("reclaim (cancel): refused until the wait is over, then the title returns to the creator", () => {
    const svm = boot();
    const creator = wallet(svm);
    const { title, collection } = sealedTitle(svm, creator);
    expectOk(send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price: SOL, collection })]), "deposit_open");
    const reclaim = (withCollection: boolean) =>
      send(svm, creator, [escrowReclaimInstruction({ program: PROGRAM, creator: creator.publicKey, title, pool: PROGRAM, collection: withCollection ? collection : null })]);
    expectError(reclaim(true), "TooEarly", "early reclaim");
    warp(svm, 366);
    expectError(reclaim(false), "WrongCollection", "reclaim without the collection");
    expectOk(reclaim(true), "reclaim");
    assert.equal(coreOwner(svm, title), creator.publicKey.toBase58());
    assert.equal(svm.getAccount(listingAddress(title, PROGRAM))?.lamports ?? 0, 0, "the listing is closed");
  });
});

describe("par-escrow, coin-paired RWA in its sealed collection (same title check)", () => {
  function coinListing(svm: Svm, priceMint: (creator: Keypair, coin: PublicKey) => PublicKey, burn: number) {
    const creator = wallet(svm);
    const coin = newMint(svm, creator, 6);
    const { title, collection } = sealedTitle(svm, creator);
    const poolKey = pool(svm, coin, false);
    const mint = priceMint(creator, coin);
    const price = BigInt(1_000_000);
    const deposit = escrowDepositInstruction({
      program: PROGRAM,
      creator: creator.publicKey,
      title,
      record: record(svm, creator),
      mint,
      coin,
      pool: poolKey,
      collection,
      price,
      delayDays: 1,
      burnPercent: burn,
    });
    expectOk(send(svm, creator, [deposit]), "deposit");
    return { creator, coin, title, collection, poolKey, mint, price };
  }

  function graduateAndOpen(svm: Svm, l: { title: PublicKey; poolKey: PublicKey; coin: PublicKey; creator: Keypair }) {
    expectError(send(svm, l.creator, [markGraduatedInstruction(PROGRAM, l.title, l.poolKey)]), "NotGraduated", "mark before migration");
    setPool(svm, l.poolKey, l.coin, true);
    expectOk(send(svm, l.creator, [markGraduatedInstruction(PROGRAM, l.title, l.poolKey)]), "mark graduated");
    warp(svm, 2);
  }

  test("priced in its own coin with a 25% burn", () => {
    const svm = boot();
    const l = coinListing(svm, (_c, coin) => coin, 25);
    const buyer = wallet(svm);
    fund(svm, l.creator, l.coin, buyer.publicKey, l.price);
    const early = buyInstructions(svm, { buyer, creator: l.creator.publicKey, title: l.title, mint: l.mint, price: l.price, collection: l.collection, openSale: false });
    expectError(send(svm, buyer, early.instructions), "NotGraduated", "buy before graduation");
    graduateAndOpen(svm, l);
    const { instructions } = buyInstructions(svm, { buyer, creator: l.creator.publicKey, title: l.title, mint: l.mint, price: l.price, collection: l.collection, openSale: false });
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(coreOwner(svm, l.title), buyer.publicKey.toBase58());
    assert.equal(balance(svm, l.coin, l.creator.publicKey), BigInt(730_000));
    assert.equal(balance(svm, l.coin, TREASURY), BigInt(20_000));
  });

  test("priced in SOL (wrapped SOL, burn 0)", () => {
    const svm = boot();
    const l = coinListing(svm, () => NATIVE, 0);
    graduateAndOpen(svm, l);
    const buyer = wallet(svm);
    const { plan, instructions } = buyInstructions(svm, { buyer, creator: l.creator.publicKey, title: l.title, mint: l.mint, price: l.price, collection: l.collection, openSale: false });
    assert.equal(plan.wrap, l.price);
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(coreOwner(svm, l.title), buyer.publicKey.toBase58());
    assert.equal(balance(svm, NATIVE, l.creator.publicKey), BigInt(980_000));
  });

  test("priced in USDC (another SPL token, 6 decimals)", () => {
    const svm = boot();
    let usdc = PublicKey.default;
    const l = coinListing(svm, (creator) => (usdc = newMint(svm, creator, 6)), 0);
    graduateAndOpen(svm, l);
    const buyer = wallet(svm);
    fund(svm, l.creator, usdc, buyer.publicKey, l.price);
    const { instructions } = buyInstructions(svm, { buyer, creator: l.creator.publicKey, title: l.title, mint: usdc, price: l.price, collection: l.collection, openSale: false });
    expectOk(send(svm, buyer, instructions), "buy");
    assert.equal(balance(svm, usdc, l.creator.publicKey), BigInt(980_000));
    assert.equal(balance(svm, usdc, TREASURY), BigInt(20_000));
  });

  test("reclaim of a coin title that never graduates", () => {
    const svm = boot();
    const l = coinListing(svm, (_c, coin) => coin, 25);
    warp(svm, 366);
    expectOk(
      send(svm, l.creator, [escrowReclaimInstruction({ program: PROGRAM, creator: l.creator.publicKey, title: l.title, pool: l.poolKey, collection: l.collection })]),
      "reclaim",
    );
    assert.equal(coreOwner(svm, l.title), l.creator.publicKey.toBase58());
  });

  test("the coin has to be the pool's coin", () => {
    const svm = boot();
    const creator = wallet(svm);
    const coin = newMint(svm, creator, 6);
    const other = newMint(svm, creator, 6);
    const { title, collection } = sealedTitle(svm, creator);
    const ix = escrowDepositInstruction({ program: PROGRAM, creator: creator.publicKey, title, record: record(svm, creator), mint: coin, coin: other, pool: pool(svm, coin, false), collection, price: BigInt(1), delayDays: 1, burnPercent: 0 });
    expectError(send(svm, creator, [ix]), "WrongPool", "deposit with a coin that is not the pool's");
  });
});

/** Core instructions built with `who` as the authority (and payer), signed by `who` in LiteSVM. */
function asAuthority(who: PublicKey) {
  const { umi, signer } = umiFor(who);
  const k = (key: PublicKey) => umiKey(key.toBase58());
  const ix = (builder: { getInstructions: () => Parameters<typeof toWeb3JsInstruction>[0][] }) => builder.getInstructions().map(toWeb3JsInstruction);
  return {
    rename: (asset: PublicKey, collection?: PublicKey) =>
      ix(updateV2(umi, { asset: k(asset), collection: collection ? k(collection) : undefined, payer: signer, authority: signer, newName: "Changed" })),
    transfer: (asset: PublicKey, to: PublicKey, collection?: PublicKey) =>
      ix(transferV1(umi, { asset: k(asset), collection: collection ? k(collection) : undefined, payer: signer, authority: signer, newOwner: k(to) })),
    burn: (asset: PublicKey, collection?: PublicKey) =>
      ix(burnV1(umi, { asset: k(asset), collection: collection ? k(collection) : undefined, payer: signer, authority: signer })),
    freeze: (asset: PublicKey, collection?: PublicKey) =>
      ix(addPluginV1(umi, { asset: k(asset), collection: collection ? k(collection) : undefined, payer: signer, authority: signer, plugin: createPlugin({ type: "FreezeDelegate", data: { frozen: true } }) })),
    renameCollection: (collection: PublicKey) => ix(updateCollection(umi, { collection: k(collection), payer: signer, authority: signer, name: "Changed" })),
    takeCollection: (collection: PublicKey) =>
      ix(updateCollection(umi, { collection: k(collection), payer: signer, authority: signer, newUpdateAuthority: signer.publicKey })),
    collectionPlugin: (collection: PublicKey) =>
      ix(addCollectionPluginV1(umi, { collection: k(collection), payer: signer, authority: signer, plugin: createPlugin({ type: "UpdateDelegate" }) })),
    mintInto: (collection: PublicKey, asset: Keypair) =>
      ix(
        create(umi, {
          asset: createSignerFromKeypair(umi, fromWeb3JsKeypair(asset)),
          collection: { publicKey: k(collection) },
          name: "Second title",
          uri: "https://example.com/2.json",
          owner: signer.publicKey,
          payer: signer,
          authority: signer,
        }),
      ),
  };
}

function rpcAccount(svm: Svm, key: PublicKey) {
  const account = svm.getAccount(key);
  assert.ok(account, `${key.toBase58()} missing`);
  return {
    publicKey: umiKey(key.toBase58()),
    data: Uint8Array.from(account.data),
    executable: false,
    owner: umiKey(account.owner.toBase58()),
    lamports: { basisPoints: BigInt(account.lamports), identifier: "SOL" as const, decimals: 9 as const },
  };
}

function expectRefused(result: ReturnType<typeof send>, what: string) {
  assert.equal(result.ok, false, `${what} should have been refused by Metaplex Core`);
}

describe("mint model: the vault-held master (record), the sealed collection (master edition), and the edition (title)", () => {
  test("built by the app's own RecordCreate builders, then every authority is tried", () => {
    const svm = boot();
    const creator = wallet(svm);
    // Stand-in for the vault pMUdWH9U…tmfei. It is a real signing wallet (on the curve), so the test gives it a key.
    const vault = wallet(svm, 5);
    const recordKey = Keypair.generate();
    expectOk(
      send(
        svm,
        creator,
        recordInstruction({ endpoint: ENDPOINT, asset: recordKey, payer: creator.publicKey, vault: vault.publicKey, name: "Record", uri: "https://example.com/r.json", attributes: [{ key: "record", value: "PAR asset record v1" }] }),
        [recordKey],
      ),
      "record (master) to the vault",
    );
    const { title, collection } = sealedTitle(svm, creator);

    // What is on chain.
    const rec = deserializeAssetV1(rpcAccount(svm, recordKey.publicKey));
    assert.equal(rec.owner, vault.publicKey.toBase58());
    assert.deepEqual(rec.updateAuthority, { type: "Address", address: vault.publicKey.toBase58() });
    assert.equal(rec.permanentFreezeDelegate?.frozen, true);
    assert.equal(rec.permanentFreezeDelegate?.authority.type, "None");
    assert.equal(rec.immutableMetadata?.authority.type, "None");
    assert.equal(rec.addBlocker?.authority.type, "None");
    const col = deserializeCollectionV1(rpcAccount(svm, collection));
    assert.equal(col.updateAuthority, sealedAuthority(collection).toBase58());
    assert.equal(PublicKey.isOnCurve(sealedAuthority(collection).toBytes()), false, "the seal is off the curve: no key exists");
    assert.equal(col.numMinted, 1);
    assert.equal(col.currentSize, 1);
    assert.equal(col.masterEdition?.maxSupply, 1);
    assert.equal(col.masterEdition?.authority.type, "None");
    const ttl = deserializeAssetV1(rpcAccount(svm, title));
    assert.equal(ttl.owner, creator.publicKey.toBase58());
    assert.deepEqual(ttl.updateAuthority, { type: "Collection", address: collection.toBase58() });
    assert.equal(ttl.edition?.number, 1);
    assert.equal(ttl.edition?.authority.type, "None");
    assert.equal(ttl.freezeDelegate ?? ttl.transferDelegate ?? ttl.burnDelegate ?? ttl.updateDelegate, undefined, "no delegate on the title");
    // The record is not in the collection and names no authority over it.
    assert.equal(coreCollectionOf(Buffer.from(svm.getAccount(recordKey.publicKey)!.data)), null);

    // The vault cannot change, move, or burn its own record.
    const v = asAuthority(vault.publicKey);
    expectRefused(send(svm, vault, v.rename(recordKey.publicKey)), "vault renames the record");
    expectRefused(send(svm, vault, v.transfer(recordKey.publicKey, vault.publicKey)), "vault moves the record");
    expectRefused(send(svm, vault, v.burn(recordKey.publicKey)), "vault burns the record");
    // As the record's owner, the vault can still attach owner-managed plugins (AddBlocker stops only authority-managed
    // ones). Even a transfer or burn delegate it names cannot move or burn the record: the permanent freeze wins.
    const helper = wallet(svm, 2);
    const delegate = (type: "TransferDelegate" | "BurnDelegate") =>
      addPluginV1(umiFor(vault.publicKey).umi, {
        asset: umiKey(recordKey.publicKey.toBase58()),
        payer: umiFor(vault.publicKey).signer,
        authority: umiFor(vault.publicKey).signer,
        plugin: createPlugin({ type }),
        initAuthority: { __kind: "Address", address: umiKey(helper.publicKey.toBase58()) },
      })
        .getInstructions()
        .map(toWeb3JsInstruction);
    expectOk(send(svm, vault, delegate("TransferDelegate")), "vault names a transfer delegate on its record");
    expectOk(send(svm, vault, delegate("BurnDelegate")), "vault names a burn delegate on its record");
    const h = asAuthority(helper.publicKey);
    expectRefused(send(svm, helper, h.transfer(recordKey.publicKey, helper.publicKey)), "the vault's transfer delegate moves the record");
    expectRefused(send(svm, helper, h.burn(recordKey.publicKey)), "the vault's burn delegate burns the record");
    expectRefused(send(svm, vault, v.transfer(recordKey.publicKey, helper.publicKey)), "vault moves the record after naming delegates");
    expectRefused(send(svm, helper, h.rename(title, collection)), "the vault's delegate renames the title");
    expectRefused(send(svm, helper, h.transfer(title, helper.publicKey, collection)), "the vault's delegate moves the title");
    assert.equal(coreOwner(svm, recordKey.publicKey), vault.publicKey.toBase58());
    // The vault, as the record's update authority, cannot hand that authority on, edit its attributes, or strip its locks.
    const vu = umiFor(vault.publicKey);
    const recordAsset = umiKey(recordKey.publicKey.toBase58());
    const asVault = (builder: { getInstructions: () => Parameters<typeof toWeb3JsInstruction>[0][] }) => builder.getInstructions().map(toWeb3JsInstruction);
    expectRefused(
      send(svm, vault, asVault(updateV2(vu.umi, { asset: recordAsset, payer: vu.signer, authority: vu.signer, newUpdateAuthority: { __kind: "Address", fields: [umiKey(helper.publicKey.toBase58())] } }))),
      "vault hands on the record's update authority",
    );
    expectRefused(
      send(svm, vault, asVault(updatePluginV1(vu.umi, { asset: recordAsset, payer: vu.signer, authority: vu.signer, plugin: createPlugin({ type: "Attributes", data: { attributeList: [{ key: "record", value: "changed" }] } }) }))),
      "vault edits the record's attributes",
    );
    for (const pluginType of [PluginType.PermanentFreezeDelegate, PluginType.ImmutableMetadata, PluginType.AddBlocker, PluginType.Attributes]) {
      expectRefused(send(svm, vault, asVault(removePluginV1(vu.umi, { asset: recordAsset, payer: vu.signer, authority: vu.signer, pluginType }))), `vault removes ${PluginType[pluginType]} from the record`);
    }
    // The vault has no authority over the title or its collection.
    expectRefused(send(svm, vault, v.rename(title, collection)), "vault renames the title");
    expectRefused(send(svm, vault, v.transfer(title, vault.publicKey, collection)), "vault moves the title");
    expectRefused(send(svm, vault, v.burn(title, collection)), "vault burns the title");
    expectRefused(send(svm, vault, v.freeze(title, collection)), "vault freezes the title");
    expectRefused(send(svm, vault, v.renameCollection(collection)), "vault renames the collection");
    expectRefused(send(svm, vault, v.takeCollection(collection)), "vault takes the collection");

    // The creator, as former collection authority, can no longer change the title or the collection, or mint a second.
    const c = asAuthority(creator.publicKey);
    expectRefused(send(svm, creator, c.rename(title, collection)), "creator renames the title");
    expectRefused(send(svm, creator, c.renameCollection(collection)), "creator renames the collection");
    expectRefused(send(svm, creator, c.takeCollection(collection)), "creator takes the collection back");
    expectRefused(send(svm, creator, c.collectionPlugin(collection)), "creator adds an update delegate to the collection");
    const second = Keypair.generate();
    expectRefused(send(svm, creator, c.mintInto(collection, second), [second]), "creator mints a second title into the collection");
    assert.equal(deserializeCollectionV1(rpcAccount(svm, collection)).numMinted, 1);

    // The title goes into the escrow. There the owner is the listing PDA, so neither the vault nor the creator can
    // move, burn, freeze, or change it.
    const rec2 = recordKey.publicKey;
    expectOk(send(svm, creator, [openDeposit({ creator, title, record: rec2, mint: NATIVE, price: SOL, collection })]), "deposit");
    const listing = listingAddress(title, PROGRAM).toBase58();
    assert.equal(coreOwner(svm, title), listing);
    for (const [who, key] of [[c, creator], [v, vault]] as const) {
      expectRefused(send(svm, key, who.transfer(title, key.publicKey, collection)), "move the title out of escrow");
      expectRefused(send(svm, key, who.burn(title, collection)), "burn the title in escrow");
      expectRefused(send(svm, key, who.freeze(title, collection)), "freeze the title in escrow");
      expectRefused(send(svm, key, who.rename(title, collection)), "rename the title in escrow");
    }
    // A buyer gets exactly that title.
    const buyer = wallet(svm);
    const buy = buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price: SOL, collection });
    expectOk(send(svm, buyer, buy.instructions), "buy");
    assert.equal(coreOwner(svm, title), buyer.publicKey.toBase58());
    assert.equal(deserializeAssetV1(rpcAccount(svm, title)).name, "Title");
  });

  test("controls: the same builders succeed when the signer does hold the authority", () => {
    const svm = boot();
    const creator = wallet(svm);
    const c = asAuthority(creator.publicKey);
    // A title whose update authority is still the creator's wallet can be renamed by it.
    const loose = mutableTitle(svm, creator);
    expectOk(send(svm, creator, c.rename(loose)), "rename with the real update authority");
    // The owner of a sealed title can move it and burn it while it holds it (ordinary ownership).
    const other = wallet(svm);
    const one = sealedTitle(svm, creator);
    expectOk(send(svm, creator, c.transfer(one.title, other.publicKey, one.collection)), "owner moves its title");
    assert.equal(coreOwner(svm, one.title), other.publicKey.toBase58());
    const two = sealedTitle(svm, creator);
    expectOk(send(svm, creator, c.burn(two.title, two.collection)), "owner burns its title");
    // An unsealed collection can still be renamed by its authority: the seal is what stops it.
    const collection = Keypair.generate();
    expectOk(
      send(svm, creator, editionCollectionInstructions({ endpoint: ENDPOINT, collection, creator: creator.publicKey, name: "C", uri: "https://example.com/c.json" }), [collection]),
      "unsealed collection",
    );
    expectOk(send(svm, creator, c.renameCollection(collection.publicKey)), "rename an unsealed collection");
  });

  test("an owner can add a freeze delegate to its own title before a deposit; the escrow then refuses it", () => {
    const svm = boot();
    const creator = wallet(svm);
    const { title, collection } = sealedTitle(svm, creator);
    const c = asAuthority(creator.publicKey);
    expectOk(send(svm, creator, c.freeze(title, collection)), "owner adds a freeze delegate (an owner-managed plugin)");
    const rec = record(svm, creator);
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]), "TitleHasDelegate", "deposit");
  });
});

describe("burn only ever burns the title's own paired coin (BurnNotCoin)", () => {
  /** A coin-paired deposit priced in `mint`, built with burn 0 and then patched to `burn` so the program decides. */
  function coinDeposit(svm: Svm, priceMint: (creator: Keypair, coin: PublicKey) => PublicKey, burn: number) {
    const creator = wallet(svm);
    const coin = newMint(svm, creator, 6);
    const { title, collection } = sealedTitle(svm, creator);
    const mint = priceMint(creator, coin);
    const input = { program: PROGRAM, creator: creator.publicKey, title, record: record(svm, creator), mint, coin, pool: pool(svm, coin, false), collection, price: BigInt(1_000_000), delayDays: 1 };
    if (burn > 0 && !mint.equals(coin)) {
      assert.throws(() => escrowDepositInstruction({ ...input, burnPercent: burn }), /only burns this title's own coin/, "the client refuses first");
    }
    const ix = escrowDepositInstruction({ ...input, burnPercent: 0 });
    ix.data.writeUInt16LE(burn * 100, 18);
    return { creator, ix, title };
  }

  test("allowed: coin-paired, priced in its own coin, 25% burn", () => {
    const svm = boot();
    const { creator, ix, title } = coinDeposit(svm, (_c, coin) => coin, 25);
    expectOk(send(svm, creator, [ix]), "deposit with a coin burn");
    assert.equal(coreOwner(svm, title), listingAddress(title, PROGRAM).toBase58());
    assert.equal(Buffer.from(svm.getAccount(listingAddress(title, PROGRAM))!.data).readUInt16LE(200), 2500);
  });

  test("allowed: coin-paired priced in another token with burn 0", () => {
    const svm = boot();
    const { creator, ix } = coinDeposit(svm, (creator) => newMint(svm, creator, 6), 0);
    expectOk(send(svm, creator, [ix]), "deposit, other token, burn 0");
  });

  const others: [string, (svm: Svm, creator: Keypair) => PublicKey][] = [
    ["SOL (wrapped SOL)", () => NATIVE],
    ["USDC (another 6-decimal SPL token)", (svm, creator) => newMint(svm, creator, 6)],
    ["any other mint (9 decimals)", (svm, creator) => newMint(svm, creator, 9)],
  ];
  for (const [name, pick] of others) {
    test(`refused: coin-paired, priced in ${name}, 25% burn`, () => {
      const svm = boot();
      const { creator, ix, title } = coinDeposit(svm, (creator) => pick(svm, creator), 25);
      expectError(send(svm, creator, [ix]), "BurnNotCoin", `deposit priced in ${name} with a burn`);
      assert.equal(coreOwner(svm, title), creator.publicKey.toBase58(), "the title stays with the creator");
    });
  }

  const noCoinMints: [string, (svm: Svm, creator: Keypair) => PublicKey][] = [
    ["SOL", () => NATIVE],
    ["USDC-like", (svm, creator) => newMint(svm, creator, 6)],
  ];
  for (const [name, mintOf] of noCoinMints) {
    test(`refused: no-coin title priced in ${name}, 25% burn`, () => {
      const svm = boot();
      const creator = wallet(svm);
      const { title, collection } = sealedTitle(svm, creator);
      const mint = mintOf(svm, creator);
      assert.throws(() => openDeposit({ creator, title, record: record(svm, creator), mint, price: SOL, burn: 25, collection }), /only burns this title's own coin/);
      const ix = openDeposit({ creator, title, record: record(svm, creator), mint, price: SOL, burn: 0, collection });
      ix.data.writeUInt16LE(2500, 18);
      expectError(send(svm, creator, [ix]), "BurnNotCoin", `no-coin deposit_open with a burn in ${name}`);
      assert.equal(coreOwner(svm, title), creator.publicKey.toBase58());
    });
  }
});

describe("par-escrow refuses titles and tokens it cannot keep safe", () => {
  let svm: Svm;
  let creator: Keypair;
  let rec: PublicKey;
  before(() => {
    svm = boot();
    creator = wallet(svm);
    rec = record(svm, creator);
  });
  after(() => undefined);

  test("a mutable title (update authority is a wallet)", () => {
    const title = mutableTitle(svm, creator);
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL })]), "TitleChangeable", "mutable title");
  });

  test("a title with a freeze delegate", () => {
    const { title, collection } = sealedTitle(svm, creator, { extraPlugins: [{ type: "FreezeDelegate", frozen: false }] });
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]), "TitleHasDelegate", "freeze delegate");
  });

  test("a title with a transfer delegate", () => {
    const { title, collection } = sealedTitle(svm, creator, { extraPlugins: [{ type: "TransferDelegate" }] });
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]), "TitleHasDelegate", "transfer delegate");
  });

  test("the wrong collection, or none", () => {
    const { title } = sealedTitle(svm, creator);
    const other = sealedTitle(svm, creator);
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection: other.collection })]), "WrongCollection", "other collection");
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL })]), "WrongCollection", "no collection");
  });

  test("a collection that is not sealed (the creator can still change it)", () => {
    const { title, collection } = sealedTitle(svm, creator, { seal: false });
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]), "CollectionChangeable", "unsealed");
  });

  test("a burn on a SOL price (the token program cannot burn wrapped SOL)", () => {
    const { title, collection } = sealedTitle(svm, creator);
    assert.throws(() => openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, burn: 25, collection }), /only burns this title's own coin/);
    const ix = openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, burn: 0, collection });
    ix.data.writeUInt16LE(2500, 18);
    expectError(send(svm, creator, [ix]), "BurnNotCoin", "program-level burn on a no-coin SOL price");
  });

  test("a Token-2022 price token", () => {
    const { title, collection } = sealedTitle(svm, creator);
    const mint = newMint(svm, creator, 6, TOKEN_2022_PROGRAM_ID);
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint, price: SOL, collection })]), "UnsupportedToken", "token-2022");
  });

  test("someone else's title", () => {
    const stranger = wallet(svm);
    const { title, collection } = sealedTitle(svm, stranger);
    expectError(send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]), "NotOwner", "not owner");
  });

  test("wrong program id or network: the client refuses before anything is signed", () => {
    const { title, collection } = sealedTitle(svm, creator);
    const wrong = Keypair.generate().publicKey;
    assert.throws(
      () => escrowDepositOpenInstruction({ program: wrong, creator: creator.publicKey, title, record: rec, mint: NATIVE, collection, price: SOL, delayDays: 0, burnPercent: 0 }),
      /not available on this network/,
    );
    assert.equal(ESCROW_PROGRAM["mainnet-beta"], "");
    assert.equal(escrowOffered("mainnet-beta"), false);
    assert.equal(escrowDepositAllowed("mainnet-beta", "pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u"), false);
    // The same instruction sent to another program address does nothing there: the escrow at its real address never sees it.
    const ix = openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection });
    ix.programId = wrong;
    assert.equal(send(svm, creator, [ix]).ok, false);
    assert.equal(coreOwner(svm, title), creator.publicKey.toBase58());
  });
});

describe("upgrade compatibility with today's devnet state", () => {
  test("found: on the deployed program a no-coin sale with no named payouts cannot be bought with the old client account list", () => {
    for (const [so, withPayoutAccount, expected] of [
      [OLD_SO, false, "BadPayout"],
      [OLD_SO, true, ""],
      [NEW_SO, true, ""],
    ] as const) {
      const svm = boot(so);
      const creator = wallet(svm);
      const buyer = wallet(svm);
      const title = standaloneTitle(svm, creator);
      expectOk(send(svm, creator, [openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price: SOL })]), "deposit_open standalone");
      const result = send(svm, buyer, buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price: SOL, openSale: withPayoutAccount }).instructions);
      if (expected) expectError(result, expected, "old client list");
      else expectOk(result, "buy with the payout account");
    }
  });

  function loadFixture(svm: Svm, name: string, override?: (data: Buffer) => void) {
    const a = FIXTURES.accounts[name];
    const data = Buffer.from(a.data, "base64");
    override?.(data);
    svm.setAccount(new PublicKey(a.address), { lamports: a.lamports, data, owner: new PublicKey(a.owner), executable: false });
    return new PublicKey(a.address);
  }

  test("found: the deployed program takes a SOL price with a burn, and then no one can ever buy it", () => {
    const svm = boot(OLD_SO);
    const creator = wallet(svm);
    const buyer = wallet(svm);
    const title = standaloneTitle(svm, creator);
    const ix = openDeposit({ creator, title, record: record(svm, creator), mint: NATIVE, price: SOL, burn: 0 });
    ix.data.writeUInt16LE(2500, 18);
    expectOk(send(svm, creator, [ix]), "deployed program accepts a 25% burn on wrapped SOL");
    const result = send(svm, buyer, buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price: SOL }).instructions);
    assert.equal(result.ok, false, "the buy fails");
    if (process.env.SHOW_LOGS) console.log(result.logs.filter((line) => /native/i.test(line)).join("\n"));
    assert.ok(result.logs.some((line) => /native|0xa\b|NativeNotSupported|Instruction does not support native tokens/i.test(line)), result.logs.slice(-6).join("\n"));
  });

  test("the live listing MADGV... (standalone title, priced in its coin) still sells with the old account list", () => {
    for (const so of [OLD_SO, NEW_SO]) {
      const svm = boot(so);
      const listing = loadFixture(svm, "liveListing");
      const title = loadFixture(svm, "liveTitle");
      const coin = loadFixture(svm, "liveCoin", (data) => {
        // Hand the mint authority to the test so it can fund the buyer. Supply and decimals stay as on devnet.
        data.writeUInt32LE(1, 0);
      });
      loadFixture(svm, "livePool");
      assert.equal(listing.toBase58(), listingAddress(title, PROGRAM).toBase58());
      const data = Buffer.from(FIXTURES.accounts.liveListing.data, "base64");
      const creator = new PublicKey(data.subarray(8, 40));
      const price = data.readBigUInt64LE(168);
      const buyer = wallet(svm);
      const authority = wallet(svm);
      const mintData = Buffer.from(svm.getAccount(coin)!.data);
      authority.publicKey.toBuffer().copy(mintData, 4);
      svm.setAccount(coin, { lamports: FIXTURES.accounts.liveCoin.lamports, data: mintData, owner: TOKEN_PROGRAM_ID, executable: false });
      fund(svm, authority, coin, buyer.publicKey, price);
      const { instructions } = buyInstructions(svm, { buyer, creator, title, mint: coin, price, collection: null, openSale: false });
      expectOk(send(svm, buyer, instructions), `buy on ${so.endsWith("deployed.so") ? "deployed" : "upgraded"} program`);
      assert.equal(coreOwner(svm, title), buyer.publicKey.toBase58());
    }
  });

  test("the real devnet sealed title 4B6t... is refused today and accepted after the upgrade", () => {
    for (const [so, ok] of [
      [OLD_SO, false],
      [NEW_SO, true],
    ] as const) {
      const svm = boot(so);
      const creator = wallet(svm);
      // Only the owner bytes change, so the test wallet can sign. Update authority, collection, and plugins stay as on devnet.
      const title = loadFixture(svm, "sealedTitle", (data) => creator.publicKey.toBuffer().copy(data, 1));
      const collection = loadFixture(svm, "sealedCollection");
      const rec = loadFixture(svm, "sealedRecord");
      const result = send(svm, creator, [openDeposit({ creator, title, record: rec, mint: NATIVE, price: SOL, collection })]);
      if (ok) {
        expectOk(result, "deposit of the devnet sealed title");
        const buyer = wallet(svm);
        expectOk(send(svm, buyer, buyInstructions(svm, { buyer, creator: creator.publicKey, title, mint: NATIVE, price: SOL, collection }).instructions), "buy");
        assert.equal(coreOwner(svm, title), buyer.publicKey.toBase58());
      } else {
        expectError(result, "TitleChangeable", "deployed program on a sealed title");
      }
    }
  });
});
