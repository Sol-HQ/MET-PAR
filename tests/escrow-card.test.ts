/**
 * The escrow card's trait chips and sale line. Run: npx tsx --test tests/*.test.ts
 * A title minted for the Tensor route and later deposited into the PAR escrow must not show Tensor route words.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { escrowCardTraits, escrowSaleLine, mintedForEscrow, mintedForTensor, SALE_ROUTE_TRAITS } from "../src/lib/escrow-card";
import { titleAttributes, type TitleFacts } from "../src/lib/title";

const key = () => Keypair.generate().publicKey.toBase58();
const base: TitleFacts = {
  record: key(),
  mint: "So11111111111111111111111111111111111111112",
  pool: "none",
  creator: key(),
  rail: "creator",
  delayDays: 0,
  burnPercent: 0,
  venue: "https://www.meteora.surf/t/example?c=devnet",
  noCoin: true,
};
const attrs = (facts: TitleFacts) => Object.fromEntries(titleAttributes(facts).map((row) => [row.key, row.value]));
const chip = (rows: { type: string; value: string }[], type: string) => rows.filter((row) => row.type === type).map((row) => row.value);

test("escrow card: a title minted for Tensor, now in escrow, shows the escrow route only", () => {
  const minted = attrs(base);
  assert.equal(minted["sold through"], "Tensor marketplace program", "the fixture is the minted-for-Tensor case");
  assert.equal(minted["held by"], "creator wallet");
  assert.equal(minted.sale, "tensor");
  assert.equal(minted["sale opens"], "when the creator lists it");
  assert.ok(mintedForTensor(minted));
  assert.ok(!mintedForEscrow(minted));
  const traits = escrowCardTraits(minted, { sale: "fixed", burnPercent: 0 });
  const text = JSON.stringify(traits).toLowerCase();
  assert.ok(!text.includes("tensor"), `no Tensor words: ${text}`);
  assert.ok(!text.includes("creator wallet"));
  assert.ok(!text.includes("when the creator lists it"));
  assert.deepEqual(chip(traits, "sold through"), ["PAR escrow program"]);
  assert.deepEqual(chip(traits, "held by"), ["the PAR escrow"]);
  assert.deepEqual(chip(traits, "sale"), ["fixed price"]);
  assert.deepEqual(chip(traits, "sale opens"), []);
  // Descriptive lines stay as the title states them.
  assert.deepEqual(chip(traits, "title"), ["PAR title v1"]);
  assert.deepEqual(chip(traits, "coin"), ["none"]);
  assert.deepEqual(chip(traits, "paid in"), ["this token only"]);
  assert.deepEqual(chip(traits, "burned"), ["none: a title with no coin burns nothing"]);
  // Accounts and links are never chips.
  for (const type of ["record", "mint", "pool", "creator", "sale page", "escrow program"]) assert.deepEqual(chip(traits, type), []);
});

test("escrow card: an auction listing says auction", () => {
  const traits = escrowCardTraits(attrs(base), { sale: "auction", burnPercent: 0 });
  assert.deepEqual(chip(traits, "sale"), ["auction"]);
});

test("escrow card: a coin title minted for Tensor drops the creator-burn line for the listing's escrow burn", () => {
  const minted = attrs({ ...base, noCoin: false, pool: key(), burnPercent: 25 });
  assert.match(minted.burned, /by the creator within/);
  const traits = escrowCardTraits(minted, { sale: "fixed", burnPercent: 25 });
  assert.deepEqual(chip(traits, "burned"), ["25% by the escrow at the sale"]);
});

test("escrow card: a title minted for the escrow keeps its own burn line and no route duplicates", () => {
  const minted = attrs({ ...base, noCoin: false, pool: key(), rail: "escrow", burnPercent: 10, sale: "fixed", program: key() });
  assert.ok(mintedForEscrow(minted));
  const traits = escrowCardTraits(minted, { sale: "fixed", burnPercent: 10 });
  assert.deepEqual(chip(traits, "burned"), ["10% by the escrow at the sale"]);
  for (const type of ["sold through", "held by", "sale"]) assert.equal(chip(traits, type).length, 1, type);
});

test("escrow card: route keys are the ones the title is minted with", () => {
  const written = new Set(titleAttributes(base).map((row) => row.key));
  for (const route of ["sold through", "sale", "held by", "sale opens"]) {
    assert.ok(written.has(route), route);
    assert.ok(SALE_ROUTE_TRAITS.has(route), route);
  }
});

test("escrow sale line: escrow words, never Tensor", () => {
  assert.match(escrowSaleLine("fixed"), /PAR escrow program at one price/);
  assert.match(escrowSaleLine("auction"), /auctions this title \(NFT\) through the PAR escrow program/);
  assert.ok(!/tensor/i.test(escrowSaleLine("fixed") + escrowSaleLine("auction")));
});
