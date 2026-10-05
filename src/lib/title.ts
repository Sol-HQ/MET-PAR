import { create, fetchAsset, mplCore, updateV2 } from "@metaplex-foundation/mpl-core";
import { createNoopSigner, createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type Keypair } from "@solana/web3.js";
import { isAdminWallet } from "./admins";
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

/** The escrow program. Empty until it is deployed on that network. */
export const ESCROW_PROGRAM: Record<ClusterName, string> = {
  devnet: "AGcNqaLNfR7h2bdGi39vEMTKNyfX8qLt4mgmbhmtgWvh",
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

/** The route a new title will actually use. Mainnet ignores an escrow pick. */
export function chosenRail(cluster: ClusterName, hold: "wallet" | "escrow"): TitleRail {
  return escrowOffered(cluster) && hold === "escrow" ? "escrow" : "creator";
}

export function railWords(rail: TitleRail): string {
  return rail === "escrow" ? "escrow program" : "creator wallet";
}

export function saleVenueWords(rail: TitleRail): string {
  return rail === "escrow" ? "PAR escrow program" : "Tensor marketplace program";
}

/** The creator signs these words with the wallet, and the signature goes into the sheet. */
export function creatorPromises(input: {
  rail: TitleRail;
  delayDays: number;
  burnPercent: number;
  handoffDays: string;
  venue: string;
  sale?: SaleMode;
}): string[] {
  const escrow = input.rail === "escrow";
  const auction = escrow && input.sale === "auction";
  return [
    "I own the item on this record sheet, or I have the right to sell it, and it is as described.",
    "The title is the one claim to the item. Whoever holds the title can claim the item from me.",
    escrow
      ? auction
        ? `The title is auctioned only through the PAR escrow program, only for this token. The auction can open ${input.delayDays} days after the token graduates. The first bid at or above the reserve starts a ${AUCTION_HOURS}-hour clock. A bid in the last hour moves the end to ${AUCTION_EXTEND_HOURS} hour after that bid. The PAR watcher finishes it when the clock ends.`
        : `The title is sold only through the PAR escrow program, only for this token, once the sale opens ${input.delayDays} days after the token graduates. The first person to pay the price gets it, from the PAR sale page (${input.venue}) or any other tool.`
      : `I will list the title from the PAR sale page (${input.venue}), through Tensor's marketplace program, priced only in this token, and not before the sale opens ${input.delayDays} days after the token graduates. The listing may also show on Tensor's own site.`,
    escrow
      ? `At the sale, ${input.burnPercent}% of the price is burned by the escrow, ${creatorSalePercent(input.burnPercent)}% is paid to me, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
      : `Tensor pays me the full price. Within ${CREATOR_BURN_DAYS} days of the sale I will burn ${input.burnPercent}% of it and keep the rest.`,
    `I will hand the item to the holder of the title within ${input.handoffDays} days of their claim, as the handoff terms say.`,
    escrow
      ? auction
        ? `The title waits in the PAR escrow program. If nobody bids, it stays there. I can take it back ${AUCTION_SIT_DAYS} days after the sale could open, and it does not come back on its own. Once a bid starts, I cannot take it back.`
        : "The title waits in the PAR escrow program until it is sold. If it never sells, it returns to me a year after the sale could open."
      : "Until the sale, the title stays in my wallet or in my Tensor listing. I will not sell, move, lend, or burn it any other way. Doing so breaks my word.",
    "The token is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share of the item, and it pays nothing.",
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
};

export function titleAttributes(facts: TitleFacts): RecordAttribute[] {
  const escrow = facts.rail === "escrow";
  const auction = escrow && facts.sale === "auction";
  const rows: RecordAttribute[] = [
    { key: "title", value: TITLE_KIND },
    { key: "record", value: facts.record },
    { key: "mint", value: facts.mint },
    { key: "pool", value: facts.pool },
    { key: "creator", value: facts.creator },
    { key: "held by", value: railWords(facts.rail) },
    { key: "sold through", value: saleVenueWords(facts.rail) },
    { key: "sale opens", value: `${facts.delayDays} days after graduation` },
    { key: "paid in", value: "this token only" },
    { key: "burned", value: `${facts.burnPercent}%` },
    { key: "sale page", value: facts.venue },
    { key: "escrow program", value: escrow && facts.program ? facts.program : "none" },
    { key: "sale", value: auction ? "auction" : escrow ? "fixed price" : "tensor" },
  ];
  if (auction) {
    rows.push({
      key: "auction",
      value: `${AUCTION_HOURS} hours after the first bid at the reserve. A bid in the last hour extends ${AUCTION_EXTEND_HOURS} hour. Sits ${AUCTION_SIT_DAYS} days if no bid. The PAR watcher finishes it.`,
    });
  }
  return rows;
}

/**
 * The title, the one edition of the record that can be sold. The creator owns it, its attributes carry authority None,
 * and its update authority is set to None in the same transaction, so nothing on it can change again.
 * ImmutableMetadata is left off on purpose: it would block setting the update authority to None.
 */
export function titleInstructions(input: {
  endpoint: string;
  asset: Keypair;
  creator: PublicKey;
  name: string;
  uri: string;
  attributes: RecordAttribute[];
}): TransactionInstruction[] {
  const umi = createUmi(input.endpoint).use(mplCore());
  const creator = createNoopSigner(umiKey(input.creator.toBase58()));
  umi.use(signerIdentity(creator));
  const asset = createSignerFromKeypair(umi, fromWeb3JsKeypair(input.asset));
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
const MARK_GRADUATED = Uint8Array.from([125, 72, 57, 129, 59, 15, 247, 251]);

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
  if (!ESCROW_PROGRAM.devnet || input.program.toBase58() !== ESCROW_PROGRAM.devnet) {
    throw new Error("The escrow path is not available on this network.");
  }
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

export function markGraduatedInstruction(program: PublicKey, title: PublicKey, pool: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(MARK_GRADUATED),
    keys: [
      { pubkey: listingAddress(title, program), isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
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
  rail: TitleRail;
  owner: string;
  name: string;
  sheet: string;
  listing: string | null;
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
  const rail: TitleRail = record.attributes["title held by"] === "escrow program" ? "escrow" : "creator";
  const read = await readTitle(endpoint, address);
  const program = ESCROW_PROGRAM[cluster];
  const listing = rail === "escrow" && program ? listingAddress(new PublicKey(address), new PublicKey(program)).toBase58() : null;
  const creator = record.attributes.creator;
  const tensor =
    rail === "creator" && read.exists && read.owner === tensorListAddress(new PublicKey(address)).toBase58()
      ? await readTensorListing(new Connection(endpoint, "confirmed"), new PublicKey(address)).catch(() => null)
      : null;
  const listedByCreator = Boolean(tensor) && tensor?.seller === creator;
  const holderOk = rail === "escrow" ? Boolean(listing) && read.owner === listing : read.owner === creator || listedByCreator;
  const checks: TitleCheck[] = [
    { label: "The title exists on chain", ok: read.exists },
    {
      label: "The title names this record and token",
      ok: read.attributes.title === TITLE_KIND && read.attributes.record === record.address && read.attributes.mint === record.attributes.mint,
    },
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
  return {
    address,
    rail,
    owner: read.owner,
    name: read.name,
    sheet: read.uri,
    listing,
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
};

const NO_TITLE: TitleRead = { exists: false, owner: "", name: "", uri: "", attributes: {}, locked: false, clean: false };

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
    return {
      exists: true,
      owner: found.owner.toString(),
      name: found.name,
      uri: found.uri,
      attributes,
      locked: found.updateAuthority.type === "None" && found.attributes?.authority.type === "None",
      clean: !risky,
    };
  } catch {
    return NO_TITLE;
  }
}
