import assert from "node:assert/strict";
import { needsGraduationMark, needsSettle, readListingData, LISTING_BYTES } from "./escrow-clock.mjs";

const data = Buffer.alloc(LISTING_BYTES);
data.writeBigInt64LE(0n, 192);
data[202] = 1;
data.writeBigUInt64LE(5n, 236);
data.writeBigInt64LE(1_000n, 244);
const listing = readListingData(data);

assert.equal(needsSettle(listing, 999), false);
assert.equal(needsSettle(listing, 1000), true);
assert.equal(needsGraduationMark(listing), true);

data.writeBigInt64LE(50n, 192);
const graduated = readListingData(data);
assert.equal(needsGraduationMark(graduated), false);

data[202] = 0;
const fixed = readListingData(data);
assert.equal(needsSettle(fixed, 5_000), false);

data[202] = 1;
data.writeBigUInt64LE(0n, 236);
const noBid = readListingData(data);
assert.equal(needsSettle(noBid, 5_000), false);
assert.equal(readListingData(Buffer.alloc(200)), null);

console.log("escrow clock checks passed");
