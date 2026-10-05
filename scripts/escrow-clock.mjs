/** Pure decisions for the escrow watcher. No network, no keys. */

export const LISTING_BYTES = 252;
export const AUCTION = 1;

export function readListingData(data) {
  if (!data || data.length < LISTING_BYTES) return null;
  const key = (at) => data.subarray(at, at + 32);
  const highBid = data.readBigUInt64LE(236);
  return {
    asset: key(40),
    pool: key(136),
    mint: key(104),
    creator: key(8),
    graduatedAt: Number(data.readBigInt64LE(192)),
    sale: data[202] === AUCTION ? "auction" : "fixed",
    highBidder: highBid > 0n ? key(204) : null,
    highBid,
    endsAt: Number(data.readBigInt64LE(244)),
  };
}

/** The clock has ended and a high bidder is waiting. The watcher must finish this one. */
export function needsSettle(listing, now) {
  return Boolean(listing) && listing.sale === "auction" && listing.endsAt > 0 && listing.highBid > 0n && now >= listing.endsAt;
}

/** The pool may have graduated and nobody has marked it yet. */
export function needsGraduationMark(listing) {
  return Boolean(listing) && listing.graduatedAt === 0;
}
