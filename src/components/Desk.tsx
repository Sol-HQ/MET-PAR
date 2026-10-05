"use client";

import { deriveDbcPoolAddress, DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ListingActions } from "@/components/ListingActions";
import { MainnetGate } from "@/components/MainnetGate";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useCluster } from "@/lib/cluster";
import { DEFAULT_FEE_DECAY_SECONDS, DEFAULT_MIGRATION_FEE_BPS, FEE_DECAY_CHOICES, HIDDEN_POOLS, MIGRATION_FEE_CHOICES, feeDecayLabel, meteoraPoolUrl, migrationFeeLabel, quoteLabel, quoteMintAddress, type ClusterName, type QuoteKind } from "@/lib/constants";
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
  poolForMigratingShare,
  priceField,
  shareMarkFor,
  type LaunchChoice,
  type RaiseChoice,
} from "@/lib/launch";
import { bpsToPercent, formatDollars, formatLamports, formatMoney, plainDecimal } from "@/lib/format";
import { shrinkImage } from "@/lib/image";
import { loadPool } from "@/lib/load-pool";
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

type CardListing = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  image: string;
  filling: boolean;
  percent: number;
  fullAt: string;
  supply: string;
  opens: string;
  ends: string;
  dammPool: string | null;
  quoteMint: string;
  quoteSymbol: string;
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

function fullAtFor(threshold: BN, decimals: number, symbol: string): string {
  return `${formatMoney(threshold, decimals)} ${symbol}`;
}

function percentField(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return String(rounded);
}

function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

function solNote(text: string, usdPerSol: number): string {
  const amount = Number(text);
  if (!(usdPerSol > 0) || !(amount > 0)) return "";
  return ` (about ${formatDollars(amount * usdPerSol)})`;
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
  const { publicKey, signTransaction } = useWallet();
  const [preset, setPreset] = useState<"starter" | "solid" | "deep" | "thin" | "fixed" | "custom">("starter");
  const [onPar, setOnPar] = useState(false);
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
  const [cards, setCards] = useState<CardListing[]>([]);
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
    if (onPar) return { kind: "par", raise, parPrice: Number(parText), poolPrice: Number(poolText), ...share };
    return { kind: "climb", raise };
  }, [preset, onPar, raise, supplyText, openText, endText, parText, poolText, migratePercent]);
  const openingBps = platform.openingFeeBps;
  const settledBps = platform.platformFeeBps;
  let feeProblem = "";
  let parsedFeeBps = 0;
  try {
    parsedFeeBps = parseFeePercent(curveFee);
    assertCurveFee(parsedFeeBps);
  } catch (cause) {
    feeProblem = cause instanceof Error ? cause.message : "That trading fee is not allowed.";
  }
  const openingFeeForShape = feeProblem ? openingBps : parsedFeeBps;
  const endingForCurve = feeFlat ? openingFeeForShape : Math.min(openingFeeForShape, settledBps);
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
  const customMarks = useMemo(() => {
    const ending = endingForCurve;
    const feePercent = platform.platformFeePercent ?? 20;
    if (preset === "custom" && !onPar) {
      return checkClimbCustom(supplyText, openText, endText, migrateText, openingFeeForShape, ending, feePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, quoteExtra);
    }
    if (onPar && preset !== "fixed") {
      return checkParPrices(
        parText,
        poolText,
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
      );
    }
    return null;
  }, [preset, onPar, supplyText, openText, endText, parText, poolText, migrateText, raise, openingFeeForShape, endingForCurve, platform.platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, quoteExtra]);
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
      );
    if (quoteKind === "other" && !quoteCheck?.ok) {
      return { ...built, ok: false, error: quoteCheck?.message || "Check the quote mint before review." };
    }
    if (!reserveError) return built;
    return { ...built, ok: false, creator: "", error: reserveError };
  }, [customMarks, choice, openingFeeForShape, endingForCurve, platform.platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, curveReserve, reserveError, quoteExtra, quoteCheck]);
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
    parText,
    poolText,
    migrateText,
    curveFeeBps: parsedFeeBps,
    endingFeeBps: feeFlat ? parsedFeeBps : Math.min(parsedFeeBps, settledBps),
    feeFlat,
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
      const response = await fetch("/api/image", {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
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

  useEffect(() => {
    let cancelled = false;
    const remembered = readRemembered().filter((item) => item.cluster === cluster);

    async function load() {
      const seeds = new Map<string, { preset?: string; name: string; symbol: string; mint: string }>();
      for (const item of remembered) {
        seeds.set(item.pool, {
          preset: item.preset,
          name: item.name,
          symbol: item.symbol,
          mint: item.mint || "",
        });
      }
      const listed = await fetch(`/api/listings?cluster=${cluster}`)
        .then(async (response) => {
          if (!response.ok) return [] as string[];
          const body = (await response.json()) as { pools?: { pool?: string }[] };
          return (body.pools || []).map((item) => item.pool).filter((pool): pool is string => typeof pool === "string" && !HIDDEN_POOLS.has(pool));
        })
        .catch(() => [] as string[]);
      for (const pool of listed) {
        if (!seeds.has(pool)) seeds.set(pool, { name: "Listing", symbol: "", mint: "" });
      }

      const loaded = await Promise.all(
        [...seeds.entries()].slice(0, 24).map(async ([pool, seed]) => {
          try {
            const snapshot = await loadPool(connection, pool);
            return {
              pool,
              name: snapshot.name || seed.name,
              symbol: snapshot.symbol || seed.symbol,
              mint: snapshot.baseMint,
              image: snapshot.image,
              filling: !snapshot.isMigrated,
              percent: snapshot.percent,
              fullAt: fullAtFor(snapshot.threshold, snapshot.quoteDecimals, snapshot.quoteSymbol),
              supply: snapshot.supply,
              opens: snapshot.startPrice,
              ends: snapshot.endPrice,
              dammPool: snapshot.dammPool,
              quoteMint: snapshot.quoteMint,
              quoteSymbol: snapshot.quoteSymbol,
            } satisfies CardListing;
          } catch {
            return {
              pool,
              name: seed.name,
              symbol: seed.symbol,
              mint: seed.mint,
              image: "",
              filling: true,
              percent: 0,
              fullAt: "",
              supply: "",
              opens: "",
              ends: "",
              dammPool: null,
              quoteMint: "",
              quoteSymbol: "USDC",
            } satisfies CardListing;
          }
        }),
      );
      if (!cancelled) setCards(loaded);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [cluster, connection, message]);

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
        setMessage("Template confirmed. Building the token…");
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
    const endingFeeBps = feeFlat ? curveFeeBps : Math.min(curveFeeBps, settledBps);
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
          ...buildLaunchConfig(choice, curveFeeBps, endingFeeBps, platformFeePercent, feeDecaySeconds, migrationFeeBps, quoteKind, reserve, quoteExtra),
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
          : `Curve fee: starts at ${bpsToPercent(curveFeeBps)} and falls to ${bpsToPercent(endingFeeBps)} over ${feeDecayLabel(feeDecaySeconds)}.`;
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
          `After migration the pool charges ${migrationFeeLabel(migrationFeeBps)} on every swap. Of that fee: Meteora ${METEORA_TRADING_FEE_PERCENT}%, platform ${platformFeePercent}%, token creator ${creatorPercent}%. Those fee shares wait until they are claimed. The claim buttons on this site withdraw the curve fee from before migration.`,
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
  const writtenEnd = writtenStart === null ? null : feeFlat ? writtenStart : Math.min(writtenStart, settledBps);
  const feeStory =
    writtenStart === null || writtenEnd === null
      ? "Fix the trading fee. It has to be from 0.25% to 99%."
      : feeFlat
        ? `Every trade until migration pays ${bpsToPercent(writtenStart)}.`
        : writtenStart === writtenEnd
          ? `The fee stays at ${bpsToPercent(writtenStart)} because that number is already at the settled fee.`
          : `The fee starts at ${bpsToPercent(writtenStart)} and falls to ${bpsToPercent(writtenEnd)} over ${feeDecayLabel(feeDecaySeconds)}.`;
  const filling = cards.filter((card) => card.filling);
  const trading = cards.filter((card) => !card.filling);

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
              A falling fee starts at the percent you type and steps down to {bpsToPercent(settledBps)}. You pick
              the clock: 1 hour, 6 hours, 12 hours, 24 hours, 48 hours, or 7 days. A buy at the open pays more. A
              buy after the clock pays {bpsToPercent(settledBps)}.
            </p>
            <p>A flat fee stays at the percent you type for the whole sale.</p>
            <h2>How they work together</h2>
            <p>
              The shelf ends when its tokens are bought. The curve fee ends when its clock runs out. Each one ends
              on its own.
            </p>
            <p>If buying is slow, the fee can already be at {bpsToPercent(settledBps)} while the price is still on the shelf.</p>
            <p>If the shelf sells out quickly, the price can already be walking up to the pool while the fee is still falling.</p>
            <h2>Graduation</h2>
            <p>
              Graduation is when the sale is full. The remaining tokens and the {unit} lock into a trading pool.
              They cannot be withdrawn. Later buys can move the price up, and later sells can move it down.
            </p>
            <p>
              The curve fee stops at graduation, even if time is left on the clock. From then on, every trade pays
              the pool fee you pick below. The default is 0.25%, and it stays at that percent.
            </p>
            <p>The prices and the fee are written into the template. They cannot be edited later.</p>
          </div>
        </details>
        <Link href="/asset" className="asset-link">
          Real-world asset
        </Link>
        <p>
          A plain PAR token is created on this page. A real-world asset is a separate page. It adds one master,
          sent to the program vault, and one edition, which is the title. The coin there is a payment token and a meme: it pays for the title, and the meme is the joy
          and heart of the object. After graduation the coin trades for a set number of days, and then the creator
          lists the title through Tensor. The title can go into the escrow, and that program sells it. (The escrow
          path is not a mainnet option yet. Coming soon.)
        </p>
        <p>
          PAR runs on Meteora. The curve, the pool, and the graduation are Meteora&apos;s. You set par, and
          most of the tokens sold to buyers stay within 10% of it, so a buyer now and a buyer later can pay
          nearly the same price. That shelf is a share of the sale. It lasts until those tokens are bought.
          The fee can fall over the time you choose, from one hour to a week, so a rush at the open costs more
          while the price is still near par. The last slice of the sale walks the price up to the pool you
          set. The pool locks there, and later buys can move the price higher.
        </p>
        <p>
          Turn PAR on for that opening. Leave it off and the price climbs from the first token to the last.
          Starter, Solid, Deep, and Thin then lock the {unit} printed on the card. The fee below can fall to{" "}
          {bpsToPercent(settledBps)}, or stay at the percent you type until migration. After the pool locks, you
          choose that pool fee. The default is 0.25%.
        </p>
        <div className="beats">
          {onPar || preset === "fixed" ? (
            <>
              <article>
                <strong>1. At par</strong>
                <span>Most tokens buyers receive are sold inside a 10% band around the price you set. The sheet names that band and the pool price it walks to.</span>
              </article>
              <article>
                <strong>2. The walk</strong>
                <span>The rest of the sale moves the price from that band to the pool. Both prices are on the sheet before anyone buys.</span>
              </article>
              <article>
                <strong>3. The lock</strong>
                <span>The remaining tokens and the {unit} lock together. They cannot be withdrawn. Trading continues from the pool price, and later buys can move it higher.</span>
              </article>
            </>
          ) : (
            <>
              <article>
                <strong>1. The climb</strong>
                <span>PAR is off. The price rises from the first token to the last. The sheet names the open and the pool.</span>
              </article>
              <article>
                <strong>2. The lock</strong>
                <span>Tokens and {unit} lock together at the end of the climb. The sheet names both amounts.</span>
              </article>
              <article>
                <strong>3. After the lock</strong>
                <span>Trading continues from the pool price. Later buys can move it higher, and later sells can move it lower.</span>
              </article>
            </>
          )}
        </div>
        <div className="seen">
          <h2>How it gets seen</h2>
          <p>
            This page is the shop from the first minute. Share the token page and the mint. That link is how
            a buyer gets in before any list ranks the coin.
          </p>
          <p>
            Meteora&apos;s curve is a market Jupiter, Axiom, and Photon can pick up before the pool opens.
            Those screens rank coins that have real buys. A quiet coin stays here until someone buys. After
            the curve fills, the Meteora pool is the market that stays on those screens. A public name, symbol,
            and image are what let them draw the card.
          </p>
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
            : `Falls means this percent is the opening fee. It falls to ${bpsToPercent(settledBps)} over the clock below.`}{" "}
          {feeStory} Meteora writes it into the template and does not let it be edited later.
        </p>
        {feeFlat ? null : (
          <>
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
              This clock is {feeDecayLabel(feeDecaySeconds)}. It is the fall from the opening fee to{" "}
              {bpsToPercent(settledBps)}, and it is written into the template.
            </p>
          </>
        )}
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
              Meteora {METEORA_TRADING_FEE_PERCENT}%, fixed in the program. Platform {platform.platformFeePercent}%.
              Token creator {creatorSharePercent(platform.platformFeePercent)}%. Fees accrue on the pool as
              people trade. The creator wallet claims the creator share on the token page. The platform wallet
              claims the platform share on that same page, and admin lists every token for the same claim. The
              creator cannot change this split.
            </dd>
          </div>
          <div>
            <dt>You spend to create</dt>
            <dd>0 {unit}. The review shows the SOL network fee and rent before the wallet opens.</dd>
          </div>
          <div>
            <dt>After graduation</dt>
            <dd>
              Every swap pays {migrationFeeLabel(migrationFeeBps)}. Of that fee, Meteora keeps {METEORA_TRADING_FEE_PERCENT}%, the platform
              keeps {platform.platformFeePercent}%, and the token creator keeps{" "}
              {creatorSharePercent(platform.platformFeePercent)}%. The locked tokens and the locked {unit} stay in the pool. They are separate from this fee. Trading
              opens at the pool price. A later buy moves the price up, and a later sell moves it down. The fee
              shares wait until they are claimed. The claim buttons on this site withdraw the curve fee, from
              trades before migration. A token already created keeps the split written into it.
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
              {quoteBusy ? "Checking…" : "Check this mint"}
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
            ? `Buyers pay SOL. 0.002 and 0.0002 are fractions of one SOL. ${solUsd > 0 ? `One SOL is about ${formatDollars(solUsd)} right now.` : "The dollar line uses the live SOL price."} ${cluster === "devnet" ? "Practice SOL is not worth that. The dollar line uses the real-network price." : ""} Thin test locks 1 SOL, which a practice wallet can fill from the faucet. On the real network, Meteora opens a SOL curve by itself at 10 SOL. A par of 1 means 1 SOL per token, and that lock is large.`
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
                {onPar
                  ? "One billion tokens"
                  : quoteKind === "sol"
                    ? `${grouped(item.raise)} SOL locked`
                    : quoteKind === "other"
                      ? `${grouped(item.raise)} ${unit} locked`
                      : `$${grouped(item.raise)} locked`}
              </strong>
              <span>
                {onPar
                  ? `PAR is on. The prices below set the ${unit} lock. This card's amount applies only with PAR off.`
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
              {onPar
                ? "One billion tokens"
                : quoteKind === "sol"
                  ? "1,000,000,000 tokens, 1 SOL locked"
                  : quoteKind === "other"
                    ? `1,000,000,000 tokens, 750 ${unit} locked`
                    : "1,000,000,000 tokens, $750 locked"}
            </strong>
            <span>
              {onPar
                ? `PAR is on. The prices below set the ${unit} lock. ${quoteKind === "sol" ? "1 SOL" : quoteKind === "other" ? `750 ${unit}` : "$750"} applies only with PAR off.`
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
            <span>Turn PAR on for the shelf. A rejected number turns red.</span>
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
                  ? `PAR is on. Most tokens sold to buyers stay within 10% of the par you type. Starter, Solid, Deep, and Thin do not set the ${unit} while this is on.`
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
                value={parText}
                inputMode="decimal"
                onChange={(event) => {
                  shareDriver.current = "prices";
                  setParText(event.target.value.replace(/[^\d.]/g, ""));
                }}
              />
              {customMarks.par && customMarks.par !== customMarks.pool ? (
                <span className="field-error">{customMarks.par}</span>
              ) : null}
              {quoteKind === "sol" && !customMarks.par ? <span className="note">{solDollarHint(parText, solUsd)}</span> : null}
            </label>
            <label>
              Pool price, {unit} per token
              <input
                className={customMarks.pool ? "bad" : undefined}
                aria-invalid={customMarks.pool ? true : undefined}
                value={poolText}
                inputMode="decimal"
                onChange={(event) => {
                  shareDriver.current = "prices";
                  setPoolText(event.target.value.replace(/[^\d.]/g, ""));
                }}
              />
              {customMarks.pool ? <span className="field-error">{customMarks.pool}</span> : null}
              {quoteKind === "sol" && !customMarks.pool ? <span className="note">{solDollarHint(poolText, solUsd)}</span> : null}
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
              {picture.ok
                ? `These prices lock ${percentField(picture.migratedPercent)}% of the supply, ${grouped(picture.migratedTokens)} tokens, because the pool price is ${(Number(poolText) / Number(parText)).toLocaleString("en-US", { maximumFractionDigits: 2 })} times par. The dollar amount does not set the percent. $1 to $1.20 locks the same percent as $0.20 to $0.24. Type any whole percent from 35 to 48, including 47. The four buttons are shortcuts. Par can be any price. The pool price then moves to the one finish that locks that percent. 35% finishes at almost double par. 48% finishes just above the 10% shelf.`
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
            <p className="note">
              A single handover holds 1 token back for one second. That is how the program stores one claim. Two or more
              claims do not use that holdback. The wait is claim 1. Each later claim comes one span after the claim before it.
            </p>
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
          disabled={busy || !picture.ok || feeProblem.length > 0 || name.trim().length === 0}
        >
          {busy ? "Building…" : "Review create"}
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

      <section className="rows">
        <p className="note">
          Every token created on this network is listed below. Click one to buy or sell it on this page. A
          practice token does not show on Jupiter. The Meteora trading pool opens after the curve fills, and
          that link appears on the card.
        </p>
        <div>
          <h2>Filling</h2>
          {filling.length === 0 ? <p className="note">No curve is filling.</p> : null}
          <div className="card-grid">
            {filling.map((card) => (
              <ListingCard key={card.pool} card={card} cluster={cluster} solUsd={solUsd} />
            ))}
          </div>
        </div>
        <div>
          <h2>Trading</h2>
          {trading.length === 0 ? <p className="note">No trading pool is open yet.</p> : null}
          <div className="card-grid">
            {trading.map((card) => (
              <ListingCard key={card.pool} card={card} cluster={cluster} solUsd={solUsd} />
            ))}
          </div>
        </div>
      </section>

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

function ListingCard({ card, cluster, solUsd }: { card: CardListing; cluster: ClusterName; solUsd: number }) {
  const sharePath = `/pool/${card.pool}`;
  return (
    <article className="card">
      {card.image ? <img className="token-preview" src={card.image} alt="" /> : null}
      <Link href={`/pool/${card.pool}`} className="card-link">
        <h3>
          {card.name} {card.symbol ? <span>{card.symbol}</span> : null}
        </h3>
      </Link>
      <p className="rule">
        {card.supply ? `${Number(card.supply).toLocaleString("en-US")} supply. ` : ""}
        {card.opens
          ? card.quoteSymbol === "SOL"
            ? `par ${card.opens} SOL${solNote(card.opens, solUsd)}, pool locks at ${card.ends} SOL${solNote(card.ends, solUsd)}, `
            : `par $${card.opens}, pool locks at $${card.ends}, `
          : ""}
        full at {card.fullAt}
        {card.quoteSymbol === "SOL" ? solNote(String(parseFloat(card.fullAt)), solUsd) : ""}
      </p>
      <p className="note">
        {card.filling
          ? "Still on the curve. View PAR pool stays on this site. The Meteora pool is not open yet."
          : cluster === "devnet"
            ? "The curve is full. View PAR pool stays on this site. Meteora practice pool opens the practice site."
            : "The curve is full. View PAR pool stays on this site. Meteora pool opens Meteora on the real network."}
      </p>
      <ListingActions
        name={card.name}
        mint={card.mint}
        fullAt={card.fullAt}
        viewHref={sharePath}
        sharePath={sharePath}
        quoteMint={card.quoteMint}
        opensAt={card.opens}
        endsAt={card.ends}
        cluster={cluster}
        meteoraHref={card.dammPool ? meteoraPoolUrl(card.dammPool, cluster) : undefined}
      />
    </article>
  );
}
