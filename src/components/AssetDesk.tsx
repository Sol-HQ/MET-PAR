"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { signedPictureHeaders } from "@/lib/picture";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LawRecord } from "@/components/LawRecord";
import { RecordCreate } from "@/components/RecordCreate";
import { DEFAULT_FEE_DECAY_SECONDS, DEFAULT_MIGRATION_FEE_BPS } from "@/lib/constants";
import { shrinkImageUnder } from "@/lib/image";
import { BILLION_SUPPLY, checkParPrices, type LaunchChoice } from "@/lib/launch";
import { DEFAULT_PLATFORM_SETTINGS, assertCurveFee, parseFeePercent, type PlatformSettings } from "@/lib/platform";
import { FREE_UPLOAD_BYTES } from "@/lib/record";
import { useCluster } from "@/lib/cluster";
import { AUCTION_EXTEND_HOURS, AUCTION_HOURS, AUCTION_SIT_DAYS, chosenRail, COIN_WORDS, creatorSalePercent, ESCROW_COMING, escrowDepositAllowed, SALE_BURN_PERCENT, SALE_DAY_PRESETS, SALE_DELAY_DAYS, SALE_PROGRAM_FEE_PERCENT, saleVenueWords } from "@/lib/title";

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
};

export function launchChoice(draft: Draft): LaunchChoice {
  return { kind: "custom-par", supply: BILLION_SUPPLY, parPrice: Number(draft.par), poolPrice: Number(draft.pool) };
}

function example(partial: Omit<Draft, "existsNow" | "marks" | "saleDays" | "sale" | "hold" | "serial" | "makerName" | "pitch" | "quote" | "value" | "par" | "pool" | "fee" | "feeOpen"> & Partial<Draft>): Draft {
  return {
    existsNow: "yes",
    marks: "own",
    serial: "",
    makerName: "",
    pitch: "",
    saleDays: String(SALE_DELAY_DAYS),
    sale: "fixed",
    hold: "wallet",
    quote: "USDC",
    fee: "fall",
    feeOpen: "5",
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
    const endingBps = draft.fee === "flat" ? openingBps : Math.min(openingBps, platform.platformFeeBps);
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
      DEFAULT_MIGRATION_FEE_BPS,
      draft.quote === "SOL" ? "sol" : "usdc",
    );
    if (marks.picture.ok) return { error: "", parCap: marks.picture.parMarketCap, locked: marks.picture.locked };
    return { error: marks.supply || marks.par || marks.pool || marks.picture.error || "That curve does not fit.", parCap: "", locked: "" };
  }, [draft.feeOpen, draft.fee, draft.par, draft.pool, draft.quote, platform]);

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
      ["Object", `${draft.assetName || draft.objectName}. ${draft.kind}. ${draft.existsNow === "yes" ? "It exists now." : "It does not exist yet."}`],
      ["Serial", draft.serial.trim() || "None"],
      ["Holder", `${draft.holder}, ${draft.where}.`],
      ["Maker", `${draft.makerName.trim()}, ${draft.role}.`],
      ["Pitch", draft.pitch.trim() || "None"],
      ["Work", draft.work],
      ["Claim", draft.claim],
      ["Redemption", `The holder of the title claims it. Delivery takes ${draft.shipDays} days after the claim. ${draft.shipping} If a claim goes wrong: ${draft.terms}`],
      ["Title sale", `The title is listed from the PAR sale page through the ${saleVenueWords(rail)}, only for ${symbol || "the token"}, not before ${draft.saleDays} days after graduation. ${
        rail === "escrow"
          ? `${draft.sale === "auction" ? `It is an auction. The clock starts on the first bid at the reserve and runs ${AUCTION_HOURS} hours. A bid in the last hour extends it ${AUCTION_EXTEND_HOURS} hour. With no bid it sits ${AUCTION_SIT_DAYS} days and does not return on its own. ` : "The first person to pay the price gets it. "}${SALE_BURN_PERCENT}% of the price is burned, ${creatorSalePercent()}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
          : `${SALE_BURN_PERCENT}% of the price is burned and ${100 - SALE_BURN_PERCENT}% goes to the creator.`
      }`],
      ["Token", `${draft.tokenName} (${symbol}). ${COIN_WORDS}`],
      ["Curve", `PAR on a Meteora bonding curve, quoted in ${unit}. Par ${draft.par} ${unit}. Pool price ${draft.pool} ${unit}. ${curve.locked} ${draft.fee === "flat" ? `The fee stays at ${draft.feeOpen}% until graduation.` : `The fee starts at ${draft.feeOpen}% and falls to 1%.`} Graduation locks the sale into a DAMM v2 pool. ${sizeLine}`],
    ],
    [draft, symbol, unit, sizeLine, curve.locked, rail],
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
          {COIN_WORDS} The steps name the object, the person, the handoff, and the pitch. They fit any one object: a painting, a card, a kite, a ball, a photograph, or something else. One example is filled in.
          The other examples use the same steps. A plain PAR token is created on the home page and has no title.
          Here, the last step creates the coin, then the master, then one edition. The master is sent to the
          program vault and stays frozen. That one edition is the title, and it is sent to the creator wallet.
          The NFT on the chain is the proof. PAR keeps a copy of those proofs. After graduation the coin trades for the days set
          on the Claim step, and then the creator lists the title through Tensor. The title can go into the escrow,
          and that program sells it. Both NFTs hold the record sheet, the meta sheet. {ESCROW_COMING}
        </p>
        <button type="button" aria-pressed={lawOpen} onClick={() => setLawOpen((open) => !open)}>
          {lawOpen ? "Close the structure and the law" : "Structure and the law"}
        </button>
        {lawOpen ? <LawRecord /> : null}
        <Link href="/" className="asset-link">
          Back to PAR
        </Link>
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
            There is one asset and one title. {COIN_WORDS} The title can be bought {draft.saleDays || "some"} days
            after graduation.{" "}
            The Tensor path keeps the title in your wallet. It is not frozen. When the sale opens, you list it on
            its PAR sale page. That page uses Tensor&apos;s program. Tensor pays you the full price, and you burn{" "}
            {SALE_BURN_PERCENT}% of it. The listing may also show on Tensor&apos;s site. The escrow path holds the
            title. At the sale it burns {SALE_BURN_PERCENT}%, pays {creatorSalePercent()}% to the creator, and pays{" "}
            {SALE_PROGRAM_FEE_PERCENT}% to the PAR program.
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
              <p className="note">
                {draft.sale === "auction"
                  ? `The title sits after the wait. The first bid at the reserve starts a ${AUCTION_HOURS}-hour clock. A bid in the last hour moves the end out by ${AUCTION_EXTEND_HOURS} hour. If nobody bids, it stays ${AUCTION_SIT_DAYS} days and does not come back on its own.`
                  : "The first person to pay the price gets the title."}
              </p>
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
            The curve sells {draft.tokenName || "the token"}. It does not appraise {draft.assetName || "the object"}.
            Buyers come in near one price, then the last slice walks to the pool price. Graduation opens a DAMM v2
            pool for the token. The redemption rule stays on the asset page.
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
              Fee falls to 1%
            </button>
            <button type="button" aria-pressed={draft.fee === "flat"} onClick={() => patch({ fee: "flat" })}>
              Fee stays flat
            </button>
          </div>
          <label>
            {draft.fee === "flat" ? "Fee until graduation, percent" : "Trading fee at the open, percent"}
            <input value={draft.feeOpen} onChange={(event) => patch({ feeOpen: event.target.value })} inputMode="decimal" />
          </label>
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
            <dl>
              <div>
                <dt>Quote</dt>
                <dd>{unit}</dd>
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
                    : `${draft.feeOpen}% falling to 1%`}
                </dd>
              </div>
              <div>
                <dt>After graduation</dt>
                <dd>A DAMM v2 pool. The quote raised on the curve and the remaining tokens lock there.</dd>
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
          <p className="note">This is your record sheet, your meta sheet. Both NFTs carry it.</p>
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
