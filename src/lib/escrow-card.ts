import { railWords, saleVenueWords, type SaleMode } from "./title";

/** A Solana address, as the sale page checks it. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Title attributes that are accounts, links, or long terms. They show under Details or the meta sheet, not as traits. */
const NOT_TRAITS = new Set(["record", "mint", "pool", "creator", "full sheet", "sale page", "sheet sha256", "escrow program", "auction"]);

/**
 * Title attributes that say how the title was minted to sell: the venue, the holder, and when that sale opens. A title
 * minted for the creator-wallet (Tensor) route can later be deposited into the PAR escrow, and then these words no
 * longer describe the sale. On the escrow card the listing account says how it sells, so these are left out.
 */
export const SALE_ROUTE_TRAITS = new Set(["sold through", "sale", "held by", "title held by", "sale opens"]);

export type EscrowCardListing = { sale: SaleMode; burnPercent: number };

/** True when the title's own words say it was minted for the escrow, so its route and burn lines match the escrow. */
export function mintedForEscrow(attributes: Record<string, string>): boolean {
  return attributes["held by"] === railWords("escrow");
}

/** True when the title's own words say it was minted for the Tensor (creator wallet) route. */
export function mintedForTensor(attributes: Record<string, string>): boolean {
  return attributes["held by"] === railWords("creator") || attributes["sold through"] === saleVenueWords("creator");
}

/**
 * The trait chips on the escrow card. Only called while the escrow listing account holds the title, so the route
 * chips are read from that listing, never from the words the title was minted with.
 */
export function escrowCardTraits(attributes: Record<string, string>, listing: EscrowCardListing): { type: string; value: string }[] {
  const ownBurn = mintedForEscrow(attributes) || attributes.coin === "none";
  const kept = Object.entries(attributes)
    .filter(([key]) => !NOT_TRAITS.has(key) && !SALE_ROUTE_TRAITS.has(key) && (key !== "burned" || ownBurn))
    .filter(([, value]) => value.trim() && value.length <= 48 && !ADDRESS.test(value) && !/^https?:\/\//.test(value))
    .map(([type, value]) => ({ type, value: value.trim() }));
  return [
    ...kept,
    { type: "sold through", value: saleVenueWords("escrow") },
    { type: "held by", value: "the PAR escrow" },
    { type: "sale", value: listing.sale === "auction" ? "auction" : "fixed price" },
    ...(ownBurn ? [] : [{ type: "burned", value: `${listing.burnPercent}% by the escrow at the sale` }]),
  ];
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
