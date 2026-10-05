"use client";

import { deriveDbcPoolAddress, DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { PoolBoard } from "@/components/PoolBoard";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useCluster } from "@/lib/cluster";
import { DEFAULT_FEE_DECAY_SECONDS, DEFAULT_MIGRATION_FEE_BPS, FEE_DECAY_CHOICES, HIDDEN_POOLS, MIGRATION_FEE_CHOICES, feeDecayLabel, migrationFeeLabel, quoteLabel, quoteMintAddress, type ClusterName, type QuoteKind } from "@/lib/constants";
import {
  BILLION_SUPPLY,
  CLIMB_PRESETS,
  SHARE_PERCENT_HIGH,
  SHARE_PERCENT_LOW,
  SHARE_PRESETS,
  SOL_CLIMB_PRESETS,
  SOL_THIN_RAISE,
  THIN_RAISE,
  describeLaunch,
  buildLaunchConfig,
  checkClimbCustom,
  checkParPrices,
  type QuoteExtra,
  parForLockedRaise,
  poolForMigratingShare,
  priceField,
  shareMarkFor,
  type LaunchChoice,
  type RaiseChoice,
} from "@/lib/launch";
import { bpsToPercent, formatDollars, formatLamports, plainDecimal } from "@/lib/format";
import { shrinkImage } from "@/lib/image";
import { signedPictureHeaders } from "@/lib/picture";
import { readCurveShape } from "@/lib/curve";
import { metadataUriForChain } from "@/lib/metadata";
import { DAMM_BADGE_FORM, DBC_BADGE_DOCS, METEORA_DISCORD, type QuoteCheck } from "@/lib/quote-gate";
import {
  assertCurveFee,
  creatorSharePercent,
  DEFAULT_PLATFORM_SETTINGS,
  METEORA_TRADING_FEE_PERCENT,
  parseFeePercent,
  type PlatformSettings,
} from "@/lib/platform";
import { prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";
import {
  DAY_SECONDS,
  NO_RESERVE,
  RESERVE_PERCENTS,
  reserveFromWhen,
  reserveProblem,
  tokensForPercent,
  type CreatorReserve,
  type ReserveWhen,
} from "@/lib/vesting";

type Remembered = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  preset: string;
  cluster: ClusterName;
};

type PoolDraft = {
  baseMint: Keypair;
  config: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  tokenBadge?: PublicKey;
};

type PendingCreate = {
  prepared?: PreparedTransaction;
  configPrepared?: PreparedTransaction;
  poolDraft?: PoolDraft;
  fingerprint: string;
  lines: string[];
  poolAddress: string;
  name: string;
  symbol: string;
  mint: string;
  preset: string;
};

type PaidTemplate = {
  fingerprint: string;
  config: PublicKey;
  baseMint: Keypair;
};

const STORAGE_KEY = "par.listings.v1";

function readRemembered(): Remembered[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as Remembered[];
    if (!Array.isArray(parsed)) return [];
    const kept = parsed.filter((item) => item?.pool && !HIDDEN_POOLS.has(item.pool));
    if (kept.length !== parsed.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    return kept;
  } catch {
    return [];
  }
}

function remember(listing: Remembered) {
  const next = [listing, ...readRemembered().filter((item) => item.pool !== listing.pool)].slice(0, 24);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function symbolFromName(name: string): string {
  const compact = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.slice(0, 10) || "TOKEN";
}

function percentField(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return String(rounded);
}

function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

function solDollarHint(text: string, usdPerSol: number): string {
  const amount = Number(text);
  if (!(usdPerSol > 0) || !(amount > 0)) return "";
  return `${plainDecimal(amount, 9)} SOL is about ${formatDollars(amount * usdPerSol)} per token at ${formatDollars(usdPerSol)} per SOL.`;
}

async function waitForAccount(connection: Connection, key: PublicKey) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await connection.getAccountInfo(key, "confirmed");
    if (info) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("The template transaction confirmed, but the account is not visible yet.");
}

export function Desk() {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const [preset, setPreset] = useState<"starter" | "solid" | "deep" | "thin" | "fixed" | "custom">("starter");
  const [onPar, setOnPar] = useState(true);
  const [supplyText, setSupplyText] = useState(String(BILLION_SUPPLY));
  const [openText, setOpenText] = useState("0.00001");
  const [endText, setEndText] = useState("0.00002");
  const [parText, setParText] = useState("1");
  const [poolText, setPoolText] = useState("1.20");
  const [migrateText, setMigrateText] = useState("");
  const [sharePercentText, setSharePercentText] = useState("");
  const [shareTokenText, setShareTokenText] = useState("");
  const [shareError, setShareError] = useState("");
  const shareDriver = useRef<"prices" | "percent" | "tokens">("prices");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [symbolEdited, setSymbolEdited] = useState(false);
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [curveFee, setCurveFee] = useState("25");
  const [curveFeeEdited, setCurveFeeEdited] = useState(false);
  const [feeDecaySeconds, setFeeDecaySeconds] = useState(DEFAULT_FEE_DECAY_SECONDS);
  const [feeFlat, setFeeFlat] = useState(false);
  const [endFee, setEndFee] = useState("1");
  const [straightFall, setStraightFall] = useState(false);
  const [dynamicFee, setDynamicFee] = useState(false);
  const [compoundOn, setCompoundOn] = useState(false);
  const [compoundFee, setCompoundFee] = useState("0.25");
  const [compoundShare, setCompoundShare] = useState("100");
  const [shelfShare, setShelfShare] = useState(45);
  const [migrationFeeBps, setMigrationFeeBps] = useState(DEFAULT_MIGRATION_FEE_BPS);
  const [reservePercent, setReservePercent] = useState<0 | 5 | 10 | 20 | "custom">(0);
  const [reserveWhen, setReserveWhen] = useState<ReserveWhen | "custom">("open");
  const [reserveTokenText, setReserveTokenText] = useState("");
  const [reserveWaitText, setReserveWaitText] = useState("10");
  const [reserveReleaseText, setReserveReleaseText] = useState("10");
  const [reserveClaimsText, setReserveClaimsText] = useState("2");
  const [quoteKind, setQuoteKind] = useState<QuoteKind>("usdc");
  const [quoteMintText, setQuoteMintText] = useState("");
  const [quoteCheck, setQuoteCheck] = useState<QuoteCheck | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [solUsd, setSolUsd] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [paid, setPaid] = useState<PaidTemplate | null>(null);
  const [platform, setPlatform] = useState<PlatformSettings>(DEFAULT_PLATFORM_SETTINGS);

  const quoteExtra = useMemo((): QuoteExtra | undefined => {
    if (quoteKind !== "other" || !quoteCheck?.ok) return undefined;
    return { decimals: quoteCheck.decimals, unit: quoteCheck.symbol || "quote" };
  }, [quoteKind, quoteCheck]);
  const quoteMintKey =
    quoteKind === "other"
      ? quoteCheck?.ok
        ? new PublicKey(quoteCheck.mint)
        : null
      : quoteMintAddress(cluster, quoteKind);
  const tokenBadge = quoteKind === "other" && quoteCheck?.badge ? new PublicKey(quoteCheck.badge) : undefined;
  const unit = quoteExtra?.unit ?? quoteLabel(quoteKind);
  const raise: RaiseChoice =
    quoteKind === "sol"
      ? preset === "solid"
        ? 25
        : preset === "deep"
          ? 50
          : preset === "thin"
            ? SOL_THIN_RAISE
            : 10
      : preset === "solid"
        ? 25_000
        : preset === "deep"
          ? 50_000
          : preset === "thin"
            ? THIN_RAISE
            : 10_000;
  const presetLock = onPar && preset !== "custom" && preset !== "fixed";
  const reserveSupply = preset === "custom" && /^\d+$/.test(supplyText) ? Number(supplyText) : BILLION_SUPPLY;
  const reserve = useMemo((): CreatorReserve => {
    if (reservePercent === 0) return NO_RESERVE;
    const tokens =
      reservePercent === "custom"
        ? /^\d+$/.test(reserveTokenText)
          ? Number(reserveTokenText)
          : Number.NaN
        : tokensForPercent(reserveSupply, reservePercent);
    if (reserveWhen !== "custom") return reserveFromWhen(tokens, reserveWhen);
    const wait = /^\d+$/.test(reserveWaitText) ? Number(reserveWaitText) : Number.NaN;
    const release = /^\d+$/.test(reserveReleaseText) ? Number(reserveReleaseText) : Number.NaN;
    const claims = /^\d+$/.test(reserveClaimsText) ? Number(reserveClaimsText) : Number.NaN;
    return {
      tokens,
      cliffSeconds: Number.isFinite(wait) ? wait * DAY_SECONDS : -1,
      releaseSeconds: Number.isFinite(release) ? release * DAY_SECONDS : -1,
      periods: claims,
    };
  }, [reservePercent, reserveTokenText, reserveWhen, reserveWaitText, reserveReleaseText, reserveClaimsText, reserveSupply]);
  const reserveError = reserveProblem(reserve, reserveSupply);
  const curveReserve = reserveError ? NO_RESERVE : reserve;
  const lockedPrices = useMemo(
    () => (presetLock ? parForLockedRaise(raise, shelfShare, quoteKind, quoteExtra, curveReserve) : null),
    [presetLock, raise, shelfShare, quoteKind, quoteExtra, curveReserve],
  );
  const shownPar = lockedPrices ? plainDecimal(lockedPrices.par, 18) : parText;
  const shownPool = lockedPrices ? plainDecimal(lockedPrices.pool, 18) : poolText;
  const migratePercent = onPar ? undefined : shareMarkFor(migrateText).percent;
  const choice: LaunchChoice = useMemo(() => {
    const share = migratePercent ? { migratePercent } : {};
    if (preset === "fixed") return { kind: "fixed" };
    if (preset === "custom") {
      if (onPar) {
        return { kind: "custom-par", supply: Number(supplyText), parPrice: Number(parText), poolPrice: Number(poolText), ...share };
      }
      return { kind: "custom", supply: Number(supplyText), openPrice: Number(openText), endPrice: Number(endText), ...share };
    }
    if (onPar) return { kind: "par", raise, parPrice: Number(shownPar), poolPrice: Number(shownPool), ...share };
    return { kind: "climb", raise };
  }, [preset, onPar, raise, supplyText, openText, endText, parText, poolText, shownPar, shownPool, migratePercent]);
  const openingBps = platform.openingFeeBps;
  let feeProblem = "";
  let parsedFeeBps = 0;
  try {
    parsedFeeBps = parseFeePercent(curveFee);
    assertCurveFee(parsedFeeBps);
  } catch (cause) {
    feeProblem = cause instanceof Error ? cause.message : "That trading fee is not allowed.";
  }
  const openingFeeForShape = feeProblem ? openingBps : parsedFeeBps;
  let endingProblem = "";
  let endingParsed = openingFeeForShape;
  if (!feeFlat) {
    try {
      endingParsed = parseFeePercent(endFee);
      if (endingParsed > openingFeeForShape) endingProblem = "The ending fee has to be at or under the opening fee.";
    } catch (cause) {
      endingProblem = cause instanceof Error ? cause.message : "That ending fee is not allowed.";
    }
  }
  const endingForCurve = feeFlat || endingProblem ? openingFeeForShape : endingParsed;
  const shapeRead = readCurveShape({
    straightFall,
    dynamicFee,
    compoundOn,
    poolFeePercent: compoundFee,
    compoundPercent: compoundShare,
  });
  const curveShapeValue = shapeRead.shape;
  const compoundProblem = shapeRead.error;
  const customMarks = useMemo(() => {
    const ending = endingForCurve;
    const feePercent = platform.platformFeePercent ?? 20;
    if (preset === "custom" && !onPar) {
      return checkClimbCustom(supplyText, openText, endText, migrateText, openingFeeForShape, ending, feePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, quoteExtra, curveShapeValue);
    }
    if (onPar && preset !== "fixed") {
      return checkParPrices(
        shownPar,
        shownPool,
        preset === "custom" ? supplyText : null,
        preset === "custom" ? null : raise,
        onPar ? "" : migrateText,
        openingFeeForShape,
        ending,
        feePercent,
        feeDecaySeconds,
        migrationFeeBps,
        quoteKind,
        curveReserve,
        quoteExtra,
        curveShapeValue,
      );
    }
    return null;
  }, [preset, onPar, supplyText, openText, endText, shownPar, shownPool, migrateText, raise, openingFeeForShape, endingForCurve, platform.platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, quoteExtra, curveShapeValue]);
  const picture = useMemo(() => {
    const built =
      customMarks?.picture ??
      describeLaunch(
        choice,
        openingFeeForShape,
        endingForCurve,
        platform.platformFeePercent ?? 20,
        feeDecaySeconds,
        migrationFeeBps,
        quoteKind,
        curveReserve,
        quoteExtra,
        curveShapeValue,
      );
    if (quoteKind === "other" && !quoteCheck?.ok) {
      return { ...built, ok: false, error: quoteCheck?.message || "Check the quote mint before review." };
    }
    if (!reserveError) return built;
    return { ...built, ok: false, creator: "", error: reserveError };
  }, [customMarks, choice, openingFeeForShape, endingForCurve, platform.platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, reserveError, quoteExtra, quoteCheck, curveShapeValue]);
  const formFingerprint = JSON.stringify({
    cluster,
    quoteKind,
    quoteMint: quoteCheck?.mint ?? "",
    quoteBadge: quoteCheck?.badge ?? "",
    preset,
    onPar,
    raise,
    supplyText,
    openText,
    endText,
    parText: shownPar,
    poolText: shownPool,
    migrateText,
    curveFeeBps: parsedFeeBps,
    endingFeeBps: endingForCurve,
    feeFlat,
    straightFall,
    dynamicFee,
    compoundOn,
    compoundFee,
    compoundShare,
    migrationFeeBps,
    platformFeePercent: platform.platformFeePercent ?? 20,
    feeDecaySeconds,
    reserve,
  });
  const shownSymbol = symbolEdited ? symbol : symbolFromName(name);

  useEffect(() => {
    if (!curveFeeEdited) setCurveFee(String(openingBps / 100));
  }, [openingBps, curveFeeEdited]);

  useEffect(() => {
    if (!onPar || preset === "fixed" || !picture.ok || !picture.fair || picture.migratedTokens <= 0) return;
    if (shareDriver.current === "percent") {
      setShareTokenText(String(picture.migratedTokens));
      return;
    }
    if (shareDriver.current === "tokens") {
      setSharePercentText(percentField(picture.migratedPercent));
      return;
    }
    setSharePercentText(percentField(picture.migratedPercent));
    setShareTokenText(String(picture.migratedTokens));
    setShareError("");
  }, [onPar, preset, picture.ok, picture.fair, picture.migratedPercent, picture.migratedTokens]);

  function applySharePercent(percent: number, from: "percent" | "tokens" | "prices") {
    if (onPar && preset !== "custom" && preset !== "fixed") {
      if (percent < SHARE_PERCENT_LOW || percent > SHARE_PERCENT_HIGH) {
        setShareError(
          `The shelf locks from ${SHARE_PERCENT_LOW}% to ${SHARE_PERCENT_HIGH}% of the supply. ${SHARE_PERCENT_LOW}% is the low end, with the pool almost double par. ${SHARE_PERCENT_HIGH}% is the high end, just above the 10% shelf.`,
        );
        return;
      }
      setShareError("");
      shareDriver.current = from;
      setShelfShare(percent);
      return;
    }
    const par = Number(parText);
    if (!(par > 0)) return;
    if (percent < SHARE_PERCENT_LOW || percent > SHARE_PERCENT_HIGH) {
      setShareError(
        `The shelf locks from ${SHARE_PERCENT_LOW}% to ${SHARE_PERCENT_HIGH}% of the supply. ${SHARE_PERCENT_LOW}% is the low end, with the pool almost double par. ${SHARE_PERCENT_HIGH}% is the high end, just above the 10% shelf.`,
      );
      return;
    }
    const pool = poolForMigratingShare(par, percent);
    if (!pool) {
      setShareError("That share does not fit the shelf.");
      return;
    }
    setShareError("");
    shareDriver.current = from;
    setPoolText(priceField(pool));
  }

  useEffect(() => {
    if (!onPar || preset === "custom" || preset === "fixed") return;
    const fitted = parForLockedRaise(raise, shelfShare, quoteKind, quoteExtra, curveReserve);
    if (!fitted) return;
    setParText(plainDecimal(fitted.par, 18));
    setPoolText(plainDecimal(fitted.pool, 18));
  }, [onPar, preset, raise, shelfShare, quoteKind, quoteExtra, curveReserve]);

  useEffect(() => {
    let cancelled = false;
    async function loadPlatform() {
      const response = await fetch("/api/platform");
      if (!response.ok || cancelled) return;
      setPlatform((await response.json()) as PlatformSettings);
    }
    void loadPlatform().catch(() => undefined);
    function onFocus() {
      void loadPlatform().catch(() => undefined);
    }
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSolPrice() {
      const response = await fetch("/api/sol-price");
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { usd?: number };
      if (typeof body.usd === "number" && body.usd > 0 && !cancelled) setSolUsd(body.usd);
    }
    void loadSolPrice().catch(() => undefined);
    const timer = setInterval(() => void loadSolPrice().catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function uploadTokenImage(file: File) {
    setError("");
    setBusy(true);
    try {
      const jpeg = await shrinkImage(file);
      if (!publicKey || !signMessage) throw new Error("Connect a wallet to save the picture.");
      const response = await fetch("/api/image", {
        method: "POST",
        headers: await signedPictureHeaders(jpeg, publicKey.toBase58(), signMessage),
        body: jpeg,
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error || "Could not upload that image.");
      setImage(body.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload that image.");
    } finally {
      setBusy(false);
    }
  }

  async function finish(next: PendingCreate): Promise<"created" | "paused"> {
    if (!publicKey || !signTransaction) throw new Error("This wallet cannot sign transactions.");
    const sentTemplate = Boolean(next.configPrepared);
    let templateSaved = false;
    try {
      if (next.configPrepared && next.poolDraft) {
        await sendPrepared(connection, next.configPrepared, signTransaction);
        setPaid({
          fingerprint: next.fingerprint,
          config: next.poolDraft.config,
          baseMint: next.poolDraft.baseMint,
        });
        templateSaved = true;
        setMessage("Template confirmed. Building the tokenâ€¦");
        await waitForAccount(connection, next.poolDraft.config);
      }
      let prepared = next.prepared;
      if (!prepared) {
        const draft = next.poolDraft;
        if (!draft) throw new Error("The pool transaction was not built.");
        const client = DynamicBondingCurveClient.create(connection, "confirmed");
        let transaction = null;
        let lastError: unknown;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            transaction = await client.creator.createPool({
              baseMint: draft.baseMint.publicKey,
              config: draft.config,
              name: draft.name,
              symbol: draft.symbol,
              uri: draft.uri,
              payer: publicKey,
              poolCreator: publicKey,
              tokenBadge: draft.tokenBadge,
            });
            break;
          } catch (cause) {
            lastError = cause;
            const text = cause instanceof Error ? cause.message : "";
            if (!/config not found/i.test(text)) throw cause;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (!transaction) {
          throw lastError instanceof Error ? lastError : new Error("The new template was not visible yet.");
        }
        prepared = await prepareTransaction(connection, publicKey, transaction, [draft.baseMint]);
      }
      if (cluster === "mainnet-beta" && sentTemplate) {
        setPending({
          ...next,
          prepared,
          configPrepared: undefined,
          poolDraft: undefined,
          lines: [
            ...next.lines.filter(
              (line) =>
                !line.startsWith("Action:") &&
                !line.startsWith("Template network fee") &&
                !line.startsWith("Network fee") &&
                !line.startsWith("This opening percent"),
            ),
            "Action: createPool",
            "The template is already on chain. This signature creates the token.",
            `Network fee: ${formatLamports(prepared.feeLamports)}`,
            "Quote token spent: 0",
          ],
        });
        setMessage("Template confirmed. Review the token signature.");
        return "paused";
      }
      const signature = await sendPrepared(connection, prepared, signTransaction);
      setPaid(null);
      remember({
        pool: next.poolAddress,
        name: next.name,
        symbol: next.symbol,
        mint: next.mint,
        preset: next.preset,
        cluster,
      });
      void fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool: next.poolAddress, cluster }),
      }).catch(() => undefined);
      setMessage(`Pool created. Signature ${signature}`);
      setName("");
      setSymbol("");
      setSymbolEdited(false);
      setImage("");
      setDescription("");
      return "created";
    } catch (cause) {
      if (!templateSaved && paid?.fingerprint !== next.fingerprint) throw cause;
      const text = cause instanceof Error ? cause.message : "The token was not created.";
      throw new Error(
        `${text} Press Review create again. The template is already on chain, so that rent is not charged again.`,
      );
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!picture.ok || !quoteMintKey) {
      setError(picture.error || quoteCheck?.message || "That curve is not valid.");
      return;
    }
    const quoteMint = quoteMintKey;
    if (!publicKey || !signTransaction) {
      setError("Connect a wallet to sign createPool.");
      return;
    }
    let curveFeeBps = 0;
    try {
      curveFeeBps = parseFeePercent(curveFee);
      assertCurveFee(curveFeeBps);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That curve fee is not allowed.");
      return;
    }
    const endingFeeBps = endingForCurve;
    const trimmedName = name.trim();
    const trimmedSymbol = shownSymbol.trim();
    const trimmedImage = image.trim();
    const trimmedDescription = description.trim();
    if (trimmedName.length < 1 || trimmedName.length > 32) {
      setError("Name must be 1 to 32 characters.");
      return;
    }
    if (trimmedSymbol.length < 1 || trimmedSymbol.length > 10) {
      setError("Symbol must be 1 to 10 characters.");
      return;
    }
    if (trimmedImage && !/^https:\/\/\S+$/.test(trimmedImage)) {
      setError("Image must be an https link.");
      return;
    }
    let trimmedUri = "";
    try {
      trimmedUri = metadataUriForChain(window.location.origin, {
        name: trimmedName,
        symbol: trimmedSymbol,
        image: trimmedImage,
        description: trimmedDescription,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Metadata link is too long.");
      return;
    }

    const platformFeePercent = platform.platformFeePercent ?? 20;
    const creatorPercent = creatorSharePercent(platformFeePercent);
    const fingerprint = formFingerprint;
    const reuse = paid && paid.fingerprint === fingerprint ? paid : null;
    setBusy(true);
    try {
      const baseMint = reuse?.baseMint ?? Keypair.generate();
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      let configPrepared: PreparedTransaction | undefined;
      let configKey: PublicKey;
      if (reuse) {
        configKey = reuse.config;
      } else {
        const freshConfig = Keypair.generate();
        const configTransaction = await client.partner.createConfig({
          ...buildLaunchConfig(choice, curveFeeBps, endingFeeBps, platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, reserve, quoteExtra, curveShapeValue),
          config: freshConfig.publicKey,
          feeClaimer: new PublicKey(PLATFORM_FEE_CLAIMER),
          leftoverReceiver: new PublicKey(PLATFORM_FEE_CLAIMER),
          payer: publicKey,
          quoteMint,
          tokenBadge,
        });
        configPrepared = await prepareTransaction(connection, publicKey, configTransaction, [freshConfig]);
        configKey = freshConfig.publicKey;
      }
      const prepared = reuse
        ? await prepareTransaction(
            connection,
            publicKey,
            await client.creator.createPool({
              baseMint: baseMint.publicKey,
              config: configKey,
              name: trimmedName,
              symbol: trimmedSymbol,
              uri: trimmedUri,
              payer: publicKey,
              poolCreator: publicKey,
              tokenBadge,
            }),
            [baseMint],
          )
        : undefined;
      const poolAddress = deriveDbcPoolAddress(
        quoteMint,
        baseMint.publicKey,
        configKey,
      ).toBase58();
      const feeLine =
        curveFeeBps === endingFeeBps
          ? `Curve fee: ${bpsToPercent(curveFeeBps)} on every trade until migration.`
          : `Curve fee: starts at ${bpsToPercent(curveFeeBps)} and falls ${straightFall ? "in a straight line" : "on a curve"} to ${bpsToPercent(endingFeeBps)} over ${feeDecayLabel(feeDecaySeconds)}.`;
      const next: PendingCreate = {
        prepared,
        configPrepared,
        fingerprint,
        poolDraft: prepared
          ? undefined
          : {
              baseMint,
              config: configKey,
              name: trimmedName,
              symbol: trimmedSymbol,
              uri: trimmedUri,
              tokenBadge,
            },
        poolAddress,
        name: trimmedName,
        symbol: trimmedSymbol,
        mint: baseMint.publicKey.toBase58(),
        preset,
        lines: [
          reuse
            ? "Action: createPool. The template for these numbers is already on chain."
            : configPrepared
              ? "Action: createConfig, then createPool. The wallet opens twice."
              : "Action: createPool",
          `Network: ${cluster}`,
          `Name: ${trimmedName}`,
          `Symbol: ${trimmedSymbol}`,
          `Image: ${trimmedImage || "none"}`,
          `Metadata: ${trimmedUri}`,
          `Config: ${configKey.toBase58()}`,
          `Base mint: ${baseMint.publicKey.toBase58()}`,
          `Pool: ${poolAddress}`,
          `Quote mint: ${unit} (${quoteMint.toBase58()})`,
          ...(tokenBadge ? [`DBC token badge: ${tokenBadge.toBase58()}`] : []),
          ...(quoteKind === "sol" && solUsd > 0
            ? [`Live SOL price: ${formatDollars(solUsd)} per SOL. The prices below are SOL per token. A price of 0.0002 is a fraction of one SOL.`]
            : []),
          `Supply: ${grouped(picture.supply)}`,
          picture.creator || "Creator supply: none. The creator does not get a reserved bag of tokens.",
          ...(picture.fair
            ? [
                `Par: ${picture.parPrice} per token (${picture.parMarketCap} if the whole supply were priced there).`,
                picture.saleAtPar,
                picture.walk,
                `Pool price: ${picture.poolPrice} per token (${picture.poolMarketCap}). Buys to get there: ${picture.raise}.`,
                picture.locked,
                ...(picture.migrationWarning ? [picture.migrationWarning] : []),
                picture.dust,
              ]
            : [
                `Opens at ${picture.parPrice} (${picture.parMarketCap} market cap).`,
                `The price climbs to ${picture.poolPrice} (${picture.poolMarketCap} market cap) after ${picture.raise} of buys.`,
                picture.locked,
                ...(picture.migrationWarning ? [picture.migrationWarning] : []),
              ]),
          `A ${quoteKind === "sol" ? "0.1 SOL" : quoteKind === "other" ? `10 ${unit}` : "$10"} buy is ${picture.tenDollarShare}. ${picture.keeper}`,
          feeLine,
          `Of that trading fee: Meteora ${METEORA_TRADING_FEE_PERCENT}%, platform ${platformFeePercent}%, token creator ${creatorPercent}%. The creator cannot change this split.`,
          `Pool creation fee: 0 ${unit}`,
          `${unit} spent: 0`,
          `The locked tokens and the locked ${unit} stay in the pool. They are not paid out.`,
          dynamicFee ? "A volatility fee can add on top of the curve fee when the price moves fast. The total still stops at 99%." : "The curve fee is the base fee only.",
          curveShapeValue.compound
            ? `After the lock, the pool fee is ${bpsToPercent(curveShapeValue.compound.poolFeeBps)}. ${bpsToPercent(curveShapeValue.compound.compoundingBps)} of that fee is put back into the pool. The liquidity stays locked.`
            : `After migration the pool charges ${migrationFeeLabel(migrationFeeBps)} on every swap. Of that fee: Meteora ${METEORA_TRADING_FEE_PERCENT}%, platform ${platformFeePercent}%, token creator ${creatorPercent}%. Those fee shares wait until they are claimed. The claim buttons on this site withdraw the curve fee from before migration.`,
          prepared
            ? `Network fee: ${formatLamports((configPrepared?.feeLamports ?? 0) + prepared.feeLamports)}`
            : `Template network fee: ${formatLamports(configPrepared?.feeLamports ?? 0)}. The second signature pays the mint and pool rent, about 0.021 SOL, and the wallet shows that exact amount.`,
          configPrepared
            ? "Meteora writes the supply, prices, and fee into a template account and does not let that account be edited, so this create pays about 0.005984 SOL rent for a new one. The platform fee claimer stays the platform wallet."
            : "Rent for the new mint, metadata, pool, and token vaults is charged in SOL on top of that network fee.",
        ],
      };
      setPending(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the pool.");
    } finally {
      setBusy(false);
    }
  }

  const writtenStart = feeProblem ? null : parsedFeeBps;
  const writtenEnd = writtenStart === null || endingProblem ? null : endingForCurve;
  const fallWords = straightFall ? "in a straight line" : "on a curve";
  const feeStory =
    writtenStart === null || writtenEnd === null
      ? endingProblem || "Fix the trading fee. It has to be from 0.25% to 99%."
      : feeFlat
        ? `Every trade until migration pays ${bpsToPercent(writtenStart)}.`
        : writtenStart === writtenEnd
          ? `The fee stays at ${bpsToPercent(writtenStart)} for the whole curve.`
          : `The fee starts at ${bpsToPercent(writtenStart)} and falls ${fallWords} to ${bpsToPercent(writtenEnd)} over ${feeDecayLabel(feeDecaySeconds)}.`;
  return (
    <div className="desk">
      <section className="lede">
        <p className="eyebrow">Meteora bonding curve</p>
        <h1>PAR</h1>
        <p className="tagline">Buyers come in at one price.</p>
        <details className="specs">
          <summary>PAR and the curve fee</summary>
          <div className="specs-body">
            <h2>PAR</h2>
            <p>
              PAR is the price. You set one price. Most of the tokens buyers receive stay within 10% of it, so a
              buyer now and a buyer later pay nearly the same price. That part of the sale is the shelf. It is a
              share of the tokens, and it lasts until those tokens are bought.
            </p>
            <p>
              After the shelf is bought, the last slice of the sale walks the price up to the pool price you set.
              Both prices are on the sheet before anyone buys.
            </p>
            <p>
              Leave PAR off and the price climbs from the first token to the last. Starter, Solid, Deep, and Thin
              then use the {unit} printed on the card.
            </p>
            <h2>Curve fee</h2>
            <p>
              The curve fee is what a trade pays while the coin is still for sale. It can fall, or it can stay flat.
            </p>
            <p>
              A falling fee starts at the percent you type and steps down to the ending fee you type. The fall can
              be curved or straight. You pick the clock: 1 hour, 6 hours, 12 hours, 24 hours, 48 hours, or 7 days.
              A buy at the open pays the opening fee. A buy after the clock pays the ending fee.
            </p>
            <p>A flat fee stays at the percent you type for the whole sale.</p>
            <h2>How they work together</h2>
            <p>
              The shelf ends when its tokens are bought. The curve fee ends when its clock runs out. Each one ends
              on its own.
            </p>
            <p>If buying is slow, the fee can already be at the ending fee while the price is still on the shelf.</p>
            <p>If the shelf sells out quickly, the price can already be walking up to the pool while the fee is still falling.</p>
            <h2>Graduation</h2>
            <p>
              Graduation is the lock. The sale is full. The {unit} raised and the tokens still left move into a
              Meteora DAMM v2 pool. That pool is locked, so the {unit} and those tokens cannot be withdrawn. Later
              buys can move the price up, and later sells can move it down.
            </p>
            <p>
              The curve fee stops at graduation, even if time is left on the clock. From then on, every trade pays
              the pool fee you pick below. The default is 0.25%. You can also put a share of that fee back into the pool. The liquidity stays locked either way.
            </p>
            <p>The prices and the fee are written into the template. They cannot be edited later.</p>
          </div>
        </details>
        <div className="asset-nav">
          <Link href="/pools" className="asset-link">
            Pools
          </Link>
          <Link href="/asset" className="asset-link">
            Real-world asset
          </Link>
        </div>
        <p>A plain PAR token is created on this page. A real-world asset is a separate page.</p>
        <p>PAR on keeps buyers near one price. PAR off lets the price rise the whole way. Both end at the same lock.</p>
        <p>
          The lock is graduation. When the curve is full, the {unit} raised on the sale and the tokens still left
          move into a Meteora DAMM v2 pool. That pool is locked. The {unit} and those tokens stay in it.
        </p>
        <div className="beats pair">
          <article>
            <strong>1. The climb, PAR on</strong>
            <span>
              You set one price. Most tokens buyers receive stay within 10% of it, so a buyer now and a buyer later pay nearly the same. The last slice rises to the pool price. Both prices are on the sheet before anyone buys.
            </span>
          </article>
          <article>
            <strong>2. The climb, PAR off</strong>
            <span>
              The price rises from the first token to the last. The opening price and the pool price are on the sheet, and that rise is the whole sale. Starter, Solid, Deep, and Thin put the {unit} printed on the card into that lock.
            </span>
          </article>
          <article>
            <strong>3. The lock</strong>
            <span>
              The lock is graduation. It happens when the curve is full, with PAR on and with PAR off. Meteora moves the {unit} raised on the sale and the tokens still left into a DAMM v2 pool. DAMM v2 is the Meteora pool this page uses. The pool is locked, so the {unit} and those tokens cannot be withdrawn. It opens at the pool price on the sheet.
            </span>
          </article>
          <article>
            <strong>4. After the lock</strong>
            <span>
              Trading continues from that pool price on the DAMM v2 pool. A buy can move it up. A sell can move it down. Buy and sell here, on Meteora, and on Jupiter, Axiom, and Photon. Those screens trade this DAMM v2 pool. The curve fee has stopped. Every trade pays the pool fee you set. The default is 0.25%.
            </span>
          </article>
        </div>
      </section>

      <form className="launch" onSubmit={onCreate}>
        <label>
          Token name
          <input
            value={name}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              if (!symbolEdited) setSymbol(symbolFromName(value));
            }}
            maxLength={32}
            placeholder="Name"
            required
          />
        </label>
        <label>
          Symbol
          <input
            value={shownSymbol}
            onChange={(event) => {
              setSymbolEdited(true);
              setSymbol(event.target.value.toUpperCase());
            }}
            maxLength={10}
            placeholder="SYMBOL"
            required
          />
        </label>
        <label>
          Image
          <input
            value={image}
            onChange={(event) => setImage(event.target.value)}
            placeholder="https:// or upload a file"
            inputMode="url"
          />
        </label>
        <label className="file">
          Upload image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadTokenImage(file);
            }}
          />
        </label>
        <label>
          Description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={80}
            placeholder="One line"
          />
        </label>
        {image.trim().startsWith("https://") ? (
          <img className="token-preview" src={image.trim()} alt="" />
        ) : null}
        <div className="choices" role="group" aria-label="Curve fee until migration">
          <button type="button" aria-pressed={!feeFlat} onClick={() => setFeeFlat(false)}>
            Fee falls
          </button>
          <button type="button" aria-pressed={feeFlat} onClick={() => setFeeFlat(true)}>
            Fee stays flat
          </button>
        </div>
        <label>
          {feeFlat ? "Fee until migration, percent" : "Trading fee at the open, percent"}
          <input
            className={feeProblem ? "bad" : undefined}
            aria-invalid={feeProblem ? true : undefined}
            value={curveFee}
            onChange={(event) => {
              setCurveFeeEdited(true);
              setCurveFee(event.target.value);
            }}
            inputMode="decimal"
          />
          {feeProblem ? <span className="field-error">{feeProblem}</span> : null}
        </label>
        <p className="note">
          {feeFlat
            ? "Flat means this percent is charged on every trade until migration. The clock does not apply."
            : "Falls means this percent is the opening fee. The ending fee and the clock below set where it lands."}{" "}
          {feeStory} Meteora writes it into the template and does not let it be edited later.
        </p>
        {feeFlat ? null : (
          <>
            <label>
              Ending fee, percent
              <input
                className={endingProblem ? "bad" : undefined}
                aria-invalid={endingProblem ? true : undefined}
                value={endFee}
                onChange={(event) => setEndFee(event.target.value)}
                inputMode="decimal"
              />
              {endingProblem ? <span className="field-error">{endingProblem}</span> : null}
            </label>
            <div className="choices" role="group" aria-label="How the fee falls">
              <button type="button" aria-pressed={!straightFall} onClick={() => setStraightFall(false)}>
                Curved fall
              </button>
              <button type="button" aria-pressed={straightFall} onClick={() => setStraightFall(true)}>
                Straight fall
              </button>
            </div>
            <p className="note">
              {straightFall
                ? "A straight fall drops by the same amount on each step of the clock."
                : "A curved fall drops faster at the start, then slows as it nears the ending fee."}
            </p>
            <div className="choices" role="group" aria-label="How long the opening fee falls">
              {FEE_DECAY_CHOICES.map((choice) => (
                <button
                  key={choice.seconds}
                  type="button"
                  aria-pressed={feeDecaySeconds === choice.seconds}
                  onClick={() => setFeeDecaySeconds(choice.seconds)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="note">
              This clock is {feeDecayLabel(feeDecaySeconds)}. It is the fall from the opening fee to the ending fee, and it is written into the template.
            </p>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={dynamicFee} onChange={(event) => setDynamicFee(event.target.checked)} />
          Add a volatility fee on the curve
        </label>
        <p className="note">
          The amount is the fee percent above. The volatility piece is at most one fifth of that percent while the price is moving, then it fades. A 25% fee can rise by up to 5 points. The two together still stop at 99%. There is no second box. It does not change how much quote locks. Of that fee: Meteora {METEORA_TRADING_FEE_PERCENT}%. PAR {platform.platformFeePercent}%. You {creatorSharePercent(platform.platformFeePercent)}%.
        </p>
        <label className="check">
          <input type="checkbox" checked={compoundOn} onChange={(event) => setCompoundOn(event.target.checked)} />
          Put pool fees back into the pool after the lock
        </label>
        {compoundOn ? (
          <>
            <label>
              Pool fee after the lock, percent
              <input
                className={compoundProblem ? "bad" : undefined}
                aria-invalid={compoundProblem ? true : undefined}
                value={compoundFee}
                onChange={(event) => setCompoundFee(event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              Share of that fee put back into the pool, percent
              <input value={compoundShare} onChange={(event) => setCompoundShare(event.target.value)} inputMode="decimal" />
            </label>
            {compoundProblem ? <span className="field-error">{compoundProblem}</span> : null}
            <p className="note">
              After the lock, trades pay this pool fee in the quote. The share you type is added back to the pool, so the pool gets deeper. The quote that locks on graduation does not change. The liquidity stays locked. At 100%, nothing from that pool fee is left to claim.
            </p>
          </>
        ) : (
          <>
            <p className="note">Pool fee after migration</p>
            <div className="choices" role="group" aria-label="Pool fee after migration">
              {MIGRATION_FEE_CHOICES.map((choice) => (
                <button
                  key={choice.bps}
                  type="button"
                  aria-pressed={migrationFeeBps === choice.bps}
                  onClick={() => setMigrationFeeBps(choice.bps)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="note">
              After the pool locks, every swap pays {migrationFeeLabel(migrationFeeBps)}. That choice is separate
              from the curve fee. The default is 0.25%. It is written into the template and cannot be edited later.
            </p>
          </>
        )}
        <dl className="fee-sheet">
          <div>
            <dt>Supply</dt>
            <dd>
              {picture.ok ? `${grouped(picture.supply)} tokens` : preset === "custom" || onPar ? "Fix the red fields." : picture.error}
            </dd>
          </div>
          {picture.fair ? (
            <>
              <div>
                <dt>Par</dt>
                <dd>
                  {picture.ok
                    ? `${picture.parPrice} per token. At that price the full supply is a ${picture.parMarketCap} market cap. Buyers do not buy the whole supply there.`
                    : "Set the fields."}
                </dd>
              </div>
              <div>
                <dt>The shelf</dt>
                <dd>{picture.ok ? picture.saleAtPar : "Set the fields."}</dd>
              </div>
              <div>
                <dt>The walk</dt>
                <dd>{picture.ok ? picture.walk : "Set the fields."}</dd>
              </div>
              <div>
                <dt>The pool</dt>
                <dd>
                  {picture.ok
                    ? `${picture.poolPrice} per token, a ${picture.poolMarketCap} market cap. ${picture.locked}`
                    : "Set the fields."}
                  {picture.ok && picture.migrationWarning ? <span className="field-error">{picture.migrationWarning}</span> : null}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>Opens</dt>
                <dd>{picture.ok ? `${picture.parPrice} per token, ${picture.parMarketCap} market cap` : "Set the fields."}</dd>
              </div>
              <div>
                <dt>Climbs to</dt>
                <dd>{picture.ok ? `${picture.poolPrice} per token, ${picture.poolMarketCap} market cap` : "Set the fields."}</dd>
              </div>
              <div>
                <dt>Locked pool</dt>
                <dd>
                  {picture.ok ? picture.locked : "Set the fields."}
                  {picture.ok && picture.migrationWarning ? <span className="field-error">{picture.migrationWarning}</span> : null}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Buys to finish</dt>
            <dd>
              {picture.ok
                ? `${picture.raise}. A $10 buy is ${picture.tenDollarShare}. ${picture.keeper}`
                : "Set the fields."}
            </dd>
          </div>
          {picture.fair ? (
            <div>
              <dt>Dust</dt>
              <dd>{picture.ok ? picture.dust : "Set the fields."}</dd>
            </div>
          ) : null}
          <div>
            <dt>Creator supply</dt>
            <dd>
              {reserveError
                ? reserveError
                : picture.ok
                  ? picture.creator || "None. The creator does not get a reserved bag of tokens."
                  : "Set the fields."}
            </dd>
          </div>
          <div>
            <dt>Trading fee</dt>
            <dd>
              {feeStory} That money is then split. It is separate from the platform percent below.
            </dd>
          </div>
          <div>
            <dt>Where the trading fee goes</dt>
            <dd>
              Meteora {METEORA_TRADING_FEE_PERCENT}%. PAR {platform.platformFeePercent}%. You{" "}
              {creatorSharePercent(platform.platformFeePercent)}%. You claim your share on the token page.
            </dd>
          </div>
          <div>
            <dt>You spend to create</dt>
            <dd>0 {unit}. The review shows the SOL network fee and rent before the wallet opens.</dd>
          </div>
          <div>
            <dt>After graduation</dt>
            <dd>
              {curveShapeValue.compound
                ? `Every swap pays ${bpsToPercent(curveShapeValue.compound.poolFeeBps)}. ${bpsToPercent(curveShapeValue.compound.compoundingBps)} of that fee is put back into the pool. The locked tokens and the locked ${unit} stay in the pool.`
                : `Every swap pays ${migrationFeeLabel(migrationFeeBps)}. Of that fee, Meteora keeps ${METEORA_TRADING_FEE_PERCENT}%, the platform keeps ${platform.platformFeePercent}%, and the token creator keeps ${creatorSharePercent(platform.platformFeePercent)}%. The locked tokens and the locked ${unit} stay in the pool. They are separate from this fee. The fee shares wait until they are claimed.`}{" "}
              Trading opens at the pool price. A later buy moves the price up, and a later sell moves it down. The claim buttons on this site withdraw the curve fee, from trades before migration. A token already created keeps the split written into it.
            </dd>
          </div>
        </dl>
        <p className="note">
          Symbol {shownSymbol || "none yet"}. Wallets read the name, symbol, and image from the metadata link stored
          on the mint.
        </p>
        <div className="choices" role="group" aria-label="Quote token">
          <button type="button" aria-pressed={quoteKind === "usdc"} onClick={() => setQuoteKind("usdc")}>
            USDC
          </button>
          <button type="button" aria-pressed={quoteKind === "sol"} onClick={() => setQuoteKind("sol")}>
            SOL
          </button>
          <button type="button" aria-pressed={quoteKind === "other"} onClick={() => setQuoteKind("other")}>
            Stock or other
          </button>
        </div>
        {quoteKind === "other" ? (
          <div>
            <label>
              Quote mint
              <input
                value={quoteMintText}
                onChange={(event) => {
                  setQuoteMintText(event.target.value);
                  setQuoteCheck(null);
                }}
                placeholder="Mint address of the stock or other quote"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              disabled={quoteBusy || !quoteMintText.trim()}
              onClick={() => {
                setQuoteBusy(true);
                setQuoteCheck(null);
                void fetch(`/api/quote?cluster=${cluster}&mint=${encodeURIComponent(quoteMintText.trim())}`)
                  .then(async (response) => {
                    const body = (await response.json()) as QuoteCheck;
                    setQuoteCheck(
                      body && typeof body.message === "string"
                        ? body
                        : {
                            ok: false,
                            mint: quoteMintText.trim(),
                            decimals: 0,
                            symbol: "",
                            badge: null,
                            path: "blocked",
                            message: "That mint could not be checked.",
                          },
                    );
                  })
                  .catch(() => {
                    setQuoteCheck({
                      ok: false,
                      mint: quoteMintText.trim(),
                      decimals: 0,
                      symbol: "",
                      badge: null,
                      path: "blocked",
                      message: "The network did not answer that mint. Try the check again.",
                    });
                  })
                  .finally(() => setQuoteBusy(false));
              }}
            >
              {quoteBusy ? "Checkingâ€¦" : "Check this mint"}
            </button>
            <p className={quoteCheck && !quoteCheck.ok ? "error" : "note"}>
              {quoteCheck?.message ||
                "A stock pair or an ICM pair means buyers pay with that token instead of USDC or SOL. A normal token works now. A Token-2022 stock works after Meteora has badged it. PAR cannot create the badge."}
            </p>
            <p className="note">
              Ask for a DBC quote badge in the{" "}
              <a href={METEORA_DISCORD} target="_blank" rel="noreferrer">
                Meteora Discord
              </a>
              . Send the mint and say you need a DBC token badge for a quote. The{" "}
              <a href={DAMM_BADGE_FORM} target="_blank" rel="noreferrer">
                DAMM and DLMM form
              </a>{" "}
              is a different badge and does not unlock this launch.{" "}
              <a href={DBC_BADGE_DOCS} target="_blank" rel="noreferrer">
                Meteora&apos;s quote badge page
              </a>{" "}
              is the rule.
            </p>
          </div>
        ) : null}
        <p className="note">
          {quoteKind === "sol"
            ? `Buyers pay SOL. 0.002 and 0.0002 are fractions of one SOL. ${solUsd > 0 ? `One SOL is about ${formatDollars(solUsd)} right now.` : "The dollar line uses the live SOL price."} ${cluster === "devnet" ? "Practice SOL is not worth that. The dollar line uses the real-network price." : ""} Thin test locks 1 SOL, which a practice wallet can fill from the faucet. On the real network, Meteora opens a SOL curve by itself at 10 SOL.`
            : quoteKind === "other"
              ? `Buyers pay ${unit}. The amounts on the cards are ${unit}, not dollars. On the real network, Meteora opens a badged stock quote by itself once the quote collected is worth at least $750.`
              : "Buyers pay USDC. Thin test locks $750. On the real network, that is the smallest USDC curve Meteora opens by itself. Practice USDC from Circle is about $20, so a $750 curve cannot be filled from that faucet."}
        </p>
        <div className="presets launch" role="group" aria-label="Launch">
          {(quoteKind === "sol" ? SOL_CLIMB_PRESETS : CLIMB_PRESETS).map((item) => (
            <button
              key={item.raise}
              type="button"
              className={preset === item.name.toLowerCase() ? "preset selected" : "preset"}
              aria-pressed={preset === item.name.toLowerCase()}
              onClick={() => setPreset(item.name.toLowerCase() as "starter" | "solid" | "deep")}
            >
              <span className="preset-kicker">{item.name}</span>
              <strong>
                {quoteKind === "sol"
                  ? `${grouped(item.raise)} SOL locked`
                  : quoteKind === "other"
                    ? `${grouped(item.raise)} ${unit} locked`
                    : `$${grouped(item.raise)} locked`}
              </strong>
              <span>
                {onPar
                  ? "PAR is on. One billion tokens. The prices below are the ones that lock this amount. The share buttons move the price. The lock stays."
                  : quoteKind === "other"
                    ? `One billion tokens. The price climbs from the open to the pool and locks about ${grouped(item.raise)} ${unit}.`
                    : item.detail}
              </span>
            </button>
          ))}
        </div>
        <div className="presets launch" role="group" aria-label="Par fixed, test, and custom">
          <button
            type="button"
            className={preset === "fixed" ? "preset selected" : "preset"}
            aria-pressed={preset === "fixed"}
            onClick={() => setPreset("fixed")}
          >
            <span className="preset-kicker">Par fixed</span>
            <strong>
              {quoteKind === "sol"
                ? "0.00005 SOL to 0.00006 SOL"
                : quoteKind === "other"
                  ? `0.00005 ${unit} to 0.00006 ${unit}`
                  : "$0.00005 to $0.00006"}
            </strong>
            <span>
              {quoteKind === "sol"
                ? "One billion tokens. About 467 million lock with about 27,995 SOL. That is not a small test."
                : quoteKind === "other"
                  ? `One billion tokens. About 467 million lock with about 28,000 ${unit}.`
                  : "One billion tokens. About 467 million lock with about $28,000."}
            </span>
          </button>
          <button
            type="button"
            className={preset === "thin" ? "preset selected" : "preset"}
            aria-pressed={preset === "thin"}
            onClick={() => setPreset("thin")}
          >
            <span className="preset-kicker">Thin test</span>
            <strong>
              {quoteKind === "sol"
                ? "1,000,000,000 tokens, 1 SOL locked"
                : quoteKind === "other"
                  ? `1,000,000,000 tokens, 750 ${unit} locked`
                  : "1,000,000,000 tokens, $750 locked"}
            </strong>
            <span>
              {onPar
                ? "PAR is on. The prices below are the ones that lock this amount. The share buttons move the price. The lock stays."
                : quoteKind === "sol"
                  ? "A 1 SOL curve. A practice wallet can fill it. On the real network this is under 10 SOL, so someone signs once to open the trading pool. Turn PAR on for the shelf."
                  : quoteKind === "other"
                    ? `A 750 ${unit} curve. On the real network, Meteora opens a badged stock quote by itself once that quote is worth at least $750. Turn PAR on for the shelf.`
                    : "A small $750 curve. That is the smallest size Meteora opens by itself on the real network. Turn PAR on for the shelf."}
            </span>
          </button>
          <button type="button" className={preset === "custom" ? "preset selected" : "preset"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>
            <span className="preset-kicker">Custom</span>
            <strong>Your supply and your prices</strong>
            <span>{onPar ? "PAR is on. Type the supply and the two prices. A rejected number turns red." : "PAR is off. The price climbs from your opening price to your graduation price."}</span>
          </button>
        </div>
        {preset === "fixed" ? (
          <p className="note">
            {quoteKind === "sol"
              ? "Par fixed is one billion tokens at 0.00005 SOL. About 467 million tokens migrate into the pool at 0.00006 SOL, with about 27,995 SOL. The fee above is still yours to choose."
              : quoteKind === "other"
                ? `Par fixed is one billion tokens at 0.00005 ${unit}. About 467 million tokens migrate into the pool at 0.00006 ${unit}. The fee above is still yours to choose.`
                : "Par fixed is one billion tokens at $0.00005. About 467 million tokens migrate into the pool at $0.00006. The fee above is still yours to choose."}
          </p>
        ) : (
          <label className="par-switch">
            <input type="checkbox" checked={onPar} onChange={(event) => setOnPar(event.target.checked)} />
            <span>
              <strong>Keep the opening on par</strong>
              <span>
                {onPar
                  ? `PAR is on. Most tokens sold to buyers stay within 10% of par. On Starter, Solid, Deep, and Thin, the amount on the card is what locks.`
                  : preset === "custom"
                    ? "PAR is off. The price climbs from your opening price to your graduation price. Turn this on to hold the opening near par."
                    : `PAR is off. The price climbs from the first token to the last, and the ${unit} on the selected card is what locks. Turn this on to hold the opening near par.`}
              </span>
            </span>
          </label>
        )}
        {preset === "custom" && !onPar && customMarks ? (
          <>
            <label>
              Supply
              <input
                className={customMarks.supply ? "bad" : undefined}
                aria-invalid={customMarks.supply ? true : undefined}
                value={supplyText}
                inputMode="numeric"
                onChange={(event) => setSupplyText(event.target.value.replace(/[^\d]/g, ""))}
              />
              {customMarks.supply ? <span className="field-error">{customMarks.supply}</span> : null}
            </label>
            <label>
              Opening price, {unit} per token
              <input
                className={customMarks.open ? "bad" : undefined}
                aria-invalid={customMarks.open ? true : undefined}
                value={openText}
                inputMode="decimal"
                onChange={(event) => setOpenText(event.target.value.replace(/[^\d.]/g, ""))}
              />
              {customMarks.open && customMarks.open !== customMarks.end ? (
                <span className="field-error">{customMarks.open}</span>
              ) : null}
              {quoteKind === "sol" && !customMarks.open ? <span className="note">{solDollarHint(openText, solUsd)}</span> : null}
            </label>
            <label>
              Graduation price, {unit} per token
              <input
                className={customMarks.end ? "bad" : undefined}
                aria-invalid={customMarks.end ? true : undefined}
                value={endText}
                inputMode="decimal"
                onChange={(event) => setEndText(event.target.value.replace(/[^\d.]/g, ""))}
              />
              {customMarks.end ? <span className="field-error">{customMarks.end}</span> : null}
              {quoteKind === "sol" && !customMarks.end ? <span className="note">{solDollarHint(endText, solUsd)}</span> : null}
            </label>
          </>
        ) : null}
        {onPar && preset !== "fixed" && customMarks ? (
          <>
            {preset === "custom" ? (
              <label>
                Supply
                <input
                  className={customMarks.supply ? "bad" : undefined}
                  aria-invalid={customMarks.supply ? true : undefined}
                  value={supplyText}
                  inputMode="numeric"
                  onChange={(event) => {
                    shareDriver.current = "prices";
                    setSupplyText(event.target.value.replace(/[^\d]/g, ""));
                  }}
                />
                {customMarks.supply ? <span className="field-error">{customMarks.supply}</span> : null}
              </label>
            ) : null}
            <label>
              Par, {unit} per token
              <input
                className={customMarks.par ? "bad" : undefined}
                aria-invalid={customMarks.par ? true : undefined}
                value={shownPar}
                inputMode="decimal"
                readOnly={preset !== "custom"}
                onChange={(event) => {
                  shareDriver.current = "prices";
                  setParText(event.target.value.replace(/[^\d.]/g, ""));
                }}
              />
              {customMarks.par && customMarks.par !== customMarks.pool ? (
                <span className="field-error">{customMarks.par}</span>
              ) : null}
              {preset !== "custom" ? (
                <span className="note">These prices keep the lock printed on the card. The share buttons move the price. The lock stays.</span>
              ) : null}
              {quoteKind === "sol" && !customMarks.par ? <span className="note">{solDollarHint(shownPar, solUsd)}</span> : null}
            </label>
            <label>
              Pool price, {unit} per token
              <input
                className={customMarks.pool ? "bad" : undefined}
                aria-invalid={customMarks.pool ? true : undefined}
                value={shownPool}
                inputMode="decimal"
                readOnly={preset !== "custom"}
                onChange={(event) => {
                  shareDriver.current = "prices";
                  setPoolText(event.target.value.replace(/[^\d.]/g, ""));
                }}
              />
              {customMarks.pool ? <span className="field-error">{customMarks.pool}</span> : null}
              {quoteKind === "sol" && !customMarks.pool ? <span className="note">{solDollarHint(shownPool, solUsd)}</span> : null}
            </label>
          </>
        ) : null}
        {onPar && preset !== "fixed" && customMarks ? (
          <>
            <label>
              Share that migrates, percent
              <input
                className={shareError ? "bad" : undefined}
                aria-invalid={shareError ? true : undefined}
                value={sharePercentText}
                inputMode="decimal"
                onChange={(event) => {
                  const cleaned = event.target.value.replace(/[^\d.]/g, "");
                  setSharePercentText(cleaned);
                  const percent = Number(cleaned);
                  if (!cleaned || !Number.isFinite(percent)) return;
                  applySharePercent(percent, "percent");
                }}
              />
              {shareError ? <span className="field-error">{shareError}</span> : null}
            </label>
            <div className="choices" role="group" aria-label="Share of the supply that migrates">
              {SHARE_PRESETS.map((percent) => (
                <button
                  key={percent}
                  type="button"
                  aria-pressed={picture.ok && Math.abs(picture.migratedPercent - percent) < 0.3}
                  onClick={() => {
                    shareDriver.current = "prices";
                    applySharePercent(percent, "prices");
                  }}
                >
                  {percent}%
                </button>
              ))}
            </div>
            <label>
              Tokens that migrate
              <input
                className={shareError ? "bad" : undefined}
                aria-invalid={shareError ? true : undefined}
                value={shareTokenText.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
                inputMode="numeric"
                onChange={(event) => {
                  const cleaned = event.target.value.replace(/[^\d]/g, "");
                  setShareTokenText(cleaned);
                  const tokens = Number(cleaned);
                  const supply = preset === "custom" && Number(supplyText) > 0 ? Number(supplyText) : BILLION_SUPPLY;
                  if (!cleaned || !tokens || !supply) return;
                  const percent = (tokens / supply) * 100;
                  setSharePercentText(percentField(percent));
                  applySharePercent(percent, "tokens");
                }}
              />
            </label>
            <span className="note">
              {preset !== "custom"
                ? "The share moves the price. The lock stays the amount printed on the card. 35% finishes at almost double par. 48% finishes just above the 10% shelf."
                : picture.ok
                  ? `These prices lock ${percentField(picture.migratedPercent)}% of the supply, ${grouped(picture.migratedTokens)} tokens, because the pool price is ${(Number(poolText) / Number(parText)).toLocaleString("en-US", { maximumFractionDigits: 2 })} times par. Type any whole percent from 35 to 48. The four buttons are shortcuts. 35% finishes at almost double par. 48% finishes just above the 10% shelf.`
                  : "Set par and the pool price. The share fills from those prices."}
            </span>
          </>
        ) : null}
        {preset === "custom" && !onPar && customMarks ? (
          <label>
            Share of the supply that migrates
            <input
              className={customMarks.share ? "bad" : undefined}
              aria-invalid={customMarks.share ? true : undefined}
              value={migrateText}
              inputMode="numeric"
              placeholder="from the prices"
              onChange={(event) => setMigrateText(event.target.value.replace(/[^\d]/g, ""))}
            />
            {customMarks.share ? <span className="field-error">{customMarks.share}</span> : null}
            <span className="note">
              {picture.ok && picture.migratedTokens > 0
                ? `These prices lock ${percentField(picture.migratedPercent)}% of the supply, ${grouped(picture.migratedTokens)} tokens. Leave this blank to keep that. Type a whole number from 1 to 49 to ask for a different share. Under 20% stays available and the page warns you. A pair the curve cannot draw turns red.`
                : "Leave this blank and the prices set the share. Type a whole number from 1 to 49 to lock that share. Under 20% stays available and the page warns you. A pair the curve cannot draw turns red."}
            </span>
          </label>
        ) : null}
        <p className="note">Creator supply</p>
        <div className="choices" role="group" aria-label="Creator supply">
          <button type="button" aria-pressed={reservePercent === 0} onClick={() => setReservePercent(0)}>
            None
          </button>
          {RESERVE_PERCENTS.map((percent) => (
            <button
              key={percent}
              type="button"
              aria-pressed={reservePercent === percent}
              onClick={() => setReservePercent(percent)}
            >
              {percent}%
            </button>
          ))}
          <button type="button" aria-pressed={reservePercent === "custom"} onClick={() => setReservePercent("custom")}>
            Custom
          </button>
        </div>
        {reservePercent === 0 ? (
          <p className="note">
            None means the creator does not get a reserved bag of tokens. Buyers and the pool use the supply.
          </p>
        ) : (
          <>
            <p className="note">
              You can release this supply in one claim, or split it across several claims. You also set the span between claims.
            </p>
            <p className="note">
              A single claim releases the bag at one time. The program holds 1 token of that bag for one second after the rest. The rest arrives at the claim time. That 1 token arrives one second later. The creator still receives every reserved token. This is how a single claim is stored.
            </p>
            <p className="note">
              Two or more claims divide the bag into equal whole tokens. Those claims release their full share at each time. They do not hold 1 token back. Claim 1 is the first release, after the wait you set. Each later claim comes one span after the claim before it. If the bag does not divide evenly, the extra whole tokens sit on claim 1.
            </p>
            {reservePercent === "custom" ? (
              <label>
                Creator tokens
                <input
                  className={reserveError ? "bad" : undefined}
                  aria-invalid={reserveError ? true : undefined}
                  value={reserveTokenText}
                  inputMode="numeric"
                  placeholder="50000000"
                  onChange={(event) => setReserveTokenText(event.target.value.replace(/[^\d]/g, ""))}
                />
              </label>
            ) : (
              <p className="note">
                {tokensForPercent(reserveSupply, reservePercent).toLocaleString("en-US")} tokens. That is {reservePercent}% of{" "}
                {reserveSupply.toLocaleString("en-US")}.
              </p>
            )}
            <div className="choices" role="group" aria-label="When the creator claims">
              <button type="button" aria-pressed={reserveWhen === "open"} onClick={() => setReserveWhen("open")}>
                When it locks
              </button>
              <button type="button" aria-pressed={reserveWhen === "d30"} onClick={() => setReserveWhen("d30")}>
                30 days after the lock
              </button>
              <button type="button" aria-pressed={reserveWhen === "d90"} onClick={() => setReserveWhen("d90")}>
                90 days after the lock
              </button>
              <button type="button" aria-pressed={reserveWhen === "m6"} onClick={() => setReserveWhen("m6")}>
                Every 30 days, 6 times
              </button>
              <button type="button" aria-pressed={reserveWhen === "y1"} onClick={() => setReserveWhen("y1")}>
                Every 30 days, 12 times
              </button>
              <button type="button" aria-pressed={reserveWhen === "custom"} onClick={() => setReserveWhen("custom")}>
                Custom
              </button>
            </div>
            {reserveWhen === "custom" ? (
              <>
                <label>
                  Days until claim 1
                  <input
                    className={reserveError ? "bad" : undefined}
                    value={reserveWaitText}
                    inputMode="numeric"
                    onChange={(event) => setReserveWaitText(event.target.value.replace(/[^\d]/g, ""))}
                  />
                </label>
                <label>
                  Days between claims
                  <input
                    className={reserveError ? "bad" : undefined}
                    value={reserveReleaseText}
                    inputMode="numeric"
                    onChange={(event) => setReserveReleaseText(event.target.value.replace(/[^\d]/g, ""))}
                  />
                </label>
                <label>
                  Number of claims
                  <input
                    className={reserveError ? "bad" : undefined}
                    value={reserveClaimsText}
                    inputMode="numeric"
                    onChange={(event) => setReserveClaimsText(event.target.value.replace(/[^\d]/g, ""))}
                  />
                </label>
              </>
            ) : null}
            {reserveError ? <p className="field-error">{reserveError}</p> : null}
            <p className="note">
              {picture.creator ||
                "These tokens come out of the supply. Buyers cannot buy them, and they do not go into the pool. The clock starts when someone locks this supply after the curve fills."}
            </p>
          </>
        )}
        <button
          className="solid"
          type="submit"
          disabled={busy || !picture.ok || feeProblem.length > 0 || endingProblem.length > 0 || compoundProblem.length > 0 || name.trim().length === 0}
        >
          {busy ? "Buildingâ€¦" : "Review create"}
        </button>
        {picture.ok && paid?.fingerprint === formFingerprint ? (
          <p className="note">
            The template for these numbers is already on chain. Review create signs the token only. Template rent
            is not charged again.
          </p>
        ) : picture.ok ? (
          <p className="note">
            Creating it signs twice and pays about 0.006 SOL of rent for a new template. The supply and prices
            are written into that template and cannot be edited later.
            {paid ? " Changing these numbers after a paid template charges that rent again." : ""}
          </p>
        ) : null}
      </form>

      <p className="note">
        The tokens on this network are also on the <Link href="/pools">Pools</Link> page. Open one there to buy or sell it.
      </p>
      <PoolBoard watch={message} limit={24} />

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="status">{message}</p> : null}
      {cluster === "devnet" ? (
        <p className="note">
          Turn PAR on for the shelf. Leave it off and the selected card sets the {unit} lock. Par fixed is one
          billion tokens at {quoteKind === "sol" ? "0.00005 SOL, locking at 0.00006 SOL" : quoteKind === "other" ? `0.00005 ${unit}, locking at 0.00006 ${unit}` : "$0.00005, locking at $0.00006"}. Practice USDC comes from the{" "}
          <a href="https://faucet.circle.com/">Circle faucet</a>, about $20, and practice SOL from the{" "}
          <a href="https://faucet.solana.com/">Solana faucet</a>. The trading fee opens at{" "}
          {bpsToPercent(openingBps)}, so a completing buy sends more {unit} than the amount on the card.
        </p>
      ) : (
        <p className="note">
          PAR creates a new template and shows the SOL rent before the wallet opens. {unit} spent to create is 0.
        </p>
      )}

      {pending ? (
        <MainnetGate
          kicker={cluster === "devnet" ? "Practice check" : "Real network check"}
          title={cluster === "devnet" ? "Create this token on the practice network?" : "Create this token on the real network?"}
          lines={pending.lines}
          confirmLabel="Open wallet"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const next = pending;
            setPending(null);
            setBusy(true);
            finish(next)
              .then((result) => {
                if (result !== "created") return;
                setName("");
                setSymbol("");
                setSymbolEdited(false);
                setImage("");
                setDescription("");
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not create the pool.");
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
