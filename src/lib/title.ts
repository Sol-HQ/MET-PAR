import { create, createCollection, fetchAsset, fetchCollection, mplCore, updateCollection, updateV2 } from "@metaplex-foundation/mpl-core";
import { createNoopSigner, createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type Keypair } from "@solana/web3.js";
import { isAdminWallet, PLATFORM_FEE_CLAIMER } from "./admins";
import type { ClusterName } from "./constants";
import { CORE_PROGRAM_ID, PUBLIC_ORIGIN, type RecordAttribute } from "./record";

export const TITLE_KIND = "PAR title v1";

/** The coin, stated the same way on the sheet, the promises, and the pages. */
export const COIN_WORDS =
  "The coin is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share, and it pays nothing.";

/** Where a new title goes. "creator": the creator's wallet, bound by the signed sheet. "escrow": the PAR escrow program. */
export type TitleRail = "creator" | "escrow";
export const TITLE_RAIL: Record<ClusterName, TitleRail> = {
  devnet: "creator",
  "mainnet-beta": "creator",
};

/** The escrow program. The practice program uses a one-second day so a test can finish. The real network is empty until its own program is deployed. */
export const ESCROW_PROGRAM: Record<ClusterName, string> = {
  devnet: "FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF",
  "mainnet-beta": "",
};

export const SALE_DELAY_DAYS = 30;
export const SALE_DAY_PRESETS = [10, 30, 60, 90] as const;
/** On the creator path the burn is the creator's own act after the sale. */
export const CREATOR_BURN_DAYS = 7;
/** Burned at the sale. The creator chooses this when the title is deposited. 25 is the current setting. */
export const SALE_BURN_PERCENT = 25;
/** Kept by the escrow program on every sale. The creator cannot change this. */
export const SALE_PROGRAM_FEE_PERCENT = 2;
/** The auction clock, in hours. It starts on the first bid at or above the reserve. */
export const AUCTION_HOURS = 72;
/** A bid in the last hour moves the end to this many hours after that bid. */
export const AUCTION_EXTEND_HOURS = 1;
/** With no bid, the creator cannot take the title back until this many days after the sale opens. */
export const AUCTION_SIT_DAYS = 60;
export type SaleMode = "fixed" | "auction";

/** The creator's percent of the sale price after the burn they chose and the program's 2%. */
export function creatorSalePercent(burnPercent = SALE_BURN_PERCENT): number {
  return 100 - SALE_PROGRAM_FEE_PERCENT - burnPercent;
}

/** The one place the title will be listed for sale. Named in the sheet before the title exists. */
export function saleUrl(title: string, cluster: ClusterName): string {
  return `${PUBLIC_ORIGIN}${salePath(title, cluster)}`;
}

export function salePath(title: string, cluster: ClusterName): string {
  return `/t/${title}${cluster === "devnet" ? "?c=devnet" : ""}`;
}

/** The marketplace list. The query names the network so a fresh page does not open on the practice network. */
export function poolsPath(cluster: ClusterName): string {
  return `/pools?c=${cluster === "devnet" ? "devnet" : "mainnet"}`;
}

/** Practice pool links stay bare. A real-network link names the network so a fresh page loads that pool. */
export function poolPath(pool: string, cluster: ClusterName): string {
  return `/pool/${pool}${cluster === "devnet" ? "" : "?c=mainnet"}`;
}

export function railFor(cluster: ClusterName): TitleRail {
  return TITLE_RAIL[cluster] === "escrow" && ESCROW_PROGRAM[cluster] ? "escrow" : "creator";
}

/** The escrow is a practice-network choice. The real network stays on the creator wallet and Tensor. */
export function escrowOffered(cluster: ClusterName): boolean {
  return cluster === "devnet" && Boolean(ESCROW_PROGRAM.devnet);
}

/** A deposit is allowed only on the practice network, and only from a platform wallet. */
export function escrowDepositAllowed(cluster: ClusterName, wallet: string | null | undefined): boolean {
  return escrowOffered(cluster) && isAdminWallet(wallet);
}

/** Shown wherever both paths are named. The escrow button is visible and does not click. */
export const ESCROW_COMING = "(The escrow path is not a mainnet option yet. Coming soon.)";

/** The whole escrow path, in one line. It is not a Solana Mainnet option yet. */
export const ESCROW_PATH = `The PAR escrow path is not live on Solana Mainnet. When it is, the title sits in that program. The sale is a fixed price or an auction, the bids run inside the program, and the burn happens in the program at the sale. The burn is a whole percent from 0% to 98%. The program keeps ${SALE_PROGRAM_FEE_PERCENT}%.`;

/** The route a new title will actually use. Mainnet ignores an escrow pick. */
export function chosenRail(cluster: ClusterName, hold: "wallet" | "escrow"): TitleRail {
  return escrowOffered(cluster) && hold === "escrow" ? "escrow" : "creator";
}

export function railWords(rail: TitleRail): string {
  return rail === "escrow" ? "escrow program" : "creator wallet";
}

/** The same holder, read from whichever NFT still carries the line. Two different lines is no agreement. */
export function agreedHolder(recordHolder: string | undefined, titleHolder: string | undefined): TitleRail | null {
  if (recordHolder && titleHolder && recordHolder !== titleHolder) return null;
  const value = titleHolder || recordHolder || "";
  if (value === "escrow program") return "escrow";
  if (value === "creator wallet") return "creator";
  return null;
}

/** The same creator, read from whichever NFT still carries the address. Two different addresses is no agreement. */
export function agreedCreator(recordCreator: string | undefined, titleCreator: string | undefined): string {
  if (recordCreator && titleCreator && recordCreator !== titleCreator) return "";
  return recordCreator || titleCreator || "";
}

export function saleVenueWords(rail: TitleRail): string {
  return rail === "escrow" ? "PAR escrow program" : "Tensor marketplace program";
}

/** The day count, labeled. GFD is the good faith delivery date. */
export function goodFaithMark(days: string | number): string {
  const count = String(days).trim();
  return `${count} ${count === "1" ? "day" : "days"} (GFD)`;
}

/** What the day count means. Shown to the seller before signing and to the buyer on the sale page. */
export function goodFaithDelivery(days: string | number): string {
  return `${goodFaithMark(days)} is a good faith delivery date. By that day the maker does their best to put the object in the mail, with a shipper, or in the holder's hands. Time with the carrier or customs does not count. The maker still owes the holder the object.`;
}

/** The creator signs these words with the wallet, and the signature goes into the sheet. */
export function creatorPromises(input: {
  rail: TitleRail;
  delayDays: number;
  burnPercent: number;
  handoffDays: string;
  sale?: SaleMode;
  /** Practice program only. Each entered day is one second on chain. */
  shortClock?: boolean;
  /** False when this title has no coin. The price token is named in paySymbol. */
  attached?: boolean;
  paySymbol?: string;
}): string[] {
  const escrow = input.rail === "escrow";
  const auction = escrow && input.sale === "auction";
  const attached = input.attached !== false;
  const pay = input.paySymbol || "this token";
  const waitUnit = input.shortClock ? "seconds" : "days";
  const bidClock = input.shortClock ? "72-second" : `${AUCTION_HOURS}-hour`;
  const extend = input.shortClock ? "1 second" : `${AUCTION_EXTEND_HOURS} hour`;
  const sit = input.shortClock ? "60 seconds" : `${AUCTION_SIT_DAYS} days`;
  const reclaim = input.shortClock ? "365 seconds" : "a year";
  return [
    "I own the item on this record sheet, or I have the right to sell it, and it is as described.",
    "The title is the one claim to the item. Whoever holds the title can claim the item from me.",
    escrow
      ? auction
        ? `The title is auctioned only through the PAR escrow program, only for this token. The auction can open ${input.delayDays} ${waitUnit} after the token graduates. The first bid at or above the reserve starts a ${bidClock} clock. A bid in the last ${input.shortClock ? "second" : "hour"} moves the end to ${extend} after that bid. PAR platform finishes it when the clock ends.`
        : `The title is sold only through the PAR escrow program, only for this token, once the sale opens ${input.delayDays} ${waitUnit} after the token graduates. The first person to pay the price gets it.`
      : attached
        ? `I will list the title through Tensor's marketplace program, priced only in ${pay}, and not before the sale opens ${input.delayDays} days after the token graduates. The listing may also show on Tensor's own site.`
        : `I will list this title on its PAR sale page through Tensor's marketplace program, at one price in ${pay}. A buyer pays that price.`,
    escrow
      ? `At the sale, ${input.burnPercent}% of the price is burned by the escrow, ${creatorSalePercent(input.burnPercent)}% is paid to me, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
      : attached
        ? `Tensor pays me the full price. Within ${CREATOR_BURN_DAYS} days of the sale I will burn ${input.burnPercent}% of it and keep the rest.`
        : "Tensor pays me the full price. PAR takes none of that sale. If I burn any of that price, the burn is my own promise.",
    `The ${goodFaithMark(input.handoffDays)} after the claim is a good faith delivery date. By that day I will do my best to put the item in the mail, with a shipper, or in the holder's hands. Time with the carrier or customs does not count. I still owe the holder the item.`,
    escrow
      ? auction
        ? `The title waits in the PAR escrow program. If nobody bids, it stays there. I can take it back ${sit} after the sale could open, and it does not come back on its own. Once a bid starts, I cannot take it back.`
        : `The title waits in the PAR escrow program until it is sold. If it never sells, it returns to me ${reclaim} after the sale could open.`
      : "Until the sale, the title stays in my wallet or in my Tensor listing. I will not sell, move, lend, or burn it any other way. Doing so breaks my word.",
    attached
      ? "The token is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share of the item, and it pays nothing."
      : `The buyer pays for this title in ${pay}. That payment buys the title.`,
    "If I break these promises, I alone am responsible. PAR is software. It does not hold, insure, or guarantee the item. The NFT on the chain is the proof. PAR keeps a copy of the proofs.",
  ];
}

export function promiseMessage(input: { promises: string[]; record: string; title: string; mint: string; creator: string }): string {
  return [
    "PAR creator promise",
    `Creator: ${input.creator}`,
    `Record: ${input.record}`,
    `Title: ${input.title}`,
    `Token: ${input.mint}`,
    ...input.promises.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

export type TitleFacts = {
  record: string;
  mint: string;
  pool: string;
  creator: string;
  rail: TitleRail;
  delayDays: number;
  burnPercent: number;
  venue: string;
  /** Set on the escrow path. The program address is written on the title. */
  program?: string;
  sale?: SaleMode;
  /** Practice program only. The entered number is seconds on chain. */
  shortClock?: boolean;
  /** Readable sheet page. Written on every title. */
  sheet?: string;
  /** False when the title has no coin and the mint is only the price token. */
  noCoin?: boolean;
};

export function titleAttributes(facts: TitleFacts): RecordAttribute[] {
  const escrow = facts.rail === "escrow";
  const auction = escrow && facts.sale === "auction";
  const rows: RecordAttribute[] = [
    { key: "title", value: TITLE_KIND },
    ...(facts.sheet ? [{ key: "full sheet", value: facts.sheet }] : []),
    { key: "coin", value: facts.noCoin ? "none" : "attached" },
    { key: "mint", value: facts.mint },
    { key: "sold through", value: saleVenueWords(facts.rail) },
    { key: "sale page", value: facts.venue },
    { key: "record", value: facts.record },
    { key: "pool", value: facts.pool },
    { key: "creator", value: facts.creator },
    { key: "held by", value: railWords(facts.rail) },
    { key: "sale opens", value: facts.noCoin ? "when the creator lists it" : `${facts.delayDays} ${facts.shortClock ? "seconds" : "days"} after graduation` },
    { key: "paid in", value: "this token only" },
    { key: "burned", value: facts.noCoin ? "the creator's own promise, if the creator burns any of the price" : escrow ? `${facts.burnPercent}% by the escrow at the sale` : `${facts.burnPercent}% by the creator within ${CREATOR_BURN_DAYS} days` },
    { key: "escrow program", value: escrow && facts.program ? facts.program : "none" },
    { key: "sale", value: facts.noCoin ? "tensor" : auction ? "auction" : escrow ? "fixed price" : "tensor" },
  ];
  if (auction) {
    rows.push({
      key: "auction",
      value: facts.shortClock
        ? "72 seconds after the first bid at the reserve. A bid in the last second extends 1 second. Sits 60 seconds if no bid. PAR platform finishes it when the clock ends."
        : `${AUCTION_HOURS} hours after the first bid at the reserve. A bid in the last hour extends ${AUCTION_EXTEND_HOURS} hour. Sits ${AUCTION_SIT_DAYS} days if no bid. PAR platform finishes it when the clock ends.`,
    });
  }
  return rows;
}

/**
 * The collection's update authority after the title is minted. It is an address off the curve, so no key exists for it
 * and nothing can ever be added to the collection, changed on it, or changed on the title again.
 */
export function sealedAuthority(collection: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("par sealed"), collection.toBuffer()], new PublicKey(CORE_PROGRAM_ID))[0];
}

/**
 * The master edition: a Core collection carrying the Master Edition plugin, max supply 1. The creator holds its update
 * authority only until the title is minted into it; `titleInstructions` seals it in that same transaction.
 */
export function editionCollectionInstructions(input: {
  endpoint: string;
  collection: Keypair;
  creator: PublicKey;
  name: string;
  uri: string;
}): TransactionInstruction[] {
  const umi = createUmi(input.endpoint).use(mplCore());
  const creator = createNoopSigner(umiKey(input.creator.toBase58()));
  umi.use(signerIdentity(creator));
  const builder = createCollection(umi, {
    collection: createSignerFromKeypair(umi, fromWeb3JsKeypair(input.collection)),
    name: input.name,
    uri: input.uri,
    updateAuthority: creator.publicKey,
    payer: creator,
    plugins: [{ type: "MasterEdition", maxSupply: 1, authority: { type: "None" } }],
  });
  return builder.getInstructions().map((instruction) => toWeb3JsInstruction(instruction));
}

/**
 * The title, the one edition of the record that can be sold. The creator owns it.
 *
 * With `collection` (made by `editionCollectionInstructions`): the title is minted into it as Edition 1, then the
 * collection is handed to `sealedAuthority` in the same transaction. Core does not enforce edition numbers; the sealed
 * collection, with exactly one asset ever minted into it, is what keeps the title the only one.
 *
 * Without `collection` (the escrow path, whose program takes no collection account): a standalone Core asset whose
 * update authority is set to None. ImmutableMetadata is left off: it would block setting the update authority to None.
 */
export function titleInstructions(input: {
  endpoint: string;
  asset: Keypair;
  collection?: PublicKey;
  creator: PublicKey;
  name: string;
  uri: string;
  attributes: RecordAttribute[];
}): TransactionInstruction[] {
  const umi = createUmi(input.endpoint).use(mplCore());
  const creator = createNoopSigner(umiKey(input.creator.toBase58()));
  umi.use(signerIdentity(creator));
  const asset = createSignerFromKeypair(umi, fromWeb3JsKeypair(input.asset));
  if (input.collection) {
    const collection = umiKey(input.collection.toBase58());
    const builder = create(umi, {
      asset,
      collection: { publicKey: collection },
      name: input.name,
      uri: input.uri,
      owner: creator.publicKey,
      payer: creator,
      authority: creator,
      plugins: [
        { type: "Attributes", attributeList: input.attributes, authority: { type: "None" } },
        { type: "Edition", number: 1, authority: { type: "None" } },
      ],
    }).add(
      updateCollection(umi, {
        collection,
        payer: creator,
        authority: creator,
        newUpdateAuthority: umiKey(sealedAuthority(input.collection).toBase58()),
      }),
    );
    return builder.getInstructions().map((instruction) => toWeb3JsInstruction(instruction));
  }
  const builder = create(umi, {
    asset,
    name: input.name,
    uri: input.uri,
    owner: creator.publicKey,
    updateAuthority: creator.publicKey,
    payer: creator,
    authority: creator,
    plugins: [{ type: "Attributes", attributeList: input.attributes, authority: { type: "None" } }],
  }).add(
    updateV2(umi, {
      asset: asset.publicKey,
      payer: creator,
      authority: creator,
      newUpdateAuthority: { __kind: "None" },
    }),
  );
  return builder.getInstructions().map((instruction) => toWeb3JsInstruction(instruction));
}

const DEPOSIT = Uint8Array.from([242, 35, 198, 137, 82, 225, 242, 182]);
const DEPOSIT_OPEN = Uint8Array.from([118, 120, 19, 252, 170, 126, 182, 49]);
const MARK_GRADUATED = Uint8Array.from([125, 72, 57, 129, 59, 15, 247, 251]);
const BUY = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BID = Uint8Array.from([199, 56, 85, 38, 146, 243, 37, 158]);
const SET_PRICE = Uint8Array.from([16, 19, 182, 8, 149, 83, 72, 181]);

function requirePracticeProgram(program: PublicKey) {
  if (!ESCROW_PROGRAM.devnet || program.toBase58() !== ESCROW_PROGRAM.devnet) {
    throw new Error("The escrow path is not available on this network.");
  }
}

export function listingAddress(title: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("listing"), title.toBuffer()], program)[0];
}

/** Moves the title into the escrow. Price is in the token's smallest unit. `burnPercent` is a whole percent from 0 to 98. */
export function escrowDepositInstruction(input: {
  program: PublicKey;
  creator: PublicKey;
  title: PublicKey;
  record: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  price: bigint;
  delayDays: number;
  burnPercent: number;
  sale?: SaleMode;
}): TransactionInstruction {
  requirePracticeProgram(input.program);
  if (!Number.isInteger(input.burnPercent) || input.burnPercent < 0 || input.burnPercent > 98) {
    throw new Error("The burn has to be a whole percent from 0 to 98.");
  }
  const data = new Uint8Array(21);
  data.set(DEPOSIT, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, input.price, true);
  view.setUint16(16, input.delayDays, true);
  view.setUint16(18, input.burnPercent * 100, true);
  data[20] = input.sale === "auction" ? 1 : 0;
  return new TransactionInstruction({
    programId: input.program,
    data: Buffer.from(data),
    keys: [
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: input.title, isSigner: false, isWritable: true },
      { pubkey: input.record, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.pool, isSigner: false, isWritable: false },
      { pubkey: listingAddress(input.title, input.program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(CORE_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export type SalePayout = { wallet: PublicKey; amount: bigint };

/** A title with no coin. The mint must be an ordinary SPL token. Up to three fixed payouts, then the rest to the creator. */
export function escrowDepositOpenInstruction(input: {
  program: PublicKey;
  creator: PublicKey;
  title: PublicKey;
  record: PublicKey;
  mint: PublicKey;
  price: bigint;
  delayDays: number;
  burnPercent: number;
  sale?: SaleMode;
  payouts?: SalePayout[];
}): TransactionInstruction {
  requirePracticeProgram(input.program);
  if (!Number.isInteger(input.delayDays) || input.delayDays < 0 || input.delayDays > 365) {
    throw new Error("The wait is a whole number from 0 to 365 days. Zero opens the sale now.");
  }
  if (!Number.isInteger(input.burnPercent) || input.burnPercent < 0 || input.burnPercent > 98) {
    throw new Error("The burn has to be a whole percent from 0 to 98.");
  }
  const payouts = input.payouts ?? [];
  if (payouts.length > 3) throw new Error("Name at most three extra wallets.");
  const wallets = [PublicKey.default, PublicKey.default, PublicKey.default];
  const amounts = [BigInt(0), BigInt(0), BigInt(0)];
  payouts.forEach((payout, index) => {
    wallets[index] = payout.wallet;
    amounts[index] = payout.amount;
  });
  const data = new Uint8Array(8 + 8 + 2 + 2 + 1 + 32 * 3 + 8 * 3);
  data.set(DEPOSIT_OPEN, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, input.price, true);
  view.setUint16(16, input.delayDays, true);
  view.setUint16(18, input.burnPercent * 100, true);
  data[20] = input.sale === "auction" ? 1 : 0;
  let at = 21;
  for (const wallet of wallets) {
    data.set(wallet.toBytes(), at);
    at += 32;
  }
  for (const amount of amounts) {
    view.setBigUint64(at, amount, true);
    at += 8;
  }
  const title = input.title;
  return new TransactionInstruction({
    programId: input.program,
    data: Buffer.from(data),
    keys: [
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: title, isSigner: false, isWritable: true },
      { pubkey: input.record, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: listingAddress(title, input.program), isSigner: false, isWritable: true },
      { pubkey: payoutAddress(title, input.program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(CORE_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function payoutAddress(title: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("payout"), title.toBuffer()], program)[0];
}

/** The creator changes the price. On an auction this is the reserve, and it stays put once a bid is in. */
export function escrowSetPriceInstruction(input: { program: PublicKey; creator: PublicKey; title: PublicKey; price: bigint }): TransactionInstruction {
  requirePracticeProgram(input.program);
  if (input.price <= BigInt(0)) throw new Error("The price has to be above zero.");
  return new TransactionInstruction({
    programId: input.program,
    data: escrowAmount(SET_PRICE, input.price),
    keys: [
      { pubkey: input.creator, isSigner: true, isWritable: false },
      { pubkey: listingAddress(input.title, input.program), isSigner: false, isWritable: true },
    ],
  });
}

export function markGraduatedInstruction(program: PublicKey, title: PublicKey, pool: PublicKey): TransactionInstruction {
  requirePracticeProgram(program);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(MARK_GRADUATED),
    keys: [
      { pubkey: listingAddress(title, program), isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
    ],
  });
}

function escrowAmount(disc: Uint8Array, amount: bigint): Buffer {
  const data = new Uint8Array(16);
  data.set(disc, 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);
  return Buffer.from(data);
}

/** Pays the listed price. The program burns the listing's share, keeps 2%, and sends the title to the buyer. */
export function escrowBuyInstruction(input: {
  program: PublicKey;
  buyer: PublicKey;
  creator: PublicKey;
  title: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  price: bigint;
  payees?: PublicKey[];
}): TransactionInstruction {
  requirePracticeProgram(input.program);
  const treasury = new PublicKey(PLATFORM_FEE_CLAIMER);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(input.mint, owner, true, input.tokenProgram);
  const payees = input.payees ?? [];
  return new TransactionInstruction({
    programId: input.program,
    data: escrowAmount(BUY, input.price),
    keys: [
      { pubkey: input.buyer, isSigner: true, isWritable: true },
      { pubkey: input.creator, isSigner: false, isWritable: true },
      { pubkey: listingAddress(input.title, input.program), isSigner: false, isWritable: true },
      { pubkey: input.title, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: true },
      { pubkey: ata(input.buyer), isSigner: false, isWritable: true },
      { pubkey: ata(input.creator), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: ata(treasury), isSigner: false, isWritable: true },
      { pubkey: input.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CORE_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(payees.length
        ? [
            { pubkey: payoutAddress(input.title, input.program), isSigner: false, isWritable: false },
            ...payees.map((payee) => ({ pubkey: ata(payee), isSigner: false, isWritable: true })),
          ]
        : []),
    ],
  });
}

/** Bids at or above the reserve. The coins stay in the escrow until the clock ends. */
export function escrowBidInstruction(input: {
  program: PublicKey;
  bidder: PublicKey;
  title: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  previousBidder: PublicKey | null;
}): TransactionInstruction {
  requirePracticeProgram(input.program);
  const listing = listingAddress(input.title, input.program);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(input.mint, owner, true, input.tokenProgram);
  return new TransactionInstruction({
    programId: input.program,
    data: escrowAmount(BID, input.amount),
    keys: [
      { pubkey: input.bidder, isSigner: true, isWritable: true },
      { pubkey: listing, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: true },
      { pubkey: ata(input.bidder), isSigner: false, isWritable: true },
      { pubkey: ata(listing), isSigner: false, isWritable: true },
      { pubkey: ata(input.previousBidder ?? input.bidder), isSigner: false, isWritable: true },
      { pubkey: input.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export type Listing = {
  creator: string;
  title: string;
  record: string;
  mint: string;
  pool: string;
  price: bigint;
  delaySeconds: number;
  depositedAt: number;
  graduatedAt: number;
  burnPercent: number;
  sale: SaleMode;
  highBidder: string | null;
  highBid: bigint;
  endsAt: number;
};

export async function readListing(connection: Connection, program: PublicKey, title: PublicKey): Promise<Listing | null> {
  const info = await connection.getAccountInfo(listingAddress(title, program), "confirmed");
  if (!info || !info.owner.equals(program) || info.data.length < 252) return null;
  const data = info.data;
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32)).toBase58();
  const highBid = data.readBigUInt64LE(236);
  const highBidder = key(204);
  return {
    creator: key(8),
    title: key(40),
    record: key(72),
    mint: key(104),
    pool: key(136),
    price: data.readBigUInt64LE(168),
    delaySeconds: Number(data.readBigInt64LE(176)),
    depositedAt: Number(data.readBigInt64LE(184)),
    graduatedAt: Number(data.readBigInt64LE(192)),
    burnPercent: data.readUInt16LE(200) / 100,
    sale: data[202] === 1 ? "auction" : "fixed",
    highBidder: highBid > BigInt(0) ? highBidder : null,
    highBid,
    endsAt: Number(data.readBigInt64LE(244)),
  };
}

export async function readPayouts(connection: Connection, program: PublicKey, title: PublicKey): Promise<{ wallet: string; amount: bigint }[]> {
  const info = await connection.getAccountInfo(payoutAddress(title, program), "confirmed");
  if (!info || info.data.length < 8 + 96 + 24) return [];
  const rows: { wallet: string; amount: bigint }[] = [];
  for (let i = 0; i < 3; i += 1) {
    const amount = info.data.readBigUInt64LE(8 + 96 + i * 8);
    if (amount === BigInt(0)) break;
    rows.push({ wallet: new PublicKey(info.data.subarray(8 + i * 32, 8 + (i + 1) * 32)).toBase58(), amount });
  }
  return rows;
}

/** Tensor's marketplace program. Its Core listings can be priced in any SPL token, and it holds the NFT while listed. */
export const TENSOR_MARKETPLACE = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp";
const TENSOR_LIST_DISCRIMINATOR = [78, 242, 89, 138, 161, 221, 176, 75];
/** Tensor adds this fee on the buyer's side. Measured on the practice network: a 1.0 listing cost the buyer 1.02. */
export const TENSOR_TAKER_FEE_PERCENT = 2;

export function tensorListAddress(title: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("list_state"), title.toBuffer()], new PublicKey(TENSOR_MARKETPLACE))[0];
}

export type TensorListing = { address: string; seller: string; amount: bigint; currency: string | null };

export async function readTensorListing(connection: Connection, title: PublicKey): Promise<TensorListing | null> {
  const key = tensorListAddress(title);
  const info = await connection.getAccountInfo(key, "confirmed");
  if (!info || info.owner.toBase58() !== TENSOR_MARKETPLACE || info.data.length < 115) return null;
  const data = info.data;
  if (!TENSOR_LIST_DISCRIMINATOR.every((byte, index) => data[index] === byte)) return null;
  if (!new PublicKey(data.subarray(42, 74)).equals(title)) return null;
  return {
    address: key.toBase58(),
    seller: new PublicKey(data.subarray(10, 42)).toBase58(),
    amount: data.readBigUInt64LE(74),
    currency: data[82] === 1 ? new PublicKey(data.subarray(83, 115)).toBase58() : null,
  };
}

export type TitleCheck = { label: string; ok: boolean };

export type TitleStatus = {
  address: string;
  rail: TitleRail | null;
  owner: string;
  name: string;
  sheet: string;
  listing: string | null;
  creator: string;
  collection: string | null;
  tensor: TensorListing | null;
  checks: TitleCheck[];
  ok: boolean;
};

/** Everything a buyer can confirm about the title from the record's own attributes and the chain. */
export async function titleStatus(
  endpoint: string,
  cluster: ClusterName,
  record: { address: string; attributes: Record<string, string> },
): Promise<TitleStatus | null> {
  const address = record.attributes.title;
  if (!address) return null;
  const read = await readTitle(endpoint, address);
  const rail = agreedHolder(record.attributes["title held by"], read.attributes["held by"]);
  const creator = agreedCreator(record.attributes.creator, read.attributes.creator);
  const program = ESCROW_PROGRAM[cluster];
  const listing = rail === "escrow" && program ? listingAddress(new PublicKey(address), new PublicKey(program)).toBase58() : null;
  const tensor =
    rail === "creator" && read.exists && read.owner === tensorListAddress(new PublicKey(address)).toBase58()
      ? await readTensorListing(new Connection(endpoint, "confirmed"), new PublicKey(address)).catch(() => null)
      : null;
  const listedByCreator = Boolean(tensor) && tensor?.seller === creator;
  const holderOk =
    rail === "escrow"
      ? Boolean(listing) && read.owner === listing
      : rail === "creator" && Boolean(creator) && (read.owner === creator || listedByCreator);
  const recordHolder = record.attributes["title held by"] || "";
  const titleHolder = read.attributes["held by"] || "";
  const recordCreator = record.attributes.creator || "";
  const titleCreator = read.attributes.creator || "";
  const checks: TitleCheck[] = [
    { label: "The title exists on chain", ok: read.exists },
    {
      label: "The title names this record and token",
      ok: read.attributes.title === TITLE_KIND && read.attributes.record === record.address && read.attributes.mint === record.attributes.mint,
    },
    recordHolder && titleHolder
      ? { label: "The record and the title name the same holder", ok: recordHolder === titleHolder }
      : { label: "The title names who holds it", ok: rail !== null },
    recordCreator && titleCreator
      ? { label: "The record and the title name the same creator", ok: recordCreator === titleCreator }
      : { label: "The title names the creator", ok: Boolean(creator) },
    { label: "Nobody can change the title", ok: read.locked },
    { label: "No plugin lets anyone else move, burn, or freeze it", ok: read.clean },
    {
      label:
        rail === "escrow"
          ? "The escrow holds the title"
          : tensor
            ? "The creator listed the title on Tensor"
            : "The creator wallet still holds the title",
      ok: holderOk,
    },
  ];
  if (tensor) checks.push({ label: "The Tensor price is in this token", ok: tensor.currency === record.attributes.mint });
  if (read.collection) {
    checks.push({
      label: "The title is edition 1 of a sealed collection of one",
      ok: read.collectionSealed && read.edition === 1,
    });
  }
  return {
    address,
    rail,
    owner: read.owner,
    name: read.name,
    sheet: read.uri,
    listing,
    creator,
    collection: read.collection,
    tensor,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export type TitleRead = {
  exists: boolean;
  owner: string;
  name: string;
  uri: string;
  attributes: Record<string, string>;
  locked: boolean;
  clean: boolean;
  collection: string | null;
  edition: number | null;
  collectionSealed: boolean;
};

const NO_TITLE: TitleRead = {
  exists: false,
  owner: "",
  name: "",
  uri: "",
  attributes: {},
  locked: false,
  clean: false,
  collection: null,
  edition: null,
  collectionSealed: false,
};

/** `clean` means no plugin lets anyone move, burn, or freeze the title, the same rule the escrow enforces. */
export async function readTitle(endpoint: string, asset: string): Promise<TitleRead> {
  const umi = createUmi(endpoint).use(mplCore());
  try {
    const found = await fetchAsset(umi, umiKey(asset), { commitment: "confirmed" });
    const attributes: Record<string, string> = {};
    for (const item of found.attributes?.attributeList ?? []) attributes[item.key] = item.value;
    const risky = [
      found.freezeDelegate,
      found.burnDelegate,
      found.transferDelegate,
      found.updateDelegate,
      found.permanentFreezeDelegate,
      found.permanentTransferDelegate,
      found.permanentBurnDelegate,
      found.oracles?.length ? found.oracles : undefined,
      found.lifecycleHooks?.length ? found.lifecycleHooks : undefined,
      found.linkedLifecycleHooks?.length ? found.linkedLifecycleHooks : undefined,
    ].some(Boolean);
    const edition = found.edition ? Number(found.edition.number) : null;
    let collection: string | null = null;
    let collectionSealed = false;
    if (found.updateAuthority.type === "Collection" && found.updateAuthority.address) {
      collection = found.updateAuthority.address.toString();
      try {
        const parent = await fetchCollection(umi, umiKey(collection), { commitment: "confirmed" });
        collectionSealed =
          parent.updateAuthority.toString() === sealedAuthority(new PublicKey(collection)).toBase58() &&
          Number(parent.masterEdition?.maxSupply ?? 0) === 1 &&
          Number(parent.numMinted) === 1 &&
          edition === 1;
      } catch {
        collectionSealed = false;
      }
    }
    return {
      exists: true,
      owner: found.owner.toString(),
      name: found.name,
      uri: found.uri,
      attributes,
      locked:
        found.attributes?.authority.type === "None" && (found.updateAuthority.type === "None" || collectionSealed),
      clean: !risky,
      collection,
      edition,
      collectionSealed,
    };
  } catch {
    return NO_TITLE;
  }
}
