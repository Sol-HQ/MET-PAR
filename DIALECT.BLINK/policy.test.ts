import assert from "node:assert/strict";
import test from "node:test";
import { isBlinkSaleOpen, textForBlink } from "./policy";

test("no-coin Tensor sale opens only for the exact creator-listing term", () => {
  assert.equal(isBlinkSaleOpen({ noCoin: true, saleOpens: "when the creator lists it", graduated: false, finishedAt: 0, nowSeconds: 1 }), true);
  assert.equal(isBlinkSaleOpen({ noCoin: true, saleOpens: "when listed", graduated: true, finishedAt: 1, nowSeconds: 1 }), false);
});

test("attached-coin sale requires graduation and the full signed delay", () => {
  const terms = { noCoin: false, saleOpens: "30 days after graduation", graduated: true, finishedAt: 1_000, nowSeconds: 1_000 + 30 * 86_400 };
  assert.equal(isBlinkSaleOpen({ ...terms, nowSeconds: terms.nowSeconds - 1 }), false);
  assert.equal(isBlinkSaleOpen(terms), true);
  assert.equal(isBlinkSaleOpen({ ...terms, graduated: false }), false);
  assert.equal(isBlinkSaleOpen({ ...terms, saleOpens: "0 days after graduation" }), false);
});

test("malformed or unknown gate data stays closed", () => {
  assert.equal(isBlinkSaleOpen({ noCoin: false, saleOpens: "30 days after graduation", graduated: null, finishedAt: 0, nowSeconds: 99_999_999 }), false);
  assert.equal(isBlinkSaleOpen({ noCoin: false, saleOpens: "999 days after graduation", graduated: true, finishedAt: 1, nowSeconds: 99_999_999 }), false);
});

test("Blink copy is whitespace-normalized and bounded", () => {
  assert.equal(textForBlink("  Asset\n  title  ", 32), "Asset title");
  assert.equal(textForBlink("abcdef", 3), "abc");
  assert.equal(textForBlink({ toString: () => "unsafe" }, 20), "");
});