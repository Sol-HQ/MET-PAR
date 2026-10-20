/**
 * The escrow card's trait chips and sale line. Run: npx tsx --test tests/*.test.ts
 * Chips are the RWA's own facts read from the record, the title, and the escrow listing. Nothing is filled in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { escrowBurnLine, escrowCardTraits, escrowOpenLine, escrowSaleLine, mintedForTensor, rwaName, shipAdvice, type EscrowCardFacts } from "../src/lib/escrow-card";
import { recordAttributes } from "../src/lib/record";
import { SHIP_ADVICE, titleAttributes, type TitleFacts } from "../src/lib/title";

const key = () => Keypair.generate().publicKey.toBase58();
const WSOL = "So11111111111111111111111111111111111111112";
const COIN = key();
const minted: TitleFacts = {
  record: key(),
  mint: WSOL,
  pool: "none",
  creator: key(),
  rail: "creator",
  delayDays: 0,
  burnPercent: 0,
  venue: "https://www.meteora.surf/t/example?c=devnet",
  noCoin: true,
};
const rows = (list: { key: string; value: string }[]) => Object.fromEntries(list.map((row) => [row.key, row.value]));
// The live PZ-4CO title: minted for Tensor, no coin, and "burned" dropped at mint to fit 1232 bytes (DROP_BEFORE_SHEET).
const liveTitle = (() => {
  const all = rows(titleAttributes(minted));
  delete all.burned;
  return all;
})();
const now = 1_800_000_000;
const facts = (over: Partial<EscrowCardFacts> = {}): EscrowCardFacts => ({
  name: "PZ-4CO w/autograph",
  edition: 1,
  editionOfOne: true,
  coin: null,
  soldIn: ["SOL"],
  sale: "fixed",
  burn: null,
  opensAt: now - 60,
  endsAt: 0,
  now,
  live: true,
  titleAttributes: liveTitle,
  recordAttributes: {},
  ...over,
});
const chip = (list: { type: string; value: string }[], type: string) => list.filter((row) => row.type === type).map((row) => row.value);

test("title chip: the RWA's name, never the version tag", () => {
  assert.equal(liveTitle.title, "PAR title v1", "the fixture carries the version tag");
  const traits = escrowCardTraits(facts());
  assert.deepEqual(chip(traits, "title"), ["PZ-4CO w/autograph"]);
  assert.ok(!JSON.stringify(traits).includes("PAR title v1"));
  assert.equal(rwaName("PZ-4CO w/autograph", "PZ-4CO w/autograph title"), "PZ-4CO w/autograph", "the record name wins");
  assert.equal(rwaName("", "PZ-4CO w/autograph title"), "PZ-4CO w/autograph", "the title NFT's ' title' suffix comes off");
  assert.equal(rwaName(null, "Untitled thing"), "Untitled thing", "no suffix, nothing taken off");
  assert.deepEqual(chip(escrowCardTraits(facts({ name: "" })), "title"), [], "no name, no chip");
});

test("coin pair: 'none' with no coin; the coin's name and symbol, linked, when paired", () => {
  const none = escrowCardTraits(facts());
  assert.deepEqual(chip(none, "coin pair"), ["none"]);
  assert.deepEqual(chip(none, "coin"), [], "never the generic 'coin' line");
  const paired = escrowCardTraits(facts({ coin: { name: "Pizza Coin", symbol: "PZC", mint: COIN } }));
  assert.deepEqual(chip(paired, "coin pair"), ["Pizza Coin (PZC)"]);
  assert.equal(paired.find((row) => row.type === "coin pair")?.address, COIN);
  assert.deepEqual(chip(escrowCardTraits(facts({ coin: { symbol: "PZC", mint: COIN } })), "coin pair"), ["PZC"]);
  const bare = chip(escrowCardTraits(facts({ coin: { mint: COIN } })), "coin pair")[0];
  assert.equal(bare, `${COIN.slice(0, 4)}…${COIN.slice(-4)}`, "only the mint known: its short address");
});

test("sold in: the listing's token(s), never 'this token only'", () => {
  const one = escrowCardTraits(facts());
  assert.deepEqual(chip(one, "sold in"), ["SOL"]);
  assert.deepEqual(chip(one, "paid in"), []);
  assert.ok(!JSON.stringify(one).includes("this token only"));
  assert.deepEqual(chip(escrowCardTraits(facts({ soldIn: ["SOL", "USDC", "PZC"] })), "sold in"), ["SOL, USDC, PZC"]);
  assert.deepEqual(chip(escrowCardTraits(facts({ soldIn: [] })), "sold in"), [], "unknown token, no chip");
});

test("route chips: PAR escrow program, held by 'PAR escrow', fixed price or auction", () => {
  const traits = escrowCardTraits(facts());
  assert.deepEqual(chip(traits, "sold through"), ["PAR escrow program"]);
  assert.deepEqual(chip(traits, "held by"), ["PAR escrow"]);
  assert.deepEqual(chip(traits, "sale"), ["fixed price"]);
  assert.ok(!/tensor|creator wallet|when the creator lists it/i.test(JSON.stringify(traits)));
  const auction = escrowCardTraits(facts({ sale: "auction", endsAt: now + 3600 }));
  assert.deepEqual(chip(auction, "sale"), ["auction"]);
  assert.equal(chip(auction, "auction ends").length, 1);
});

test("burned: a chip only for a real burn of the paired coin, with the amount and the coin", () => {
  assert.equal(liveTitle.burned, undefined, "the live title's burned line was dropped at mint");
  assert.deepEqual(chip(escrowCardTraits(facts()), "burned"), [], "no coin: nothing burns, no chip");
  const coin = { name: "Pizza Coin", symbol: "PZC", mint: COIN };
  assert.deepEqual(chip(escrowCardTraits(facts({ coin, burn: { percent: 25, amount: "31,250", symbol: "PZC" } })), "burned"), ["31,250 PZC (25%)"]);
  assert.deepEqual(chip(escrowCardTraits(facts({ coin, burn: { percent: 0, amount: "0", symbol: "PZC" } })), "burned"), [], "0% burns nothing");
  assert.deepEqual(chip(escrowCardTraits(facts({ coin, burn: null })), "burned"), []);
  assert.deepEqual(chip(escrowCardTraits(facts({ burn: { percent: 25, amount: "1", symbol: "SOL" } })), "burned"), [], "never without a coin");
});

test("open line: no '0 is burned'; a burn names the amount and the coin", () => {
  assert.equal(
    escrowOpenLine({ price: "0.2 SOL", burned: "", fee: "0.004", payees: [], creator: "0.196" }),
    "The sale is open at 0.2 SOL. 0.004 goes to the PAR program and 0.196 goes to the creator.",
  );
  assert.equal(
    escrowOpenLine({ price: "4,000 PZC", burned: "1,000 PZC", fee: "80", payees: [], creator: "2,920" }),
    "The sale is open at 4,000 PZC. 1,000 PZC is burned, 80 goes to the PAR program, and 2,920 goes to the creator.",
  );
  assert.equal(
    escrowOpenLine({ price: "1 SOL", burned: "", fee: "0.02", payees: [{ amount: "0.5", wallet: "W" }], creator: "0.48" }),
    "The sale is open at 1 SOL. 0.02 goes to the PAR program, 0.5 goes to W, and 0.48 goes to the creator.",
  );
  assert.ok(!/\b0 is burned/.test(escrowOpenLine({ price: "0.2 SOL", burned: "", fee: "0.004", payees: [], creator: "0.196" })));
});

test("token line burn: a zero burn is not mentioned; a burn names the coin", () => {
  assert.equal(escrowBurnLine(0, "PZC"), "98% of the price goes to the creator and 2% goes to the PAR program.");
  assert.equal(escrowBurnLine(25, "PZC"), "25% of the price is burned in PZC, 73% goes to the creator, and 2% goes to the PAR program.");
});

test("ship advice: one venue per state", () => {
  assert.match(SHIP_ADVICE, /on a Tensor sale and on an escrow sale/, "the shared advice names both");
  assert.ok(!/Tensor/.test(shipAdvice("escrow")) && /on an escrow sale/.test(shipAdvice("escrow")));
  assert.ok(!/escrow/i.test(shipAdvice("tensor")) && /on a Tensor sale/.test(shipAdvice("tensor")));
  assert.equal(shipAdvice(null), SHIP_ADVICE, "not listed on either: as written");
});

test("sale opens: 'open now' only while live; the open time before; edition 1 of 1", () => {
  assert.deepEqual(chip(escrowCardTraits(facts()), "sale opens"), ["open now"]);
  assert.match(chip(escrowCardTraits(facts({ live: false, opensAt: now + 600 })), "sale opens")[0], /UTC$/);
  assert.deepEqual(chip(escrowCardTraits(facts({ live: false, opensAt: 0 })), "sale opens"), [], "no time on the listing, no chip");
  assert.deepEqual(
    chip(escrowCardTraits(facts({ live: false, opensAt: 0, coin: { symbol: "PZC", mint: COIN } })), "sale opens"),
    ["after the coin graduates"],
  );
  assert.deepEqual(chip(escrowCardTraits(facts()), "edition"), ["1 of 1"]);
  assert.deepEqual(chip(escrowCardTraits(facts({ editionOfOne: false })), "edition"), ["#1"]);
  assert.deepEqual(chip(escrowCardTraits(facts({ edition: null })), "edition"), []);
});

test("record facts: serial, maker, handoff, declared value when written; 'none' and blanks are left out", () => {
  const record = rows(
    recordAttributes({
      mint: WSOL, pool: "none", vault: key(), creator: key(), symbol: "SOL", quote: "SOL", par: "none", poolPrice: "none",
      handoffDays: "14 (GFD)", declared: "$500", sheetSha256: "0".repeat(64), imageSha256: "0".repeat(64), title: key(),
      titleHeldBy: "creator wallet", serial: "PZ-4CO-0001", makerName: "", coin: "none",
    }),
  );
  const traits = escrowCardTraits(facts({ recordAttributes: record }));
  assert.deepEqual(chip(traits, "serial"), ["PZ-4CO-0001"]);
  assert.deepEqual(chip(traits, "maker"), [], "maker was left blank, written 'none'");
  assert.deepEqual(chip(traits, "handoff"), ["14 days (GFD)"]);
  assert.deepEqual(chip(traits, "declared value"), ["$500"]);
});

test("no internal or account line becomes a chip", () => {
  const traits = escrowCardTraits(facts({ titleAttributes: rows(titleAttributes({ ...minted, rail: "escrow", program: key(), sale: "auction" })) }));
  for (const type of ["record", "mint", "pool", "creator", "sale page", "full sheet", "escrow program", "paid in", "coin", "auction"]) {
    assert.deepEqual(chip(traits, type), [], type);
  }
});

test("escrow sale line and the minted-for-Tensor test", () => {
  assert.ok(mintedForTensor(liveTitle));
  assert.ok(!mintedForTensor(rows(titleAttributes({ ...minted, rail: "escrow", program: key(), sale: "fixed" }))));
  assert.match(escrowSaleLine("fixed"), /PAR escrow program at one price/);
  assert.match(escrowSaleLine("auction"), /auctions this title \(NFT\) through the PAR escrow program/);
  assert.ok(!/tensor/i.test(escrowSaleLine("fixed") + escrowSaleLine("auction")));
});
