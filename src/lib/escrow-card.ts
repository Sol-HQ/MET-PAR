import { shortAddress } from "./format";
import { creatorSalePercent, goodFaithMark, railWords, SALE_PROGRAM_FEE_PERCENT, saleVenueWords, SHIP_ADVICE, type SaleMode } from "./title";

/** A Solana address, as the sale page checks it. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Every key the app writes on a title (titleAttributes in title.ts). Each is either rebuilt below from the escrow
 * listing and the chain, shown under Details, or internal (the version tag, links, hashes). None passes through as
 * written: a title minted for the Tensor route keeps Tensor words in these lines after it moves into the escrow.
 */
const TITLE_KEYS = new Set([
  "title",
  "full sheet",
  "coin",
  "mint",
  "sold through",
  "sale page",
  "record",
  "pool",
  "creator",
  "held by",
  "sale opens",
  "paid in",
  "burned",
  "escrow program",
  "sale",
  "auction",
  "sheet sha256",
  "image sha256",
]);

export type EscrowTrait = { type: string; value: string; address?: string };

/** What the escrow card's chips are built from. Every field is read on the page already; unknown ones stay empty. */
export type EscrowCardFacts = {
  /** The RWA's own name (see rwaName). Empty when the chain gave none. */
  name: string;
  edition: number | null;
  /** True when the title is edition 1 of a sealed collection of one (readTitle). */
  editionOfOne: boolean;
  /** The paired coin, or null when the record says no coin is attached. */
  coin: { name?: string; symbol?: string; mint: string } | null;
  /** The symbols of every token the escrow listing accepts. A listing names one price mint today. */
  soldIn: string[];
  sale: SaleMode;
  /**
   * What the escrow burns at the sale, or null when nothing is: the listing's percent, that amount of the price, and
   * the token burned (a burn is only ever of the paired coin).
   */
  burn: { percent: number; amount: string; symbol: string } | null;
  /** Unix seconds. opensAt is 0 until graduation is marked on the listing; endsAt is 0 until an auction's first bid. */
  opensAt: number;
  endsAt: number;
  now: number;
  /** True while a buyer can act now, as the page decides it. */
  live: boolean;
  /** The title's own attributes, for any line the app does not write itself. */
  titleAttributes: Record<string, string>;
  /** The record's attributes: the RWA's serial, maker, handoff days, and declared value live there. */
  recordAttributes: Record<string, string>;
};

/**
 * The RWA's name. The record NFT carries it as written; the title NFT is minted as "<name> title" (RecordCreate
 * titleName), so that suffix comes off only when the record name is not available.
 */
export function rwaName(recordName: string | null | undefined, titleName: string | null | undefined): string {
  const own = (recordName || "").trim();
  if (own) return own;
  const title = (titleName || "").trim();
  return title.endsWith(" title") ? title.slice(0, -" title".length).trim() : title;
}

/** The time the sale page prints, in UTC. */
function utc(seconds: number): string {
  return new Date(seconds * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC");
}

function coinWords(coin: NonNullable<EscrowCardFacts["coin"]>): EscrowTrait["value"] {
  const name = (coin.name || "").trim();
  const symbol = (coin.symbol || "").trim();
  if (name && symbol && name !== symbol) return `${name} (${symbol})`;
  return symbol || name || shortAddress(coin.mint);
}

/** A record line the creator filled in. The app writes "none" for one left blank. */
function recordLine(attributes: Record<string, string>, key: string): string {
  const value = (attributes[key] || "").trim();
  return value && value.toLowerCase() !== "none" ? value : "";
}

/**
 * The trait chips on the escrow card. Only called while the escrow listing account holds the title. Route chips come
 * from that listing, the name and coin from the record and the chain; nothing is filled in that the chain did not give.
 */
export function escrowCardTraits(facts: EscrowCardFacts): EscrowTrait[] {
  const chips: EscrowTrait[] = [];
  if (facts.name) chips.push({ type: "title", value: facts.name });
  if (facts.edition) chips.push({ type: "edition", value: facts.editionOfOne ? "1 of 1" : `#${facts.edition}` });
  chips.push(
    facts.coin
      ? { type: "coin pair", value: coinWords(facts.coin), address: facts.coin.mint }
      : { type: "coin pair", value: "none" },
  );
  const soldIn = facts.soldIn.map((symbol) => symbol.trim()).filter(Boolean);
  if (soldIn.length) chips.push({ type: "sold in", value: soldIn.join(", ") });
  chips.push({ type: "sold through", value: saleVenueWords("escrow") });
  chips.push({ type: "held by", value: "PAR escrow" });
  chips.push({ type: "sale", value: facts.sale === "auction" ? "auction" : "fixed price" });
  if (facts.live) chips.push({ type: "sale opens", value: "open now" });
  else if (facts.opensAt > 0) chips.push({ type: "sale opens", value: facts.now >= facts.opensAt ? `opened ${utc(facts.opensAt)}` : utc(facts.opensAt) });
  else if (facts.coin) chips.push({ type: "sale opens", value: "after the coin graduates" });
  if (facts.sale === "auction" && facts.endsAt > 0) {
    chips.push({ type: "auction ends", value: facts.now >= facts.endsAt ? `ended ${utc(facts.endsAt)}` : utc(facts.endsAt) });
  }
  // Only a real burn gets a chip: a paired coin, a percent above zero, and the amount in that coin.
  if (facts.coin && facts.burn && facts.burn.percent > 0 && facts.burn.amount) {
    chips.push({ type: "burned", value: `${facts.burn.amount} ${facts.burn.symbol} (${facts.burn.percent}%)` });
  }
  const serial = recordLine(facts.recordAttributes, "serial");
  if (serial) chips.push({ type: "serial", value: serial });
  const maker = recordLine(facts.recordAttributes, "maker");
  if (maker) chips.push({ type: "maker", value: maker });
  const handoff = recordLine(facts.recordAttributes, "handoff days");
  // The record writes "<days> (GFD)"; the sale page words that day count the same way everywhere.
  const days = handoff.match(/^(\d+)(?: \(GFD\))?$/)?.[1];
  if (handoff) chips.push({ type: "handoff", value: days ? goodFaithMark(days) : handoff });
  const declared = recordLine(facts.recordAttributes, "declared");
  if (declared) chips.push({ type: "declared value", value: declared });
  // A line the app does not write itself (none today) is shown as the title states it, when it is short and plain.
  for (const [key, raw] of Object.entries(facts.titleAttributes)) {
    const value = raw.trim();
    if (TITLE_KEYS.has(key) || !value || value.length > 48 || ADDRESS.test(value) || /^https?:\/\//.test(value)) continue;
    chips.push({ type: key, value });
  }
  return chips;
}

/** True when the title's own words say it was minted for the Tensor (creator wallet) route. */
export function mintedForTensor(attributes: Record<string, string>): boolean {
  return attributes["held by"] === railWords("creator") || attributes["sold through"] === saleVenueWords("creator");
}

/** How the escrow sells the title, in the words the site uses for the escrow path. Replaces a Tensor-route line. */
export function escrowSaleLine(sale: SaleMode): string {
  return sale === "auction"
    ? "The creator auctions this title (NFT) through the PAR escrow program. The bids run inside the program."
    : "The creator sells this title (NFT) through the PAR escrow program at one price. The first buyer to pay that price gets it.";
}

/** Shown above the creator's signed words when they were signed for the Tensor route and the title is now in escrow. */
export const SIGNED_FOR_TENSOR_NOTE =
  "These words were signed when the title was minted for a Tensor sale. The title has since been deposited into the PAR escrow, and the sale on this page runs through the escrow program.";

/**
 * The open fixed-price line in the escrow panel. Every amount is already formatted with the listing's token. The burn
 * part appears only when something is burned, and then names the token burned (the price token, which a burn requires
 * to be the paired coin); "0 is burned" is never said.
 */
export function escrowOpenLine(input: {
  price: string;
  /** "<amount> <symbol>", or empty when nothing is burned. */
  burned: string;
  fee: string;
  payees: { amount: string; wallet: string }[];
  creator: string;
}): string {
  const parts = [
    ...(input.burned ? [`${input.burned} is burned`] : []),
    `${input.fee} goes to the PAR program`,
    ...input.payees.map((row) => `${row.amount} goes to ${row.wallet}`),
    `${input.creator} goes to the creator`,
  ];
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts[parts.length - 1]}`;
  return `The sale is open at ${input.price}. ${listed.charAt(0).toUpperCase()}${listed.slice(1)}.`;
}

/** The split of an escrow sale on the token line. A zero burn is not mentioned; a burn names the coin burned. */
export function escrowBurnLine(burnPercent: number, coinSymbol: string): string {
  return burnPercent > 0
    ? `${burnPercent}% of the price is burned in ${coinSymbol}, ${creatorSalePercent(burnPercent)}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
    : `${creatorSalePercent(0)}% of the price goes to the creator and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`;
}

/**
 * The shipping advice on the sales page, about the one venue the title is listed on. The shared advice names both
 * venues; it stays as written wherever the title is not listed on one of them.
 */
export function shipAdvice(venue: "escrow" | "tensor" | null): string {
  const both = " on a Tensor sale and on an escrow sale";
  if (!venue || !SHIP_ADVICE.includes(both)) return SHIP_ADVICE;
  return SHIP_ADVICE.replace(both, venue === "escrow" ? " on an escrow sale" : " on a Tensor sale");
}
