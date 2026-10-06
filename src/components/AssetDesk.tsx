"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { signedPictureHeaders } from "@/lib/picture";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LawRecord } from "@/components/LawRecord";
import { RecordCreate } from "@/components/RecordCreate";
import { readClassicMint, readCoin, type CoinFacts, type PayFacts } from "@/lib/coin-read";
import { DEFAULT_MIGRATION_FEE_BPS, USDC_DEVNET, USDC_MAINNET, WSOL } from "@/lib/constants";
import { bpsToPercent } from "@/lib/format";
import { shrinkImageUnder } from "@/lib/image";
import { BILLION_SUPPLY, type LaunchChoice } from "@/lib/launch";
import { METEORA_TRADING_FEE_PERCENT } from "@/lib/platform";
import { FREE_UPLOAD_BYTES } from "@/lib/record";
import { clearRwaDraft, rwaDraftKey } from "@/lib/rwa-draft";
import { useCluster } from "@/lib/cluster";
import { parseTokenAmount } from "@/lib/tensor-sale";
import { AUCTION_EXTEND_HOURS, AUCTION_HOURS, AUCTION_SIT_DAYS, CREATOR_BURN_DAYS, TENSOR_TAKER_FEE_PERCENT, chosenRail, COIN_WORDS, creatorSalePercent, ESCROW_COMING, escrowDepositAllowed, SALE_BURN_PERCENT, SALE_DAY_PRESETS, SALE_DELAY_DAYS, SALE_PROGRAM_FEE_PERCENT } from "@/lib/title";

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

const COIN_STEPS = ["Object", "Maker", "Coin", "Names", "Claim", "Redemption", "Pitch", "Buyer page", "Sheet"] as const;
const PLAIN_STEPS = ["Object", "Maker", "Price", "Names", "Claim", "Redemption", "Pitch", "Buyer page", "Sheet"] as const;
const STEPS = [...COIN_STEPS, "Price"] as const;

type Step = (typeof STEPS)[number];

type SavedDraft = {
  step: Step;
  example: ExampleId;
  draft: Draft;
  withCoin: boolean | null;
  coinInput: string;
  coin: CoinFacts | null;
  payInput: string;
  pay: PayFacts | null;
  pictureCopy: string;
  pictureNote: string;
  pictureBase64: string;
};

function isStep(value: unknown): value is Step {
  return typeof value === "string" && (STEPS as readonly string[]).includes(value);
}

function readSavedDraft(): SavedDraft | null {
  try {
    const raw = sessionStorage.getItem(rwaDraftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedDraft>;
    if (!parsed.draft || typeof parsed.draft !== "object" || typeof parsed.draft.objectName !== "string") return null;
    if (!isStep(parsed.step)) return null;
    return {
      step: parsed.step,
      example: parsed.example === "kite" || parsed.example === "card" || parsed.example === "painting" ? parsed.example : "painting",
      draft: { ...EXAMPLES.painting, ...parsed.draft },
      withCoin: parsed.withCoin === true || parsed.withCoin === false ? parsed.withCoin : null,
      coinInput: typeof parsed.coinInput === "string" ? parsed.coinInput : "",
      coin: parsed.coin && typeof parsed.coin.mint === "string" ? parsed.coin : null,
      payInput: typeof parsed.payInput === "string" ? parsed.payInput : "",
      pay: parsed.pay && typeof parsed.pay.mint === "string" ? parsed.pay : null,
      pictureCopy: typeof parsed.pictureCopy === "string" ? parsed.pictureCopy : "",
      pictureNote: typeof parsed.pictureNote === "string" ? parsed.pictureNote : "",
      pictureBase64: typeof parsed.pictureBase64 === "string" ? parsed.pictureBase64 : "",
    };
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function base64ToBlob(value: string): Blob {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

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
  /** Share of an escrow sale that is burned. A whole percent from 0 to 98. The program keeps 2%. */
  burnPercent: string;
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

function example(partial: Omit<Draft, "existsNow" | "marks" | "saleDays" | "sale" | "titlePrice" | "burnPercent" | "hold" | "serial" | "makerName" | "pitch" | "quote" | "value" | "par" | "pool" | "fee" | "feeOpen" | "feeEnd" | "straightFall" | "dynamicFee" | "compoundOn" | "poolFee" | "compoundShare" | "poolFeeBps"> & Partial<Draft>): Draft {
  return {
    existsNow: "yes",
    marks: "own",
    serial: "",
    makerName: "",
    pitch: "",
    saleDays: String(SALE_DELAY_DAYS),
    sale: "fixed",
    titlePrice: "",
    burnPercent: String(SALE_BURN_PERCENT),
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
    pitch: "One signed painting, still in the studio.",
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
    pitch: "The kite on this page stays with the maker. The title is a claim to a sister kite, built the same way.",
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
    pitch: "One card, in a sleeve, with the number on this sheet.",
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
    pitch: "One piece in the studio.",
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
    pitch: "One watch, serial on this sheet.",
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
    pitch: "One vehicle, identification number on this sheet. The handoff is the papers and the keys.",
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
    pitch: "One numbered bar in the vault named here.",
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

function wholeBurn(value: string) {
  if (!/^\d+$/.test(value.trim())) return null;
  const burn = Number(value);
  if (!Number.isInteger(burn) || burn < 0 || burn > 98) return null;
  return burn;
}

function positive(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

type Checks = { hasPicture: boolean; withCoin: boolean | null; coin: boolean; pay: boolean; decimals: number };

function problemFor(step: Step, draft: Draft, checks: Checks) {
  if (checks.withCoin === null) return "Choose whether a coin goes with this title.";
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
    if (checks.withCoin && wholeDays(draft.saleDays) === null) return "The days after graduation before the title sale are a whole number from 1 to 365.";
    if (checks.withCoin && wholeBurn(draft.burnPercent) === null) return "The burn is a whole percent from 0 to 98. The PAR program keeps 2%.";
    if (checks.withCoin && draft.hold === "escrow" && !parseTokenAmount(draft.titlePrice, checks.decimals)) {
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
    if (!draft.assetName.trim()) return "The object needs a name.";
    if (draft.assetName.length > 32) return "The asset name is 32 characters or fewer.";
  }
  if (step === "Coin") {
    if (!checks.coin) return "Paste the token address and read the coin. This page will not create a title until that coin is read.";
  }
  if (step === "Price") {
    if (!checks.pay) return "Paste the token the buyer pays with, and read it. This page will not create a title until that token is read.";
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
  const list = checks.withCoin === false ? PLAIN_STEPS : COIN_STEPS;
  for (const step of list) {
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
  const [picture, setPicture] = useState<Blob | null>(null);
  const [pictureCopy, setPictureCopy] = useState("");
  const [pictureView, setPictureView] = useState("");
  const [pictureNote, setPictureNote] = useState("");
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signMessage } = useWallet();
  const [withCoin, setWithCoin] = useState<boolean | null>(null);
  const [coinInput, setCoinInput] = useState("");
  const [coin, setCoin] = useState<CoinFacts | null>(null);
  const [coinNote, setCoinNote] = useState("");
  const [payInput, setPayInput] = useState("");
  const [pay, setPay] = useState<PayFacts | null>(null);
  const [payNote, setPayNote] = useState("");
  const [restored, setRestored] = useState(false);
  const symbol = (coin?.symbol || pay?.symbol || draft.symbol).trim().toUpperCase();
  const escrowLive = escrowDepositAllowed(cluster, publicKey?.toBase58());
  const rail = chosenRail(cluster, escrowLive ? draft.hold : "wallet");
  const unit = coin?.quoteSymbol || pay?.symbol || "";
  const [escrowHint, setEscrowHint] = useState("");
  const [preparedKeys] = useState(() => ({
    record: Keypair.generate(),
    title: Keypair.generate(),
  }));
  const tokenMint = coin?.mint || pay?.mint || "";
  const poolAddress = coin?.pool || "";
  const steps: Step[] = withCoin === false ? [...PLAIN_STEPS] : [...COIN_STEPS];
  const shortClock = cluster === "devnet" && rail === "escrow";
  const waitUnit = shortClock ? "seconds" : "days";

  useEffect(() => {
    const saved = readSavedDraft();
    if (saved) {
      setStep(saved.step);
      setExample(saved.example);
      setDraft(saved.draft);
      setWithCoin(saved.withCoin);
      setCoinInput(saved.coinInput);
      setCoin(saved.coin);
      setPayInput(saved.payInput);
      setPay(saved.pay);
      setPictureCopy(saved.pictureCopy);
      setPictureNote(saved.pictureNote);
      if (saved.pictureBase64) {
        const blob = base64ToBlob(saved.pictureBase64);
        setPicture(blob);
        setPictureView(URL.createObjectURL(blob));
      }
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    let cancel = false;
    void (async () => {
      let pictureBase64 = "";
      if (picture) {
        pictureBase64 = bytesToBase64(new Uint8Array(await picture.arrayBuffer()));
      }
      if (cancel) return;
      try {
        sessionStorage.setItem(
          rwaDraftKey(),
          JSON.stringify({
            step,
            example,
            draft,
            withCoin,
            coinInput,
            coin,
            payInput,
            pay,
            pictureCopy,
            pictureNote,
            pictureBase64,
          } satisfies SavedDraft),
        );
      } catch {
        /* A full picture can exceed the browser's storage. The fields still stay for this visit. */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [restored, step, example, draft, withCoin, coinInput, coin, payInput, pay, picture, pictureCopy, pictureNote]);

  useEffect(() => {
    if (escrowLive) {
      setEscrowHint("");
      return;
    }
    setDraft((current) => (current.hold === "escrow" ? { ...current, hold: "wallet" } : current));
  }, [escrowLive]);

  const checks: Checks = {
    hasPicture: Boolean(picture && pictureCopy),
    withCoin,
    coin: Boolean(coin),
    pay: Boolean(pay),
    decimals: coin?.decimals ?? pay?.decimals ?? 6,
  };
  const word = profitWord(draft);
  const problem =
    problemFor(step, draft, checks) ||
    (word ? `Take out "${word}". This page sells a claim to one object. It cannot promise profit, a rising price, or any return.` : "");
  const sizeLine = coin
    ? `At the opening price, all ${coin.supply} ${coin.symbol} together are priced at ${coin.wholeAtPar} ${coin.quoteSymbol}. The declared value of ${draft.assetName || "the object"} is ${draft.declared}. A buyer sees both numbers. Later trading can price the same supply at a different number.`
    : "";
  const index = steps.indexOf(step);

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
        withCoin === false
          ? "A fixed price or a bid, chosen on the sale page. The creator sets how long before the sale opens."
          : rail === "escrow"
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
            }${wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT}% of the price is burned by the escrow, ${creatorSalePercent(wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT)}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
          : coin
            ? `Tensor is selected on Claim. The title is listed from the PAR sale page through Tensor's marketplace program, only for ${coin.symbol}, and not before ${draft.saleDays} days after graduation. Tensor pays the creator the full price. The buyer pays Tensor about ${TENSOR_TAKER_FEE_PERCENT}% on top. PAR takes none of that sale. Within ${CREATOR_BURN_DAYS} days the creator burns ${wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT}% of the price and keeps the rest.`
            : `The buyer pays in ${pay?.symbol || "the token you name"}. After the title exists, the sale page takes a fixed price or a bid, and the number of days before the sale opens. On an escrow sale the program keeps 2%, and the burn is a whole percent from 0 to 98. On a Tensor sale, PAR takes none.`,
      ],
      [
        "Token",
        coin
          ? `${coin.name} (${coin.symbol}). Token address ${coin.mint}. ${coin.decimals} decimals. Supply ${coin.supply}. Quoted in ${coin.quoteSymbol}. Quote mint ${coin.quoteMint}. Pool ${coin.pool}. These facts are read from the coin and cannot be changed. ${COIN_WORDS} The picture on the Object step is the record image.`
          : pay
            ? `The buyer pays in ${pay.name} (${pay.symbol}). Token address ${pay.mint}. ${pay.decimals} decimals. The picture on the Object step is the record image.`
            : "No token has been read yet.",
      ],
      [
        "Picture",
        pictureView
          ? coin
            ? "The picture on this sheet is the record image. The coin keeps the image it was created with."
            : "The picture on this sheet is the record image."
          : "No picture yet. Add one on the Object step. That picture is the record image.",
      ],
      [
        withCoin === false ? "When it sells" : "Curve",
        coin
          ? `Read from the coin. Supply ${coin.supply}. Opening price ${coin.startPrice} ${coin.quoteSymbol}. Pool price ${coin.endPrice} ${coin.quoteSymbol}. At the opening price the whole supply is priced at ${coin.wholeAtPar} ${coin.quoteSymbol}. Fee ${bpsToPercent(coin.openingFeeBps)} to ${bpsToPercent(coin.endingFeeBps)}. Of that fee, Meteora ${METEORA_TRADING_FEE_PERCENT}%, PAR ${coin.platformFeePercent}%, creator ${coin.creatorFeePercent}%. ${coin.isMigrated ? "The coin has graduated." : "The coin has not graduated."} ${sizeLine}`
          : "The sale is a fixed price or a bid in the token named above. The creator sets how many days before it opens.",
      ],
    ],
    [draft, symbol, rail, waitUnit, shortClock, pictureView, coin, pay, sizeLine, withCoin],
  );

  function patch(partial: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function load(next: ExampleId) {
    setExample(next);
    setDraft(EXAMPLES[next]);
    setCoin(null);
    setPay(null);
    setTried(false);
  }

  function chooseCoin(yes: boolean) {
    setWithCoin(yes);
    setTried(false);
    if (!yes) {
      setCoin(null);
      setDraft((current) => (current.hold === "escrow" ? { ...current, hold: "wallet" } : current));
    } else {
      setPay(null);
    }
    setStep("Object");
  }

  async function loadCoin() {
    setCoin(null);
    setCoinNote("Reading the coin…");
    try {
      const read = await readCoin(connection, coinInput);
      setCoin(read);
      setCoinNote("Read from the coin. These fields stay as the coin has them.");
    } catch (cause) {
      setCoinNote(cause instanceof Error ? cause.message : "Could not read that coin.");
    }
  }

  async function loadPay(mint = payInput) {
    setPay(null);
    setPayNote("Reading the token…");
    try {
      const read = await readClassicMint(connection, mint);
      setPay(read);
      setPayInput(read.mint);
      setPayNote(`${read.name} (${read.symbol}). ${read.decimals} decimals. This token can be used. Token-2022 is refused.`);
    } catch (cause) {
      setPayNote(cause instanceof Error ? cause.message : "Could not read that token.");
    }
  }

  function go(next: Step) {
    if (!steps.includes(next)) return;
    const nextIndex = steps.indexOf(next);
    const redemptionIndex = steps.indexOf("Redemption");
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
    const next = steps[index + 1];
    if (next) go(next);
  }

  if (!restored) {
    return (
      <div className="desk asset-desk">
        <p className="note">Opening the draft.</p>
      </div>
    );
  }

  return (
    <div className="desk asset-desk">
      <section className="lede">
        <p className="eyebrow">Template</p>
        <h1>Real-world asset</h1>
        <p className="tagline">One object. One title.</p>
        <p className="note">What you type stays in this browser until the record is created. You can open the pool page, copy the token address, and come back.</p>
        <p>
          {withCoin === false
            ? "This page makes one title for one object. The token you name is what a buyer pays. After the title exists, you put it up at a fixed price or by bid, and you say how long before that sale opens."
            : withCoin === true
              ? "Create the coin on the home page first. Then paste that token address here. This page reads the coin. It does not let you type a different supply, price, or curve."
              : "Choose whether a coin goes with this title."}
        </p>
        <div className="segmented" role="group" aria-label="Does a coin go with this title">
          <button type="button" aria-pressed={withCoin === true} onClick={() => chooseCoin(true)}>
            A coin goes with this
          </button>
          <button type="button" aria-pressed={withCoin === false} onClick={() => chooseCoin(false)}>
            No coin
          </button>
        </div>
        <p className="note">
          {withCoin === null
            ? "Choose one before the steps. A title that says it has a coin cannot be created until that coin's token address is read."
            : withCoin
              ? "The Coin step asks for the token address. Leave it empty and the title cannot be created."
              : "The Price step asks for the token a buyer pays with. USDC, SOL, or another ordinary token. The sale page is where you set a fixed price or a bid, and how long before the sale opens."}
        </p>
        {withCoin === true ? <div className="beats">
          <article>
            <strong>1. The climb</strong>
            <span>
              The climb is the one already on the coin you paste. This page does not write a new supply or a new price.
            </span>
          </article>
          <article>
            <strong>2. The lock</strong>
            <span>
              The lock is graduation, already set on that coin. When the sale is full, Meteora moves the quote raised on the sale and the tokens still left into a DAMM v2 pool. The pool is locked, so that quote and those tokens cannot be withdrawn.
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
        </div> : null}
        {withCoin === true ? (
          <p>
            {COIN_WORDS} The steps name the object, the person, the handoff, and the pitch. They fit any one object: a painting, a card, a kite, a ball, a photograph, or something else. One example is filled in.
            The other examples use the same steps. A plain token is created on the home page and has no title.
          </p>
        ) : withCoin === false ? (
          <p>
            The steps name the object, the person who owes it, the handoff, and the promise on the title. They fit any one object: a painting, a card, a kite, a ball, a photograph, or something else. One example is filled in.
          </p>
        ) : null}
        <p>
          The last step creates the master, then one edition.
          {withCoin === true ? " It does not create the coin." : ""} The master is sent to the
          program vault and stays frozen. That one edition is the title, and it is sent to the creator wallet.
          The NFT on the chain is the proof. PAR keeps a copy of those proofs. Both NFTs hold the record sheet, the meta sheet.
        </p>
        <button type="button" aria-pressed={lawOpen} onClick={() => setLawOpen((open) => !open)}>
          {lawOpen ? "Close the structure and the law" : "Structure and the law"}
        </button>
        {lawOpen ? <LawRecord plain={withCoin !== true} /> : null}
        <div className="asset-nav">
          <Link href="/" className="asset-link">
            PAR
          </Link>
          <Link href="/pools" className="asset-link">
            Pools
          </Link>
          <Link href="/faqs" className="asset-link">
            FAQs
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
        {steps.map((name, item) => (
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
              ? withCoin
                ? "The page can say this person is responsible for the object, and that Meteora did not issue the token."
                : "The page can say this person is responsible for the object."
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
            There is one asset and one title.{" "}
            {withCoin
              ? `${COIN_WORDS} The title can be bought ${draft.saleDays || "some"} ${waitUnit} after graduation. `
              : "The token is what a buyer pays for this title. After it exists, the sale page takes a fixed price or a bid, and how many days before the sale opens. "}
            {withCoin && rail === "escrow"
              ? `Escrow is selected. The title goes into the PAR escrow. At the sale the program burns ${wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT}%, pays you ${creatorSalePercent(wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT)}%, and pays ${SALE_PROGRAM_FEE_PERCENT}% to the PAR program.`
              : withCoin
                ? `Tensor is selected. The title stays in your wallet. You list it on its PAR sale page through Tensor's marketplace program. Tensor pays you the full price. Within ${CREATOR_BURN_DAYS} days you burn ${wholeBurn(draft.burnPercent) ?? SALE_BURN_PERCENT}% of it and keep the rest. The listing may also show on Tensor's site. PAR takes none of that sale.`
                : "You can also name up to three wallets that take a fixed amount of that payment. The PAR program keeps 2% of an escrow sale."}
          </p>
          {withCoin ? <>
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
          <label>
            Burn, whole percent from 0 to 98
            <input
              value={draft.burnPercent}
              onChange={(event) => patch({ burnPercent: event.target.value.replace(/\D/g, "") })}
              inputMode="numeric"
            />
            <span className="note">
              {wholeBurn(draft.burnPercent) === null
                ? `Type a whole percent from 0 to 98. Zero burns nothing. The PAR program still keeps ${SALE_PROGRAM_FEE_PERCENT}% of an escrow sale.`
                : `Burn ${wholeBurn(draft.burnPercent)}%. On an escrow sale you receive ${creatorSalePercent(wholeBurn(draft.burnPercent) ?? 0)}% and the PAR program keeps ${SALE_PROGRAM_FEE_PERCENT}%. On a Tensor sale, Tensor pays you the full price and you burn this percent within ${CREATOR_BURN_DAYS} days.`}
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
                  <dd>{draft.burnPercent || "unset"}% is burned by the escrow.</dd>
                </div>
                <div>
                  <dt>Creator</dt>
                  <dd>{wholeBurn(draft.burnPercent) === null ? "Set the burn" : `${creatorSalePercent(wholeBurn(draft.burnPercent) ?? 0)}% goes to you.`}</dd>
                </div>
                <div>
                  <dt>Program</dt>
                  <dd>{SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program. This does not move.</dd>
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
          </> : <p className="note">The sale page is where you say how long before it opens. Zero opens the sale now. The highest is 365 days.</p>}
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
            Declared value if the object cannot be delivered{unit ? `, ${unit}` : ""}
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
          <p className="note">
            {withCoin
              ? coin
                ? `The coin is ${coin.name} (${coin.symbol}). Token address ${coin.mint}. Supply ${coin.supply}. That name is read from the coin.`
                : "The token name is read on the Coin step. Paste the token address there."
              : pay
                ? `The price is paid in ${pay.name} (${pay.symbol}). Token address ${pay.mint}.`
                : "The price token is read on the Price step."}
          </p>
        </form>
      ) : null}

      {step === "Coin" ? (
        <form>
          <p className="note">
            Paste the token address of a coin that already exists. This page reads the supply, the opening price, the pool price, and the fee from that coin. Those facts cannot be typed over.
          </p>
          <label>
            Token address
            <input value={coinInput} onChange={(event) => { setCoinInput(event.target.value.trim()); setCoin(null); setCoinNote(""); }} spellCheck={false} />
          </label>
          <button type="button" className="solid" onClick={() => void loadCoin()}>
            Read this coin
          </button>
          {coinNote ? <p className="note">{coinNote}</p> : null}
          {coin ? (
            <>
              <p className="note">Read from the coin. These fields cannot be edited.</p>
              <label>Name<input value={coin.name} readOnly /></label>
              <label>Symbol<input value={coin.symbol} readOnly /></label>
              <label>Token address<input value={coin.mint} readOnly /></label>
              <label>Supply<input value={coin.supply} readOnly /></label>
              <label>Decimals<input value={String(coin.decimals)} readOnly /></label>
              <label>Quote<input value={coin.quoteSymbol} readOnly /></label>
              <label>Quote mint<input value={coin.quoteMint} readOnly /></label>
              <label>Opening price<input value={`${coin.startPrice} ${coin.quoteSymbol}`} readOnly /></label>
              <label>Pool price<input value={`${coin.endPrice} ${coin.quoteSymbol}`} readOnly /></label>
              <label>Whole supply at the opening price<input value={`${coin.wholeAtPar} ${coin.quoteSymbol}`} readOnly /></label>
              <label>Pool<input value={coin.pool} readOnly /></label>
              <label>Fee<input value={`${bpsToPercent(coin.openingFeeBps)} to ${bpsToPercent(coin.endingFeeBps)}`} readOnly /></label>
              <label>Fee split<input value={`Meteora ${METEORA_TRADING_FEE_PERCENT}%. PAR ${coin.platformFeePercent}%. Creator ${coin.creatorFeePercent}%.`} readOnly /></label>
              <label>Graduated<input value={coin.isMigrated ? "Yes" : "Not yet"} readOnly /></label>
            </>
          ) : null}
        </form>
      ) : null}

      {step === "Price" ? (
        <form>
          <p className="note">
            Name the token a buyer pays with. USDC and SOL fill the known address. Any other ordinary token can be read. Token-2022 is refused. On the sale page you set a fixed price or a bid, and how long before the sale opens.
          </p>
          <div className="segmented" role="group" aria-label="Price token">
            <button type="button" onClick={() => void loadPay(cluster === "devnet" ? USDC_DEVNET : USDC_MAINNET)}>USDC</button>
            <button type="button" onClick={() => void loadPay(WSOL)}>SOL</button>
          </div>
          <label>
            Token address
            <input value={payInput} onChange={(event) => { setPayInput(event.target.value.trim()); setPay(null); setPayNote(""); }} spellCheck={false} />
          </label>
          <button type="button" className="solid" onClick={() => void loadPay()}>
            Read this token
          </button>
          {payNote ? <p className="note">{payNote}</p> : null}
          {pay ? (
            <>
              <p className="note">Read from the token. These fields cannot be edited.</p>
              <label>Name<input value={pay.name} readOnly /></label>
              <label>Symbol<input value={pay.symbol} readOnly /></label>
              <label>Token address<input value={pay.mint} readOnly /></label>
              <label>Decimals<input value={String(pay.decimals)} readOnly /></label>
            </>
          ) : null}
        </form>
      ) : null}


      {step === "Pitch" ? (
        <form>
          <label>
            Pitch
            <textarea value={draft.pitch} onChange={(event) => patch({ pitch: event.target.value })} rows={6} />
            <span className="note">
              {withCoin
                ? "The pitch is the creator's words about the object and its meme. It locks on the record sheet. Do not write that the price will go up, or promise a return. That is what the SEC hammers. Leave it blank if there is no pitch."
                : "The pitch is the creator's words about the object. It locks on the record sheet. Do not write that the price will go up, or promise a return. That is what the SEC hammers. Leave it blank if there is no pitch."}
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
              These words locked with the asset. They cannot be changed. A buyer buys into them.
              {withCoin ? " Meteora did not issue this token." : ""} PAR does not hold the object, the tokens, or this payment. The person named here
              owes what the card says.
            </p>
            <p className="note">
              {withCoin ? `${COIN_WORDS} ` : "The token named here is what a buyer pays for the title. "}
              No vault or fund holds the object. What stands behind the handoff is the person named
              here, this card, and a record that cannot be changed.
            </p>
          </article>
          <article className="card">
            <p className="eyebrow">{coin ? "The coin" : "Payment"}</p>
            <h2>
              {coin?.name || pay?.name || "Token"} <span>{symbol}</span>
            </h2>
            {pictureView ? (
              <img className="asset-picture" src={pictureView} alt={coin?.name || pay?.name || "Record"} />
            ) : (
              <p className="note">No picture yet. The picture from the Object step is the record image.</p>
            )}
            <dl>
              <div>
                <dt>Token address</dt>
                <dd>{tokenMint || "Unread"}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{coin?.name || pay?.name || "Unread"}</dd>
              </div>
              <div>
                <dt>Symbol</dt>
                <dd>{symbol || "Unset"}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{coin?.decimals ?? pay?.decimals ?? "Unread"}</dd>
              </div>
              {coin ? (
                <>
                  <div>
                    <dt>Supply</dt>
                    <dd>{coin.supply}</dd>
                  </div>
                  <div>
                    <dt>Quote</dt>
                    <dd>{coin.quoteSymbol}</dd>
                  </div>
                  <div>
                    <dt>Quote mint</dt>
                    <dd>{coin.quoteMint}</dd>
                  </div>
                  <div>
                    <dt>Pool</dt>
                    <dd>{poolAddress}</dd>
                  </div>
                  <div>
                    <dt>Opening price</dt>
                    <dd>{`${coin.startPrice} ${coin.quoteSymbol}`}</dd>
                  </div>
                  <div>
                    <dt>Pool price</dt>
                    <dd>{`${coin.endPrice} ${coin.quoteSymbol}`}</dd>
                  </div>
                  <div>
                    <dt>Fee</dt>
                    <dd>{`${bpsToPercent(coin.openingFeeBps)} to ${bpsToPercent(coin.endingFeeBps)}`}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>Sale path</dt>
                <dd>
                  {coin && rail === "escrow"
                    ? `PAR escrow. ${draft.sale === "auction" ? "Auction" : "Fixed price"} at ${draft.titlePrice.trim() || "unset"} ${symbol || "tokens"}. Opens ${draft.saleDays} ${waitUnit} after graduation.`
                    : coin
                      ? `Tensor. Opens ${draft.saleDays} days after graduation. Listed from the PAR sale page. Paid in ${symbol}.`
                      : `Fixed price or a bid, paid in ${symbol || "the token you read"}. You set how long before the sale opens.`}
                </dd>
              </div>
            </dl>
            <p className="note">
              {coin
                ? `The trading price is what buyers pay for ${coin.symbol}. The redemption rule is the other panel. One does not set the other.`
                : "This panel is the payment token. The redemption rule is the other panel."}
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
              : withCoin
                ? "Sale path: Tensor. These words say the title is listed through Tensor's marketplace program, because Tensor is selected on Claim."
                : "Sale path: chosen on the sale page. A fixed price or a bid, paid in the token you named. You set how long before the sale opens."}
          </p>
          <p className="note">
            Both NFTs carry the picture, the token address, the sale page, and a link named full sheet. That link opens this sheet on Arweave. The sheet names the token and links to the sale page, where the title can be bought or bid on.
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
            curveLines={sizeLine}
            preparedKeys={preparedKeys}
            coin={coin}
            pay={pay}
            onCreated={clearRwaDraft}
          />
        </div>
      ) : null}

      {tried && problem ? <p className="error">{problem}</p> : null}

      <div className="asset-nav">
        <button type="button" disabled={index <= 0} onClick={() => go(steps[index - 1])}>
          Back
        </button>
        {index < steps.length - 1 ? (
          <button type="button" className="solid" onClick={forward}>
            Next
          </button>
        ) : null}
      </div>
    </div>
  );
}
