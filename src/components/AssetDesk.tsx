"use client";

import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { signedPictureHeaders } from "@/lib/picture";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LawRecord } from "@/components/LawRecord";
import { RecordCreate } from "@/components/RecordCreate";
import { BASE_DECIMALS, DEFAULT_FEE_DECAY_SECONDS, DEFAULT_MIGRATION_FEE_BPS, MIGRATION_FEE_CHOICES, migrationFeeLabel, quoteMintAddress } from "@/lib/constants";
import { readCurveShape } from "@/lib/curve";
import { bpsToPercent } from "@/lib/format";
import { shrinkImageUnder } from "@/lib/image";
import { BILLION_SUPPLY, checkParPrices, type LaunchChoice } from "@/lib/launch";
import { DEFAULT_PLATFORM_SETTINGS, METEORA_TRADING_FEE_PERCENT, assertCurveFee, creatorSharePercent, parseFeePercent, type PlatformSettings } from "@/lib/platform";
import { FREE_UPLOAD_BYTES } from "@/lib/record";
import { useCluster } from "@/lib/cluster";
import { parseTokenAmount } from "@/lib/tensor-sale";
import { AUCTION_EXTEND_HOURS, AUCTION_HOURS, AUCTION_SIT_DAYS, CREATOR_BURN_DAYS, TENSOR_TAKER_FEE_PERCENT, chosenRail, COIN_WORDS, creatorSalePercent, ESCROW_COMING, escrowDepositAllowed, SALE_BURN_PERCENT, SALE_DAY_PRESETS, SALE_DELAY_DAYS, SALE_PROGRAM_FEE_PERCENT } from "@/lib/title";

/** What the whole supply is priced at, at par. The creator picks it. It is not an appraisal. */
const VALUES: Record<"USDC" | "SOL", number[]> = {
  USDC: [100, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 25_000, 50_000, 100_000],
  SOL: [1, 5, 10, 25, 50, 100, 250, 500],
};

/** The pool price sits 20% above par, inside the PAR rule of at most twice par. */
const POOL_LIFT = 1.2;

function decimal(amount: number): string {
  return amount.toFixed(15).replace(/\.?0+$/, "");
}

function pricesFor(value: string): { value: string; par: string; pool: string } {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return { value, par: "", pool: "" };
  return { value, par: decimal(amount / BILLION_SUPPLY), pool: decimal((amount * POOL_LIFT) / BILLION_SUPPLY) };
}

const STEPS = [
  "Object",
  "Maker",
  "Claim",
  "Redemption",
  "Names",
  "Curve",
  "Pitch",
  "Buyer page",
  "Sheet",
] as const;

type Step = (typeof STEPS)[number];

export type Draft = {
  objectName: string;
  kind: string;
  /** Card number, series, bar number, or serial. Empty when the object has none. */
  serial: string;
  existsNow: "yes" | "no";
  holder: string;
  where: string;
  story: string;
  /** The creator's pitch. Empty when they leave it blank. It locks on the record sheet. */
  pitch: string;
  /** The person who signs. A name is required. A real identity is encouraged. */
  makerName: string;
  maker: string;
  role: string;
  work: string;
  marks: "own" | "permission";
  claim: string;
  /** Days after graduation before the title can be sold. Fixed in the escrow once the title goes in. */
  saleDays: string;
  /** Escrow only. Fixed price, or an auction whose clock starts on the first bid. */
  sale: "fixed" | "auction";
  /** The fixed price, or the auction reserve, in this token. The escrow stores it at deposit. */
  titlePrice: string;
  /** Where the title goes. Auth wallets can pick escrow on the practice network. Mainnet stays on Tensor. */
  hold: "wallet" | "escrow";
  shipDays: string;
  shipping: string;
  declared: string;
  terms: string;
  assetName: string;
  tokenName: string;
  symbol: string;
  quote: "USDC" | "SOL";
  /** The whole supply at par, in the quote. Par and the pool price follow from it. */
  value: string;
  par: string;
  pool: string;
  fee: "flat" | "fall";
  feeOpen: string;
  feeEnd: string;
  straightFall: boolean;
  dynamicFee: boolean;
  compoundOn: boolean;
  poolFee: string;
  compoundShare: string;
  poolFeeBps: number;
};

export function launchChoice(draft: Draft): LaunchChoice {
  return { kind: "custom-par", supply: BILLION_SUPPLY, parPrice: Number(draft.par), poolPrice: Number(draft.pool) };
}

function example(partial: Omit<Draft, "existsNow" | "marks" | "saleDays" | "sale" | "titlePrice" | "hold" | "serial" | "makerName" | "pitch" | "quote" | "value" | "par" | "pool" | "fee" | "feeOpen" | "feeEnd" | "straightFall" | "dynamicFee" | "compoundOn" | "poolFee" | "compoundShare" | "poolFeeBps"> & Partial<Draft>): Draft {
  return {
    existsNow: "yes",
    marks: "own",
    serial: "",
    makerName: "",
    pitch: "",
    saleDays: String(SALE_DELAY_DAYS),
    sale: "fixed",
    titlePrice: "",
    hold: "wallet",
    quote: "USDC",
    fee: "fall",
    feeOpen: "5",
    feeEnd: "1",
    straightFall: false,
    dynamicFee: false,
    compoundOn: false,
    poolFee: "0.25",
    compoundShare: "100",
    poolFeeBps: DEFAULT_MIGRATION_FEE_BPS,
    ...pricesFor(partial.value ?? partial.declared),
    ...partial,
  };
}

const EXAMPLES = {
  painting: example({
    objectName: "The painting",
    kind: "One original painting",
    holder: "The painter",
    where: "In the painter's studio",
    story: "One painting, finished and signed by the painter. It is in the studio now.",
    pitch: "One signed painting, still in the studio. The coin is the only way to buy the title to it.",
    makerName: "Mara Ellison",
    maker: "The painter",
    role: "Painter",
    work: "Original paint on canvas by the painter. Signed on the back.",
    claim: "Whoever holds the title can claim this painting from the painter.",
    shipDays: "30",
    shipping: "The painter ships the painting packed and tracked, or the holder picks it up at the studio.",
    declared: "100",
    terms:
      "If this painting is not handed over, the painter pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "The painting",
    tokenName: "Painting coin",
    symbol: "PAINT",
    ...pricesFor("1000"),
  }),
  kite: example({
    objectName: "Ghost kite",
    kind: "One kite",
    holder: "The maker",
    where: "With the maker",
    story:
      "A kite the maker still holds. The cloth is the maker's own art about the Meteora ecosystem. It has been flown. The official Meteora logo is not on the cloth.",
    pitch: "The kite on this page stays with the maker. The coin buys a sister kite, built the same way.",
    makerName: "Jonah Reed",
    maker: "The maker",
    role: "LP Army member",
    work: "Original art about the ecosystem the maker provides liquidity in.",
    claim: "This is the kite. Whoever holds the title claims a sister of it, a perfect copy. The kite on this page stays with the maker.",
    shipDays: "30",
    shipping: "The maker builds that sister kite and ships it, or meets the title holder to hand it over.",
    declared: "2000",
    terms:
      "If that sister kite is not handed over, the maker pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "Ghost kite",
    tokenName: "Ghost kite coin",
    symbol: "GHOST",
  }),
  card: example({
    objectName: "Rookie card",
    kind: "One baseball card",
    serial: "1952 Topps, card 311",
    holder: "The collector",
    where: "In a sleeve, with the collector",
    story: "One physical card, already in hand. The print is the card's own.",
    pitch: "One card, in a sleeve, with the number on this sheet. The coin is the only way to buy the title.",
    makerName: "Sam Carter",
    maker: "The collector",
    role: "Collector",
    work: "The card's own print.",
    claim: "Whoever holds the title can claim this card from the collector.",
    shipDays: "14",
    shipping: "The holder pays shipping, or meets the collector to take the card.",
    declared: "800",
    terms:
      "If this card is not handed over, the collector pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "Rookie card",
    tokenName: "Rookie card coin",
    symbol: "CARD",
  }),
  art: example({
    objectName: "Studio piece",
    kind: "One piece of art",
    holder: "The artist",
    where: "In the studio",
    story: "One piece. The work is the artist's own. It exists now.",
    pitch: "One piece in the studio. The coin is the only way to buy the title to it.",
    makerName: "Priya Shah",
    maker: "The artist",
    role: "Artist",
    work: "Original work by the artist.",
    claim: "Whoever holds the title can claim this piece from the artist.",
    shipDays: "30",
    shipping: "The holder pays shipping, or meets the artist to take the piece.",
    declared: "5000",
    terms:
      "If this piece is not handed over, the artist pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "Studio piece",
    tokenName: "Studio piece coin",
    symbol: "PIECE",
    fee: "flat",
  }),
  watch: example({
    objectName: "Serial watch",
    kind: "One wristwatch",
    serial: "48291",
    holder: "The owner",
    where: "With the owner",
    story: "One watch, already in hand. The serial number identifies it.",
    pitch: "One watch, serial on this sheet. The coin is the only way to buy the title.",
    makerName: "Owen Blake",
    maker: "The owner",
    role: "Owner",
    work: "The watch and its serial number.",
    claim: "Whoever holds the title can claim this watch from the owner.",
    shipDays: "14",
    shipping: "Insured shipment, or a meeting to hand over the watch.",
    declared: "8000",
    terms:
      "If this watch is not handed over, the owner pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "Serial watch",
    tokenName: "Serial watch coin",
    symbol: "WATCH",
  }),
  vehicle: example({
    objectName: "The vehicle",
    kind: "One vehicle",
    serial: "VIN 4PAR00000A0004821",
    holder: "The owner",
    where: "With the owner",
    story: "One vehicle, already titled. The identification number names it.",
    pitch: "One vehicle, identification number on this sheet. The coin buys the title. The handoff is the papers and the keys.",
    makerName: "Luis Ortega",
    maker: "The owner",
    role: "Owner",
    work: "The vehicle and its identification number.",
    claim: "Whoever holds the title can claim this vehicle from the owner.",
    shipDays: "30",
    shipping: "The handoff is the signed ownership papers and the keys, at a place named on this page.",
    declared: "20000",
    terms:
      "If the ownership papers and the keys are not handed over, the owner pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "The vehicle",
    tokenName: "Vehicle coin",
    symbol: "CAR",
  }),
  gold: example({
    objectName: "Allocated bar",
    kind: "One numbered gold bar",
    serial: "Bar 00481",
    holder: "The owner",
    where: "In a named vault",
    story: "One bar, already cast and numbered. It sits in the vault named here.",
    pitch: "One numbered bar in the vault named here. The coin is the only way to buy the title.",
    makerName: "Helen Cho",
    maker: "The owner",
    role: "Owner",
    work: "The bar number and the vault record.",
    claim: "Whoever holds the title can claim this bar from the owner.",
    shipDays: "21",
    shipping: "Release from the named vault, or insured delivery of that bar.",
    declared: "12000",
    terms:
      "If this bar is not released, the owner pays the declared value to the title holder. The title holder keeps the title until the handoff is done, or until that amount is paid.",
    assetName: "Allocated bar",
    tokenName: "Allocated bar coin",
    symbol: "BAR",
    fee: "flat",
  }),
} satisfies Record<string, Draft>;

type ExampleId = keyof typeof EXAMPLES;

function wholeDays(value: string) {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return days;
}

function positive(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

type Checks = { hasPicture: boolean; curveError: string };

function problemFor(step: Step, draft: Draft, checks: Checks) {
  if (step === "Object") {
    if (!draft.objectName.trim() || !draft.kind.trim() || !draft.holder.trim() || !draft.where.trim() || !draft.story.trim()) {
      return "Name the object, what it is, who holds it, where it is, and the story.";
    }
    if (!checks.hasPicture) return "Add a picture of the asset. It becomes the picture on the record.";
    if (draft.existsNow === "no") {
      return "This template is for an object that already exists. An object still being made is a preorder.";
    }
  }
  if (step === "Maker") {
    if (!draft.makerName.trim() || !draft.maker.trim() || !draft.role.trim() || !draft.work.trim()) {
      return "Name the artist, maker, or owner, who owes the object, their role, and what identifies it.";
    }
    if (draft.makerName.trim().length > 80) return "The name is 80 characters or fewer.";
    if (draft.marks === "permission") {
      return "Written permission has to be attached before this page can say another project's mark is allowed.";
    }
  }
  if (step === "Claim") {
    if (!draft.claim.trim()) return "Write what the holder of the title can claim.";
    if (wholeDays(draft.saleDays) === null) return "The days after graduation before the title sale are a whole number from 1 to 365.";
    if (draft.hold === "escrow" && !parseTokenAmount(draft.titlePrice)) {
      return draft.sale === "auction" ? "Type the reserve in this token. A bid has to reach it." : "Type the price in this token. The buyer pays that amount.";
    }
  }
  if (step === "Redemption") {
    if (wholeDays(draft.shipDays) === null) return "Delivery days are a whole number from 1 to 365.";
    if (!draft.shipping.trim()) return "Write how the object changes hands.";
    if (positive(draft.declared) === null) {
      return "The declared value is a number above zero. It is the most the holder pays if the object cannot be delivered.";
    }
    if (draft.terms.length === 0) {
      return "The redemption card cannot be left blank. Write what happens if a claim goes wrong, and what you are liable for.";
    }
  }
  if (step === "Names") {
    if (!draft.assetName.trim() || !draft.tokenName.trim()) return "The object and the token each need a name.";
    if (draft.assetName.length > 32 || draft.tokenName.length > 32) return "The asset name and the token name are 32 characters or fewer.";
    if (!/^[A-Z0-9]{2,8}$/.test(draft.symbol.trim().toUpperCase())) {
      return "The symbol is 2 to 8 letters or numbers.";
    }
  }
  if (step === "Curve") {
    const par = positive(draft.par);
    const pool = positive(draft.pool);
    const fee = positive(draft.feeOpen);
    if (par === null || pool === null) return "Pick or type what the whole supply is worth at par. It is a number above zero.";
    if (pool <= par) return "The pool price sits above par. The last slice of the sale walks up to it.";
    if (fee === null || fee < 0.25 || fee > 99) return "The opening fee is from 0.25% to 99%.";
    if (draft.fee === "fall") {
      const ending = positive(draft.feeEnd);
      if (ending === null || ending < 0.25 || ending > 99) return "The ending fee is from 0.25% to 99%.";
      if (ending > fee) return "The ending fee has to be at or under the opening fee.";
    }
    if (checks.curveError) return checks.curveError;
  }
  return "";
}

const PROFIT_WORDS =
  /\b(invest\w*|profit\w*|roi|yields?|dividends?|passive income|apprecia\w*|price will|go(es)? up|to the moon|moon\w*|\d+x)\b/i;

/** A sale of one object, not an investment. Any promise of gain on the page blocks the create. */
export function profitWord(draft: Draft): string {
  const text = [
    draft.objectName, draft.kind, draft.holder, draft.where, draft.story, draft.pitch, draft.makerName, draft.maker, draft.role, draft.work,
    draft.claim, draft.shipping, draft.terms, draft.assetName, draft.tokenName,
  ].join("\n");
  return PROFIT_WORDS.exec(text)?.[0] ?? "";
}

function firstProblem(draft: Draft, checks: Checks) {
  const word = profitWord(draft);
  if (word) {
    return `Take out "${word}". This page sells a claim to one object. It cannot promise profit, a rising price, or any return.`;
  }
  for (const step of STEPS) {
    const problem = problemFor(step, draft, checks);
    if (problem) return `${step}: ${problem}`;
  }
  return "";
}

export function AssetDesk() {
  const [step, setStep] = useState<Step>("Object");
  const [lawOpen, setLawOpen] = useState(false);
  const [example, setExample] = useState<ExampleId>("painting");
  const [draft, setDraft] = useState<Draft>(EXAMPLES.painting);
  const [tried, setTried] = useState(false);
  const [platform, setPlatform] = useState<PlatformSettings>(DEFAULT_PLATFORM_SETTINGS);
  const [picture, setPicture] = useState<Blob | null>(null);
  const [pictureCopy, setPictureCopy] = useState("");
  const [pictureView, setPictureView] = useState("");
  const [pictureNote, setPictureNote] = useState("");
  const symbol = draft.symbol.trim().toUpperCase();
  const { cluster } = useCluster();
  const { publicKey, signMessage } = useWallet();
  const escrowLive = escrowDepositAllowed(cluster, publicKey?.toBase58());
  const rail = chosenRail(cluster, escrowLive ? draft.hold : "wallet");
  const unit = draft.quote;
  const [escrowHint, setEscrowHint] = useState("");
  const [preparedKeys] = useState(() => ({
    baseMint: Keypair.generate(),
    config: Keypair.generate(),
    record: Keypair.generate(),
    title: Keypair.generate(),
  }));
  const quoteKind = draft.quote === "SOL" ? "sol" : "usdc";
  const quoteMintKey = quoteMintAddress(cluster, quoteKind);
  const quoteMint = quoteMintKey.toBase58();
  const tokenMint = preparedKeys.baseMint.publicKey.toBase58();
  const poolAddress = deriveDbcPoolAddress(quoteMintKey, preparedKeys.baseMint.publicKey, preparedKeys.config.publicKey).toBase58();
  const platformCut = platform.platformFeePercent;
  const creatorCut = creatorSharePercent(platformCut);
  const shortClock = cluster === "devnet" && rail === "escrow";
  const waitUnit = shortClock ? "seconds" : "days";

  useEffect(() => {
    void fetch("/api/platform")
      .then(async (response) => (response.ok ? setPlatform((await response.json()) as PlatformSettings) : undefined))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (escrowLive) {
      setEscrowHint("");
      return;
    }
    setDraft((current) => (current.hold === "escrow" ? { ...current, hold: "wallet" } : current));
  }, [escrowLive]);

  const curve = useMemo(() => {
    let openingBps = 0;
    try {
      openingBps = parseFeePercent(draft.feeOpen);
      assertCurveFee(openingBps);
    } catch {
      return { error: "", parCap: "", locked: "" };
    }
    const shapeRead = readCurveShape({
      straightFall: draft.straightFall,
      dynamicFee: draft.dynamicFee,
      compoundOn: draft.compoundOn,
      poolFeePercent: draft.poolFee,
      compoundPercent: draft.compoundShare,
    });
    if (shapeRead.error) return { error: shapeRead.error, parCap: "", locked: "" };
    let endingBps = openingBps;
    if (draft.fee === "fall") {
      try {
        endingBps = parseFeePercent(draft.feeEnd);
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "That ending fee is not allowed.", parCap: "", locked: "" };
      }
      if (endingBps > openingBps) return { error: "The ending fee has to be at or under the opening fee.", parCap: "", locked: "" };
    }
    const marks = checkParPrices(
      draft.par,
      draft.pool,
      String(BILLION_SUPPLY),
      null,
      "",
      openingBps,
      endingBps,
      platform.platformFeePercent ?? 20,
      DEFAULT_FEE_DECAY_SECONDS,
      draft.poolFeeBps,
      draft.quote === "SOL" ? "sol" : "usdc",
      undefined,
      undefined,
      shapeRead.shape,
    );
    if (marks.picture.ok) return { error: "", parCap: marks.picture.parMarketCap, locked: marks.picture.locked };
    return { error: marks.supply || marks.par || marks.pool || marks.picture.error || "That curve does not fit.", parCap: "", locked: "" };
  }, [draft.feeOpen, draft.fee, draft.feeEnd, draft.straightFall, draft.dynamicFee, draft.compoundOn, draft.poolFee, draft.compoundShare, draft.poolFeeBps, draft.par, draft.pool, draft.quote, platform]);

  const checks: Checks = { hasPicture: Boolean(picture && pictureCopy), curveError: curve.error };
  const word = profitWord(draft);
  const problem =
    problemFor(step, draft, checks) ||
    (word ? `Take out "${word}". This page sells a claim to one object. It cannot promise profit, a rising price, or any return.` : "");
  const sizeLine = curve.parCap
    ? `At par, all ${symbol || "tokens"} together are priced at ${curve.parCap}. The declared value of ${draft.assetName || "the object"} is ${unit === "USDC" ? `$${draft.declared}` : `${draft.declared} SOL`}. A buyer sees both numbers.`
    : "";
  const index = STEPS.indexOf(step);

  async function addPicture(file: File) {
    setPictureNote("Shrinking and saving the picture…");
    try {
      const jpeg = await shrinkImageUnder(file, FREE_UPLOAD_BYTES - 4096);
      if (!publicKey || !signMessage) throw new Error("Connect a wallet to save the picture.");
      const response = await fetch("/api/image", {
        method: "POST",
        headers: await signedPictureHeaders(jpeg, publicKey.toBase58(), signMessage),
        body: jpeg,
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error || "Could not save that picture.");
      if (pictureView) URL.revokeObjectURL(pictureView);
      setPicture(jpeg);
      setPictureCopy(body.url);
      setPictureView(URL.createObjectURL(jpeg));
      setPictureNote(`${(jpeg.size / 1024).toFixed(1)} KiB. This picture goes on the record and on Arweave.`);
    } catch (cause) {
      setPictureNote(cause instanceof Error ? cause.message : "Could not read that picture.");
    }
  }

  const sheet = useMemo(
    (): [string, string][] => [
      [
        "Sale path",
        rail === "escrow"
          ? draft.sale === "auction"
            ? "Escrow, because Escrow is selected on Claim. The title is auctioned only through the PAR escrow program."
            : "Escrow, because Escrow is selected on Claim. The title is sold only through the PAR escrow program."
          : "Tensor, because Tensor is selected on Claim. The title is listed through Tensor's marketplace program.",
      ],
      ["Object", `${draft.assetName || draft.objectName}. ${draft.kind}. ${draft.existsNow === "yes" ? "It exists now." : "It does not exist yet."}`],
      ["Serial", draft.serial.trim() || "None"],
      ["Holder", `${draft.holder}, ${draft.where}.`],
      ["Maker", `${draft.makerName.trim()}, ${draft.role}.`],
      ["Pitch", draft.pitch.trim() || "None"],
      ["Work", draft.work],
      ["Claim", draft.claim],
      ["Redemption", `The holder of the title claims it. Delivery takes ${draft.shipDays} days after the claim. ${draft.shipping} If a claim goes wrong: ${draft.terms}`],
      [
        "Title sale",
        rail === "escrow"
          ? `Escrow is selected on Claim. The title is ${draft.sale === "auction" ? "auctioned" : "sold"} only through the PAR escrow program, only for ${symbol || "the token"}, once the sale opens ${draft.saleDays} ${waitUnit} after graduation. ${
              draft.sale === "auction"
                ? `It is an auction. The reserve is ${draft.titlePrice || "unset"} ${symbol || "tokens"}. ${
                    shortClock
                      ? "The clock starts on the first bid at the reserve and runs 72 seconds. A bid in the last second extends it 1 second. With no bid it sits 60 seconds and does not come back on its own."
                      : `The clock starts on the first bid at the reserve and runs ${AUCTION_HOURS} hours. A bid in the last hour extends it ${AUCTION_EXTEND_HOURS} hour. With no bid it sits ${AUCTION_SIT_DAYS} days and does not come back on its own.`
                  } `
                : `The price is ${draft.titlePrice || "unset"} ${symbol || "tokens"}. The first person to pay it gets the title. `
            }${SALE_BURN_PERCENT}% of the price is burned by the escrow, ${creatorSalePercent()}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
          : `Tensor is selected on Claim. The title is listed from the PAR sale page through Tensor's marketplace program, only for ${symbol || "the token"}, and not before ${draft.saleDays} days after graduation. Tensor pays the creator the full price. The buyer pays Tensor about ${TENSOR_TAKER_FEE_PERCENT}% on top. PAR takes none of that sale. Within ${CREATOR_BURN_DAYS} days the creator burns ${SALE_BURN_PERCENT}% of the price and keeps ${100 - SALE_BURN_PERCENT}%.`,
      ],
      [
        "Token",
        `${draft.tokenName} (${symbol}). Token address ${tokenMint}. ${BASE_DECIMALS} decimals. Supply 1,000,000,000. Quoted in ${unit}. Quote mint ${quoteMint}. Pool ${poolAddress}. ${COIN_WORDS} The picture on the Object step is the token image and the record image.`,
      ],
      [
        "Picture",
        pictureView
          ? "The picture on this sheet is the token image and the record image."
          : "No picture yet. Add one on the Object step. That picture is the token image and the record image.",
      ],
      [
        "Curve",
        `PAR on a Meteora bonding curve, quoted in ${unit}. Par ${draft.par} ${unit}. Pool price ${draft.pool} ${unit}. ${curve.locked} ${draft.fee === "flat" ? `The fee stays at ${draft.feeOpen}% until graduation.` : `The fee starts at ${draft.feeOpen}% and falls ${draft.straightFall ? "in a straight line" : "on a curve"} to ${draft.feeEnd}%.`} ${draft.dynamicFee ? "A volatility fee can add at most one fifth of that fee." : "No volatility fee."} Meteora keeps ${METEORA_TRADING_FEE_PERCENT}% of the trading fee. PAR keeps ${platformCut}%. The creator keeps ${creatorCut}%. ${draft.compoundOn ? `${draft.compoundShare}% of the pool fee is put back into the pool after the lock.` : `After the lock the pool fee is ${migrationFeeLabel(draft.poolFeeBps)}, and those shares can be claimed.`} Graduation locks the sale into a DAMM v2 pool. ${sizeLine}`,
      ],
    ],
    [draft, symbol, unit, sizeLine, curve.locked, rail, waitUnit, shortClock, tokenMint, quoteMint, poolAddress, pictureView, platformCut, creatorCut],
  );

  function patch(partial: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function load(next: ExampleId) {
    setExample(next);
    setDraft(EXAMPLES[next]);
    setTried(false);
  }

  function go(next: Step) {
    const nextIndex = STEPS.indexOf(next);
    const redemptionIndex = STEPS.indexOf("Redemption");
    if (nextIndex > redemptionIndex && problemFor("Redemption", draft, checks)) {
      setTried(true);
      setStep("Redemption");
      return;
    }
    setTried(false);
    setStep(next);
  }

  function forward() {
    if (problem) {
      setTried(true);
      return;
    }
    const next = STEPS[index + 1];
    if (next) go(next);
  }

  return (
    <div className="desk asset-desk">
      <section className="lede">
        <p className="eyebrow">Template</p>
        <h1>Real-world asset</h1>
        <p className="tagline">One object. One title. One payment token and meme.</p>
        <p>
          This page creates one object with PAR. The coin on this page is always created on PAR. A token whose price rises from the first buy is a plain token, and that token is created on the home page.
        </p>
        <p>
          The lock is graduation. When the curve is full, the {unit} raised on the sale and the tokens still left move into a Meteora DAMM v2 pool. That pool is locked. The {unit} and those tokens stay in it.
        </p>
        <div className="beats">
          <article>
            <strong>1. The climb</strong>
            <span>
              PAR is on. The climb is almost flat. Most tokens buyers receive stay within 10% of the price you set, so a buyer now and a buyer later pay nearly the same. The last slice rises to the pool price.
            </span>
          </article>
          <article>
            <strong>2. The lock</strong>
            <span>
              The lock is graduation. The climb ends when the sale is full. Meteora moves the {unit} raised on the sale and the tokens still left into a DAMM v2 pool. DAMM v2 is the Meteora pool this page uses. The pool is locked, so the {unit} and those tokens cannot be withdrawn.
            </span>
          </article>
          <article>
            <strong>3. After the lock</strong>
            <span>
              The coin trades from the pool price on that DAMM v2 pool. Later buys can move it up, and later sells can move it down. The curve fee stops. Every trade pays the pool fee.
            </span>
          </article>
          <article>
            <strong>4. The days</strong>
            <span>
              After graduation the coin trades for the days set on the Claim step. The title can be sold when those days end. The day is set when the coin graduates, and it locks into the title.
            </span>
          </article>
          <article>
            <strong>5. The title</strong>
            <span>
              The creator then lists the title through Tensor. The coin pays for the title. The title can go into the escrow, and that program sells it. {ESCROW_COMING}
            </span>
          </article>
        </div>
        <p>
          {COIN_WORDS} The steps name the object, the person, the handoff, and the pitch. They fit any one object: a painting, a card, a kite, a ball, a photograph, or something else. One example is filled in.
          The other examples use the same steps. A plain token is created on the home page and has no title.
        </p>
        <p>
          The last step creates the coin on PAR, then the master, then one edition. The master is sent to the
          program vault and stays frozen. That one edition is the title, and it is sent to the creator wallet.
          The NFT on the chain is the proof. PAR keeps a copy of those proofs. Both NFTs hold the record sheet, the meta sheet.
        </p>
        <button type="button" aria-pressed={lawOpen} onClick={() => setLawOpen((open) => !open)}>
          {lawOpen ? "Close the structure and the law" : "Structure and the law"}
        </button>
        {lawOpen ? <LawRecord /> : null}
        <div className="asset-nav">
          <Link href="/" className="asset-link">
            PAR
          </Link>
          <Link href="/pools" className="asset-link">
            Pools
          </Link>
        </div>
        <div className="asset-examples">
          <p className="eyebrow">Examples</p>
          <div className="segmented" role="group" aria-label="Filled example">
            <button type="button" aria-pressed={example === "painting"} onClick={() => load("painting")}>
              Painting
            </button>
            <button type="button" aria-pressed={example === "kite"} onClick={() => load("kite")}>
              Ghost kite
            </button>
            <button type="button" aria-pressed={example === "card"} onClick={() => load("card")}>
              Baseball card
            </button>
            <button type="button" aria-pressed={example === "art"} onClick={() => load("art")}>
              Art piece
            </button>
            <button type="button" aria-pressed={example === "watch"} onClick={() => load("watch")}>
              Watch
            </button>
            <button type="button" aria-pressed={example === "vehicle"} onClick={() => load("vehicle")}>
              Vehicle
            </button>
            <button type="button" aria-pressed={example === "gold"} onClick={() => load("gold")}>
              Gold bar
            </button>
          </div>
        </div>
      </section>

      <ol className="asset-steps">
        {STEPS.map((name, item) => (
          <li key={name}>
            <button
              type="button"
              aria-current={name === step ? "step" : undefined}
              onClick={() => go(name)}
            >
              <span>{item + 1}</span>
              {name}
            </button>
          </li>
        ))}
      </ol>

      {step === "Object" ? (
        <form>
          <label>
            Object name
            <input value={draft.objectName} onChange={(event) => patch({ objectName: event.target.value })} />
          </label>
          <label>
            What it is
            <input value={draft.kind} onChange={(event) => patch({ kind: event.target.value })} />
          </label>
          <label>
            Serial
            <input value={draft.serial} onChange={(event) => patch({ serial: event.target.value })} />
            <span className="note">A card number, a series, a bar number, or a serial. Leave it blank if this object has none.</span>
          </label>
          <div className="segmented" role="group" aria-label="Does the object exist now">
            <button type="button" aria-pressed={draft.existsNow === "yes"} onClick={() => patch({ existsNow: "yes" })}>
              It exists now
            </button>
            <button type="button" aria-pressed={draft.existsNow === "no"} onClick={() => patch({ existsNow: "no" })}>
              Still being made
            </button>
          </div>
          <label>
            Who holds it
            <input value={draft.holder} onChange={(event) => patch({ holder: event.target.value })} />
          </label>
          <label>
            Where it is
            <input value={draft.where} onChange={(event) => patch({ where: event.target.value })} />
          </label>
          <label>
            Story
            <textarea value={draft.story} onChange={(event) => patch({ story: event.target.value })} rows={4} />
          </label>
          <label>
            Picture of the asset
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void addPicture(file);
              }}
            />
            <span className="note">
              {pictureNote || "A photo or an artistic picture of the asset. It becomes the picture on the record."}
            </span>
          </label>
          {pictureView ? <img className="asset-picture" src={pictureView} alt={draft.objectName || "Asset"} /> : null}
        </form>
      ) : null}

      {step === "Maker" ? (
        <form>
          <label>
            Name
            <input value={draft.makerName} onChange={(event) => patch({ makerName: event.target.value })} />
            <span className="note">The artist, the maker, or the owner. We encourage your real identity, although we don&apos;t require it. The name you give is written on your record sheet.</span>
          </label>
          <label>
            Who owes the object
            <input value={draft.maker} onChange={(event) => patch({ maker: event.target.value })} />
          </label>
          <label>
            Role
            <input value={draft.role} onChange={(event) => patch({ role: event.target.value })} />
            <span className="note">Who holds the asset and hands it over. The role is part of the record.</span>
          </label>
          <label>
            What identifies it
            <textarea value={draft.work} onChange={(event) => patch({ work: event.target.value })} rows={3} />
            <span className="note">Say what the asset is, and whose work it is.</span>
          </label>
          <div className="segmented" role="group" aria-label="Whose marks are on the object">
            <button type="button" aria-pressed={draft.marks === "own"} onClick={() => patch({ marks: "own" })}>
              Their own work
            </button>
            <button type="button" aria-pressed={draft.marks === "permission"} onClick={() => patch({ marks: "permission" })}>
              Someone else&apos;s mark
            </button>
          </div>
          <p className="note">
            {draft.marks === "own"
              ? "The page can say this person is responsible for the object, and that Meteora did not issue the token."
              : "Another project's mark needs that project's written permission before the page shows it."}
          </p>
        </form>
      ) : null}

      {step === "Claim" ? (
        <form>
          <label>
            What the holder of the title can claim
            <textarea value={draft.claim} onChange={(event) => patch({ claim: event.target.value })} rows={4} />
          </label>
          <p className="note">
            There is one asset and one title. {COIN_WORDS} The title can be bought {draft.saleDays || "some"} {waitUnit} after graduation.{" "}
            {rail === "escrow"
              ? `Escrow is selected. The title goes into the PAR escrow. At the sale the program burns ${SALE_BURN_PERCENT}%, pays you ${creatorSalePercent()}%, and pays ${SALE_PROGRAM_FEE_PERCENT}% to the PAR program.`
              : `Tensor is selected. The title stays in your wallet. When the sale opens, you list it on its PAR sale page through Tensor's marketplace program. Tensor pays you the full price. Within ${CREATOR_BURN_DAYS} days you burn ${SALE_BURN_PERCENT}% of it and keep the rest. The listing may also show on Tensor's site. PAR takes none of that sale.`}
          </p>
          <div className="segmented" role="group" aria-label="Title path">
            <button type="button" aria-pressed={rail !== "escrow"} onClick={() => patch({ hold: "wallet" })}>
              Tensor
            </button>
            <span className={cluster === "devnet" ? undefined : "path-soon"}>
              <button
                type="button"
                className={cluster === "devnet" ? undefined : "fuzzed"}
                disabled={cluster !== "devnet"}
                aria-pressed={rail === "escrow"}
                onClick={() => {
                  if (!escrowDepositAllowed(cluster, publicKey?.toBase58())) {
                    setEscrowHint("Connect the me wallet or the pa wallet to test the escrow path.");
                    return;
                  }
                  patch({ hold: "escrow" });
                }}
              >
                Escrow
              </button>
              {cluster === "devnet" ? null : <span className="soon-stamp">Coming soon</span>}
            </span>
          </div>
          {cluster === "devnet" ? (
            escrowHint ? <p className="note">{escrowHint}</p> : null
          ) : (
            <p className="note">{ESCROW_COMING}</p>
          )}
          <div className="segmented" role="group" aria-label="Days after graduation before the title sale">
            {SALE_DAY_PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={draft.saleDays === String(days)}
                onClick={() => patch({ saleDays: String(days) })}
              >
                {days} days
              </button>
            ))}
          </div>
          <label>
            Days after graduation before the title can be sold
            <input
              value={draft.saleDays}
              onChange={(event) => patch({ saleDays: event.target.value.replace(/\D/g, "") })}
              inputMode="numeric"
            />
            <span className="note">
              Pick one above, or type any whole number from 1 to 365. After graduation the coin trades for this many days. The title can be sold when those days end. The day is set when the coin graduates, and it locks into the title.
              {cluster === "devnet"
                ? " On the practice network, the escrow program counts each of these as one second, so a test can finish. The Tensor path still counts them as days."
                : ""}
            </span>
          </label>
          {rail === "escrow" ? (
            <>
              <div className="segmented" role="group" aria-label="How the title sells">
                <button type="button" aria-pressed={draft.sale === "fixed"} onClick={() => patch({ sale: "fixed" })}>
                  Fixed price
                </button>
                <button type="button" aria-pressed={draft.sale === "auction"} onClick={() => patch({ sale: "auction" })}>
                  Auction
                </button>
              </div>
              <label>
                {draft.sale === "auction" ? `Reserve, in ${symbol || "this token"}` : `Price, in ${symbol || "this token"}`}
                <input
                  value={draft.titlePrice}
                  onChange={(event) => patch({ titlePrice: event.target.value.replace(/[^\d.]/g, "") })}
                  inputMode="decimal"
                  placeholder="0.00"
                />
                <span className="note">
                  {draft.sale === "auction"
                    ? "A bid at or above this reserve starts the clock. You can change the reserve until the first bid."
                    : "The first person to pay this price gets the title. You can change the price until a buyer pays."}
                </span>
              </label>
              <dl className="quote-slip">
                <div>
                  <dt>{draft.sale === "auction" ? "Reserve" : "Price"}</dt>
                  <dd>{draft.titlePrice.trim() || "Type it above"} {symbol || "tokens"}</dd>
                </div>
                <div>
                  <dt>Opens</dt>
                  <dd>
                    {draft.saleDays || "unset"} days after graduation.
                    {cluster === "devnet" ? " On the practice network the escrow counts each of these days as one second." : ""}
                  </dd>
                </div>
                <div>
                  <dt>Paid in</dt>
                  <dd>This token only.</dd>
                </div>
                <div>
                  <dt>Burn</dt>
                  <dd>{SALE_BURN_PERCENT}% is burned by the escrow.</dd>
                </div>
                <div>
                  <dt>Creator</dt>
                  <dd>{creatorSalePercent()}% goes to you.</dd>
                </div>
                <div>
                  <dt>Program</dt>
                  <dd>{SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.</dd>
                </div>
                {draft.sale === "auction" ? (
                  <>
                    <div>
                      <dt>Clock</dt>
                      <dd>
                        {AUCTION_HOURS} hours after the first bid at the reserve.
                        {cluster === "devnet" ? " On the practice network this clock is 72 seconds." : ""} The escrow program sets this clock.
                      </dd>
                    </div>
                    <div>
                      <dt>Extension</dt>
                      <dd>
                        A bid in the last hour moves the end to {AUCTION_EXTEND_HOURS} hour after that bid.
                        {cluster === "devnet" ? " On the practice network that extension is 1 second." : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>No bid</dt>
                      <dd>
                        The title stays {AUCTION_SIT_DAYS} days. You can take it back after that. It does not come back on its own.
                        {cluster === "devnet" ? " On the practice network that wait is 60 seconds." : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Finish</dt>
                      <dd>This site finishes the auction when the clock ends.</dd>
                    </div>
                  </>
                ) : (
                  <div>
                    <dt>Who gets it</dt>
                    <dd>The first person to pay the price.</dd>
                  </div>
                )}
              </dl>
            </>
          ) : null}
        </form>
      ) : null}

      {step === "Redemption" ? (
        <form>
          <label>
            Days for the maker to hand it over after the title holder claims it
            <input value={draft.shipDays} onChange={(event) => patch({ shipDays: event.target.value })} inputMode="numeric" />
          </label>
          <label>
            Handoff
            <textarea value={draft.shipping} onChange={(event) => patch({ shipping: event.target.value })} rows={2} />
          </label>
          <label>
            Declared value if the object cannot be delivered, {unit}
            <input value={draft.declared} onChange={(event) => patch({ declared: event.target.value })} inputMode="decimal" />
          </label>
          <label>
            If a claim goes wrong
            <textarea
              value={draft.terms}
              onChange={(event) => patch({ terms: event.target.value })}
              rows={4}
              required
            />
            <span className="note">
              Do not write that the price will go up, or promise a return. That is what the SEC hammers.
              Write what is done if a claim goes wrong, and what you are liable for. This card cannot be left blank.
              These words lock when the asset is created.
            </span>
          </label>
          <p className="note">
            PAR does not hold the object, the tokens, or this payment. The person named on this page owes what
            this card says.
          </p>
        </form>
      ) : null}

      {step === "Names" ? (
        <form>
          <label>
            Asset name
            <input value={draft.assetName} onChange={(event) => patch({ assetName: event.target.value })} />
            <span className="note">The object. This is the title of the buyer page.</span>
          </label>
          <label>
            Token name
            <input value={draft.tokenName} onChange={(event) => patch({ tokenName: event.target.value })} />
            <span className="note">What the wallet holds. This is the claim to the object.</span>
          </label>
          <label>
            Symbol
            <input
              value={draft.symbol}
              onChange={(event) => patch({ symbol: event.target.value.toUpperCase() })}
              maxLength={8}
            />
          </label>
        </form>
      ) : null}

      {step === "Curve" ? (
        <form>
          <p className="note">
            The coin on this page is created on PAR. You set one price for the shelf. Most tokens buyers receive
            stay within 10% of it, then the last slice walks to the pool price. The curve sells {draft.tokenName || "the token"}.
            It does not appraise {draft.assetName || "the object"}. Graduation opens a DAMM v2 pool for the token.
            The redemption rule stays on this page. A token whose price climbs from the first buy is created on the home page.
          </p>
          <div className="segmented" role="group" aria-label="Quote">
            <button type="button" aria-pressed={draft.quote === "USDC"} onClick={() => patch({ quote: "USDC", ...pricesFor("1000") })}>
              USDC
            </button>
            <button type="button" aria-pressed={draft.quote === "SOL"} onClick={() => patch({ quote: "SOL", ...pricesFor("10") })}>
              SOL
            </button>
          </div>
          <p className="note">
            What is the whole supply worth at par? Pick a number or type one. It is your price for the start of the
            sale, not an appraisal. There are always one billion tokens. After graduation the token trades in its
            pool, and the price there is set by buyers and sellers.
          </p>
          <div className="segmented asset-values" role="group" aria-label="Whole supply at par">
            {VALUES[draft.quote].map((amount) => (
              <button
                key={amount}
                type="button"
                aria-pressed={Number(draft.value) === amount}
                onClick={() => patch(pricesFor(String(amount)))}
              >
                {draft.quote === "USDC" ? `$${amount.toLocaleString("en-US")}` : `${amount.toLocaleString("en-US")} SOL`}
              </button>
            ))}
          </div>
          <label>
            Whole supply at par, {unit}
            <input
              value={draft.value}
              onChange={(event) => patch(pricesFor(event.target.value.replace(/[^\d.]/g, "")))}
              inputMode="decimal"
            />
            <span className="note">
              Par {draft.par || "unset"} {unit} per token. Pool price {draft.pool || "unset"} {unit} per token, 20% above par.
            </span>
          </label>
          {curve.locked ? <p className="note">{curve.locked}</p> : null}
          <div className="segmented" role="group" aria-label="Curve fee">
            <button type="button" aria-pressed={draft.fee === "fall"} onClick={() => patch({ fee: "fall" })}>
              Fee falls
            </button>
            <button type="button" aria-pressed={draft.fee === "flat"} onClick={() => patch({ fee: "flat" })}>
              Fee stays flat
            </button>
          </div>
          <label>
            {draft.fee === "flat" ? "Fee until graduation, percent" : "Trading fee at the open, percent"}
            <input value={draft.feeOpen} onChange={(event) => patch({ feeOpen: event.target.value })} inputMode="decimal" />
          </label>
          {draft.fee === "fall" ? (
            <>
              <label>
                Ending fee, percent
                <input value={draft.feeEnd} onChange={(event) => patch({ feeEnd: event.target.value })} inputMode="decimal" />
              </label>
              <div className="segmented" role="group" aria-label="How the fee falls">
                <button type="button" aria-pressed={!draft.straightFall} onClick={() => patch({ straightFall: false })}>
                  Curved fall
                </button>
                <button type="button" aria-pressed={draft.straightFall} onClick={() => patch({ straightFall: true })}>
                  Straight fall
                </button>
              </div>
              <p className="note">
                {draft.straightFall
                  ? "A straight fall drops by the same amount on each step of the 12 hour clock."
                  : "A curved fall drops faster at the start, then slows as it nears the ending fee. The clock is 12 hours."}
              </p>
            </>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={draft.dynamicFee} onChange={(event) => patch({ dynamicFee: event.target.checked })} />
            Add a volatility fee on the curve
          </label>
          <p className="note">
            The amount is the fee percent above. Meteora can add a volatility piece on top of that percent while the price is moving fast. The piece is at most one fifth of the fee you typed, so a 25% fee can rise by up to 5 points, then it fades when the price is calm. The two together still stop at 99%. There is no second box: the ceiling is one fifth of the fee already typed. It does not change the lock.
          </p>
          <section className="card">
            <h2>The fee on this form</h2>
            <p>
              Buyers pay the percent you type above, on each trade while the coin is on the curve. A flat fee stays at that percent. A falling fee moves from the opening percent to the ending percent.
            </p>
            <p>Meteora keeps {METEORA_TRADING_FEE_PERCENT}% of that fee. That share stays on.</p>
            <p>
              {platformCut === 0
                ? `PAR keeps none of that fee. You keep the other ${creatorCut}%.`
                : `PAR keeps ${platformCut}% of that fee. You keep ${creatorCut}%. Those shares stay on for this coin.`}
            </p>
            <p>
              You keep your share the whole time the coin trades on the curve. Volatility is optional. Leave that box empty and there is no volatility fee. Checked, Meteora can add at most one fifth of the fee you typed, and the total still stops at 99%.
            </p>
            <p>
              After the lock, trades pay the pool fee below. Meteora keeps {METEORA_TRADING_FEE_PERCENT}% of that fee too.
              {platformCut === 0 ? " You keep the other 80%." : ` You keep ${creatorCut}% and PAR keeps ${platformCut}%.`}
              {" "}Putting pool fees back into the pool is optional, and it can be off. Leave it off and those shares can be claimed. Turn it on and the share you type is added back into the pool. At 100%, nothing of that pool fee is left to claim. The locked tokens and quote stay in the pool either way.
            </p>
            <p>When the pool opens, Meteora takes 0.2% of the tokens and 0.2% of the quote. That share stays on. This form adds no second skim and charges no pool creation fee.</p>
            <p>
              {rail === "escrow"
                ? `The title sale is separate from this trading fee. Escrow is selected, so the title is ${draft.sale === "auction" ? "auctioned" : "sold"} only through the PAR escrow program. The program burns ${SALE_BURN_PERCENT}% of the price, keeps ${SALE_PROGRAM_FEE_PERCENT}%, and pays you ${creatorSalePercent()}%.`
                : `The title sale is separate from this trading fee. Tensor is selected, so the title is listed through Tensor's marketplace program. Tensor pays you the full price. The buyer pays Tensor about ${TENSOR_TAKER_FEE_PERCENT}% on top. PAR takes none of that sale. Within ${CREATOR_BURN_DAYS} days you burn ${SALE_BURN_PERCENT}% of the price and keep the rest.`}
            </p>
          </section>
          <label className="check">
            <input type="checkbox" checked={draft.compoundOn} onChange={(event) => patch({ compoundOn: event.target.checked })} />
            Put pool fees back into the pool after the lock
          </label>
          {draft.compoundOn ? (
            <>
              <label>
                Pool fee after the lock, percent
                <input value={draft.poolFee} onChange={(event) => patch({ poolFee: event.target.value })} inputMode="decimal" />
              </label>
              <label>
                Share of that fee put back into the pool, percent
                <input value={draft.compoundShare} onChange={(event) => patch({ compoundShare: event.target.value })} inputMode="decimal" />
              </label>
              <p className="note">
                After the lock, trades pay this pool fee in the quote. The share you type is added back to the pool. The quote that locks does not change. The liquidity stays locked. At 100%, nothing from that pool fee is left to claim.
              </p>
            </>
          ) : (
            <>
              <div className="choices" role="group" aria-label="Pool fee after the lock">
                {MIGRATION_FEE_CHOICES.map((choice) => (
                  <button key={choice.bps} type="button" aria-pressed={draft.poolFeeBps === choice.bps} onClick={() => patch({ poolFeeBps: choice.bps })}>
                    {choice.label}
                  </button>
                ))}
              </div>
              <p className="note">After the lock, every swap pays {migrationFeeLabel(draft.poolFeeBps)}. The liquidity stays locked.</p>
            </>
          )}
          {sizeLine ? <p className="note">{sizeLine}</p> : null}
        </form>
      ) : null}

      {step === "Pitch" ? (
        <form>
          <label>
            Pitch
            <textarea value={draft.pitch} onChange={(event) => patch({ pitch: event.target.value })} rows={6} />
            <span className="note">
              The pitch is the creator&apos;s words about the object and its meme. It locks on the record sheet. Do not write that the price will go up, or promise a return. That is what the SEC hammers. Leave it blank if there is no pitch.
            </span>
          </label>
        </form>
      ) : null}

      {step === "Buyer page" ? (
        <div className="rights-grid">
          <article className="card">
            <p className="eyebrow">Product and rights</p>
            <h2>{draft.assetName || "Asset"}</h2>
            <p>{draft.story}</p>
            <p>{draft.pitch.trim() || "No pitch."}</p>
            <dl>
              <div>
                <dt>Object</dt>
                <dd>{draft.kind}</dd>
              </div>
              <div>
                <dt>Exists now</dt>
                <dd>{draft.existsNow === "yes" ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>Holder</dt>
                <dd>{draft.holder}</dd>
              </div>
              <div>
                <dt>Where</dt>
                <dd>{draft.where}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{draft.makerName}</dd>
              </div>
              <div>
                <dt>Responsible</dt>
                <dd>
                  {draft.maker}. {draft.role}.
                </dd>
              </div>
              <div>
                <dt>Work</dt>
                <dd>{draft.work}</dd>
              </div>
              <div>
                <dt>Claim</dt>
                <dd>{draft.claim}</dd>
              </div>
              <div>
                <dt>Redemption</dt>
                <dd>
                  The title holder claims it. Handoff in {draft.shipDays} days. {draft.shipping}
                </dd>
              </div>
              <div>
                <dt>If a claim goes wrong</dt>
                <dd className="asset-terms">{draft.terms}</dd>
              </div>
            </dl>
            <p className="note">
              These words locked with the asset. They cannot be changed. A buyer buys into them. Meteora did not
              issue this token. PAR does not hold the object, the tokens, or this payment. The person named here
              owes what the card says.
            </p>
            <p className="note">
              {COIN_WORDS} No vault or fund holds the object. What stands behind the handoff is the person named
              here, this card, and a record that cannot be changed.
            </p>
          </article>
          <article className="card">
            <p className="eyebrow">Trade and pool</p>
            <h2>
              {draft.tokenName || "Token"} <span>{symbol}</span>
            </h2>
            {pictureView ? (
              <img className="asset-picture" src={pictureView} alt={draft.tokenName || "Token"} />
            ) : (
              <p className="note">No picture yet. The picture from the Object step is the token image and the record image.</p>
            )}
            <dl>
              <div>
                <dt>Token address</dt>
                <dd>{tokenMint}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{draft.tokenName || "Token"}</dd>
              </div>
              <div>
                <dt>Symbol</dt>
                <dd>{symbol || "Unset"}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{BASE_DECIMALS}</dd>
              </div>
              <div>
                <dt>Supply</dt>
                <dd>1,000,000,000</dd>
              </div>
              <div>
                <dt>Quote</dt>
                <dd>{unit}</dd>
              </div>
              <div>
                <dt>Quote mint</dt>
                <dd>{quoteMint}</dd>
              </div>
              <div>
                <dt>Pool</dt>
                <dd>{poolAddress}</dd>
              </div>
              <div>
                <dt>Par</dt>
                <dd>
                  {draft.par} {unit}
                </dd>
              </div>
              <div>
                <dt>Pool price</dt>
                <dd>
                  {draft.pool} {unit}
                </dd>
              </div>
              <div>
                <dt>Fee</dt>
                <dd>
                  {draft.fee === "flat"
                    ? `${draft.feeOpen}% until graduation`
                    : `${draft.feeOpen}% falling ${draft.straightFall ? "in a straight line" : "on a curve"} to ${draft.feeEnd}%`}
                  {draft.dynamicFee ? " Volatility can add at most one fifth of that fee." : " No volatility fee."}
                </dd>
              </div>
              <div>
                <dt>Fee split</dt>
                <dd>
                  Meteora {METEORA_TRADING_FEE_PERCENT}%. PAR {platformCut}%. You {creatorCut}%.
                </dd>
              </div>
              <div>
                <dt>Sale path</dt>
                <dd>
                  {rail === "escrow"
                    ? `PAR escrow. ${draft.sale === "auction" ? "Auction" : "Fixed price"} at ${draft.titlePrice.trim() || "unset"} ${symbol || "tokens"}. Opens ${draft.saleDays} ${waitUnit} after graduation.`
                    : `Tensor. Opens ${draft.saleDays} days after graduation. Listed from the PAR sale page.`}
                </dd>
              </div>
              <div>
                <dt>After graduation</dt>
                <dd>
                  A DAMM v2 pool. The quote raised on the curve and the remaining tokens lock there.
                  {draft.compoundOn
                    ? ` ${draft.compoundShare}% of the ${draft.poolFee}% pool fee is put back into the pool.`
                    : ` The pool fee is ${bpsToPercent(draft.poolFeeBps)}.`}
                </dd>
              </div>
            </dl>
            <p className="note">
              The trading price is what buyers pay for {symbol || "the token"}. The redemption rule is the other
              panel. One does not set the other.
            </p>
            {sizeLine ? <p className="note">{sizeLine}</p> : null}
          </article>
        </div>
      ) : null}

      {step === "Sheet" ? (
        <div className="asset-sheet">
          <p className="note">
            {rail === "escrow"
              ? draft.sale === "auction"
                ? "Sale path: PAR escrow. These words say the title is auctioned only through the PAR escrow program, because Escrow is selected on Claim."
                : "Sale path: PAR escrow. These words say the title is sold only through the PAR escrow program, because Escrow is selected on Claim."
              : "Sale path: Tensor. These words say the title is listed through Tensor's marketplace program, because Tensor is selected on Claim."}
          </p>
          <p className="note">
            The NFT in a wallet shows the name, the picture, and short traits: the token address, the sale path, and a link named full sheet. That link is a page on Arweave. Opening it shows this whole sheet, the promises, the token address, and the picture. The same facts are stored in the record file the NFT points at.
          </p>
          <ol className="beats asset-beats">
            {sheet.map(([title, body]) => (
              <li key={title}>
                <article>
                  <strong>{title}</strong>
                  <span>{body}</span>
                </article>
              </li>
            ))}
          </ol>
          {pictureView ? <img className="asset-picture" src={pictureView} alt={draft.assetName || "Asset"} /> : null}
          <RecordCreate
            draft={draft}
            rows={sheet}
            picture={picture}
            pictureCopy={pictureCopy}
            problem={firstProblem(draft, checks)}
            platform={platform}
            curveLines={[curve.locked, sizeLine].filter(Boolean).join(" ")}
            preparedKeys={preparedKeys}
          />
        </div>
      ) : null}

      {tried && problem ? <p className="error">{problem}</p> : null}

      <div className="asset-nav">
        <button type="button" disabled={index === 0} onClick={() => go(STEPS[index - 1])}>
          Back
        </button>
        {index < STEPS.length - 1 ? (
          <button type="button" className="solid" onClick={forward}>
            Next
          </button>
        ) : null}
      </div>
    </div>
  );
}
