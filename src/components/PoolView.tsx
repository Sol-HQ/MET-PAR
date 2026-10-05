"use client";

import {
  ActivationType,
  DynamicBondingCurveClient,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  CpAmm,
  SwapMode as DammSwapMode,
  getCurrentPoint,
  getTokenProgram,
} from "@meteora-ag/cp-amm-sdk";
import { LockClient } from "@meteora-ag/met-lock-sdk";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { ListingActions } from "@/components/ListingActions";
import { RecordPanel } from "@/components/RecordPanel";
import { isAdminWallet, PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useCluster } from "@/lib/cluster";
import { explorerAccount, explorerTx, feeDecayLabel, meteoraPoolUrl } from "@/lib/constants";
import { bpsToPercent, dollarsToSol, formatDollars, formatLamports, formatMoney, pricePerToken, rawToUi, shortAddress, uiToRaw } from "@/lib/format";
import { loadDammMarket, loadPool, type DammMarket, type PoolSnapshot } from "@/lib/load-pool";
import { loadHolders, loadTrades, type HolderRow, type TradeRow } from "@/lib/pool-book";
import { METEORA_TRADING_FEE_PERCENT } from "@/lib/platform";
import { prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";
import { loadCreatorClaim, nextUnlockSeconds, publicSchedule, storyFromRaw, type CreatorClaim } from "@/lib/vesting";

type Side = "buy" | "sell";

const SLIPPAGE_CHOICES = [
  { bps: 100, label: "1%", detail: "100 bps" },
  { bps: 200, label: "2%", detail: "200 bps" },
  { bps: 300, label: "3%", detail: "300 bps" },
  { bps: 400, label: "4%", detail: "400 bps" },
] as const;

function feeShares(creatorTradingFeePercentage: number): { meteora: number; creator: number; platform: number } {
  const creator = (creatorTradingFeePercentage * (100 - METEORA_TRADING_FEE_PERCENT)) / 100;
  const platform = 100 - METEORA_TRADING_FEE_PERCENT - creator;
  return { meteora: METEORA_TRADING_FEE_PERCENT, creator, platform };
}

function shareLabel(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return Number.isInteger(value) ? `${value}%` : `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

type QuotePreview = {
  side: Side;
  slippageBps: number;
  entered: string;
  used: string;
  tokens: string;
  floor: string;
  tradingFee: string;
  protocolFee: string;
  unspent: string;
  feeRate: string;
  averagePrice: string;
  minimumAmountOut: BN;
  amountIn: BN;
  /** Set when the buyer typed dollars on a SOL pool. The swap still spends SOL. */
  typedDollars: string;
};

function marketCap(price: string, supply: string): string {
  const cap = Number(price) * Number(supply);
  if (!Number.isFinite(cap) || cap <= 0) return "";
  return cap.toLocaleString("en-US", { maximumFractionDigits: cap >= 1 ? 2 : 6 });
}

function groupUi(amount: string): string {
  const [whole, frac] = amount.split(".");
  const grouped = Number(whole || "0").toLocaleString("en-US");
  return frac ? `${grouped}.${frac}` : grouped;
}

function tradeWhen(time: number): string {
  if (!time) return "";
  return new Date(time * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function readHolding(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<BN> {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(mint, owner, false, program);
      const account = await getAccount(connection, ata, "confirmed", program);
      return new BN(account.amount.toString());
    } catch {
      // This mint is not held on that token program.
    }
  }
  return new BN(0);
}

type PendingSwap = {
  prepared: PreparedTransaction;
  lines: string[];
};

async function quoteGraduated(
  snapshot: PoolSnapshot,
  connection: Connection,
  nextSide: Side,
  amountIn: BN,
  slippageBps: number,
): Promise<QuotePreview> {
  if (!snapshot.dammPool) throw new Error("This token has no trading pool yet.");
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(snapshot.dammPool);
  const poolState = await cpAmm.fetchPoolState(pool);
  const currentPoint = await getCurrentPoint(connection, poolState.activationType);
  const inputMint = new PublicKey(nextSide === "buy" ? snapshot.quoteMint : snapshot.baseMint);
  const base = new PublicKey(snapshot.baseMint);
  const tokenADecimal = poolState.tokenAMint.equals(base) ? snapshot.baseDecimals : snapshot.quoteDecimals;
  const tokenBDecimal = poolState.tokenBMint.equals(base) ? snapshot.baseDecimals : snapshot.quoteDecimals;
  const quoted = cpAmm.getQuote2({
    inputTokenMint: inputMint,
    poolState,
    currentPoint,
    amountIn,
    slippage: slippageBps,
    swapMode: DammSwapMode.ExactIn,
    tokenADecimal,
    tokenBDecimal,
    hasReferral: false,
  });
  if (!quoted.minimumAmountOut) throw new Error("The quote did not return a minimum out.");
  const decimalsIn = nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals;
  const decimalsOut = nextSide === "buy" ? snapshot.baseDecimals : snapshot.quoteDecimals;
  const used = new BN(quoted.includedFeeInputAmount.toString());
  const output = new BN(quoted.outputAmount.toString());
  const tradingFee = new BN(quoted.claimingFee.toString()).add(new BN(quoted.compoundingFee.toString()));
  const protocolFee = new BN(quoted.protocolFee.toString());
  const averagePrice =
    nextSide === "sell"
      ? pricePerToken(output, amountIn, snapshot.quoteDecimals, snapshot.baseDecimals)
      : pricePerToken(used, output, snapshot.quoteDecimals, snapshot.baseDecimals);
  const feeRate = used.isZero()
    ? "0%"
    : bpsToPercent(tradingFee.add(protocolFee).mul(new BN(10_000)).div(used).toNumber());
  return {
    side: nextSide,
    slippageBps,
    entered: formatMoney(amountIn, decimalsIn),
    used: formatMoney(used, decimalsIn),
    tokens: rawToUi(output, decimalsOut),
    floor: rawToUi(quoted.minimumAmountOut, decimalsOut),
    tradingFee: formatMoney(tradingFee, snapshot.quoteDecimals),
    protocolFee: formatMoney(protocolFee, snapshot.quoteDecimals),
    unspent: formatMoney(new BN(quoted.amountLeft.toString()), decimalsIn),
    feeRate,
    averagePrice,
    minimumAmountOut: quoted.minimumAmountOut,
    amountIn,
    typedDollars: "",
  };
}

async function graduatedSwapTransaction(
  connection: Connection,
  owner: PublicKey,
  snapshot: PoolSnapshot,
  preview: QuotePreview,
) {
  if (!snapshot.dammPool) throw new Error("This token has no trading pool yet.");
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(snapshot.dammPool);
  const poolState = await cpAmm.fetchPoolState(pool);
  const inputMint = new PublicKey(preview.side === "buy" ? snapshot.quoteMint : snapshot.baseMint);
  const outputMint = new PublicKey(preview.side === "buy" ? snapshot.baseMint : snapshot.quoteMint);
  return cpAmm.swap2({
    payer: owner,
    pool,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
    poolState,
    swapMode: DammSwapMode.ExactIn,
    amountIn: preview.amountIn,
    minimumAmountOut: preview.minimumAmountOut,
  });
}

export function PoolView({ address }: { address: string }) {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [snapshot, setSnapshot] = useState<PoolSnapshot | null>(null);
  const [market, setMarket] = useState<DammMarket | null>(null);
  const [holding, setHolding] = useState<BN | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSwap | null>(null);
  const [signature, setSignature] = useState("");
  const [spendDollars, setSpendDollars] = useState(false);
  const [solUsd, setSolUsd] = useState(0);
  const [holders, setHolders] = useState<HolderRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [holdersCapped, setHoldersCapped] = useState(false);
  const [creatorClaim, setCreatorClaim] = useState<CreatorClaim | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setError("");
    try {
      const next = await loadPool(connection, address);
      const nextMarket = next.dammPool ? await loadDammMarket(connection, next).catch(() => null) : null;
      const [nextHolders, nextTrades] = await Promise.all([
        loadHolders(connection, next.baseMint, next.baseDecimals, [
          next.baseVault,
          next.quoteVault,
          ...(nextMarket ? [nextMarket.baseVault, nextMarket.quoteVault] : []),
        ]).catch(() => ({ rows: [] as HolderRow[], capped: false })),
        loadTrades(connection, next).catch(() => [] as TradeRow[]),
      ]);
      const reserved = next.vestingCliffUnlock.add(next.vestingPerPeriod.mul(new BN(next.vestingPeriods)));
      const nextClaim =
        reserved.isZero() || next.migrationProgress < 2
          ? null
          : await loadCreatorClaim(connection, new PublicKey(address)).catch(() => null);
      setSnapshot(next);
      setMarket(nextMarket);
      setHolders(nextHolders.rows);
      setHoldersCapped(nextHolders.capped);
      setTrades(nextTrades);
      setCreatorClaim(nextClaim);
    } catch (cause) {
      if (quiet) return;
      setSnapshot(null);
      setMarket(null);
      setHolders([]);
      setTrades([]);
      setCreatorClaim(null);
      setError(cause instanceof Error ? cause.message : "Could not load this pool.");
    }
  }, [address, connection]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(true), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setSpendDollars(false);
    setAmount("");
    setQuote(null);
  }, [address]);

  useEffect(() => {
    if (snapshot?.quoteSymbol !== "SOL") return;
    let cancelled = false;
    async function loadPrice() {
      const response = await fetch("/api/sol-price");
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { usd?: number };
      if (typeof body.usd === "number" && body.usd > 0 && !cancelled) setSolUsd(body.usd);
    }
    void loadPrice().catch(() => undefined);
    const timer = setInterval(() => void loadPrice().catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [snapshot?.quoteSymbol]);

  useEffect(() => {
    if (!publicKey || !snapshot) {
      setHolding(null);
      return;
    }
    let cancelled = false;
    const mint = new PublicKey(snapshot.baseMint);
    void readHolding(connection, publicKey, mint).then((amount) => {
      if (!cancelled) setHolding(amount);
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, snapshot, connection]);

  async function buildQuote(nextSide: Side, uiAmount: string): Promise<QuotePreview> {
    if (!snapshot) throw new Error("Pool is still loading.");
    let spend = uiAmount;
    let typedDollars = "";
    if (nextSide === "buy" && snapshot.quoteSymbol === "SOL" && spendDollars) {
      if (!(solUsd > 0)) throw new Error("The SOL price is still loading.");
      const dollars = Number(uiAmount);
      if (!Number.isFinite(dollars) || dollars <= 0) throw new Error("Enter a dollar amount.");
      spend = dollarsToSol(dollars, solUsd);
      if (!spend) throw new Error("That dollar amount is too small to become SOL.");
      typedDollars = formatDollars(dollars);
    }
    const amountIn = uiToRaw(spend, nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals);
    if (snapshot.isMigrated && snapshot.dammPool) {
      return { ...(await quoteGraduated(snapshot, connection, nextSide, amountIn, slippageBps)), typedDollars };
    }
    const client = DynamicBondingCurveClient.create(connection, "confirmed");
    const pool = await client.state.getPool(address);
    const config = pool ? await client.state.getPoolConfig(pool.poolState.config) : null;
    if (!pool || !config) throw new Error("Pool disappeared.");
    const currentPoint =
      config.activationType === ActivationType.Slot
        ? new BN(await connection.getSlot())
        : new BN(Math.floor(Date.now() / 1000));
    const quoted = client.pool.swapQuote2({
      virtualPool: pool,
      config,
      swapBaseForQuote: nextSide === "sell",
      swapMode: nextSide === "buy" ? SwapMode.PartialFill : SwapMode.ExactIn,
      amountIn,
      slippageBps,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
    });
    if (!quoted.minimumAmountOut) throw new Error("The quote did not return a minimum out.");
    const decimalsIn = nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals;
    const decimalsOut = nextSide === "buy" ? snapshot.baseDecimals : snapshot.quoteDecimals;
    const used = new BN(quoted.includedFeeInputAmount.toString());
    const output = new BN(quoted.outputAmount.toString());
    const tradingFee = new BN(quoted.tradingFee.toString());
    const protocolFee = new BN(quoted.protocolFee.toString());
    const averagePrice =
      nextSide === "sell"
        ? pricePerToken(output, amountIn, snapshot.quoteDecimals, snapshot.baseDecimals)
        : pricePerToken(used, output, snapshot.quoteDecimals, snapshot.baseDecimals);
    const feeRate = used.isZero() ? "0%" : bpsToPercent(tradingFee.add(protocolFee).mul(new BN(10_000)).div(used).toNumber());
    return {
      side: nextSide,
      slippageBps,
      entered: formatMoney(amountIn, decimalsIn),
      used: formatMoney(used, decimalsIn),
      tokens: rawToUi(output, decimalsOut),
      floor: rawToUi(quoted.minimumAmountOut, decimalsOut),
      tradingFee: formatMoney(tradingFee, snapshot.quoteDecimals),
      protocolFee: formatMoney(protocolFee, snapshot.quoteDecimals),
      unspent: formatMoney(new BN(quoted.amountLeft.toString()), decimalsIn),
      feeRate,
      averagePrice,
      minimumAmountOut: quoted.minimumAmountOut,
      amountIn,
      typedDollars,
    };
  }

  useEffect(() => {
    if (!snapshot?.trading && !(snapshot?.isMigrated && snapshot.dammPool)) return;
    const uiAmount = amount.trim();
    if (!uiAmount) {
      setQuote(null);
      return;
    }
    if (side === "sell" && holding && snapshot) {
      try {
        const raw = uiToRaw(uiAmount, snapshot.baseDecimals);
        if (raw.gt(holding)) {
          setQuote(null);
          setError(`This wallet holds ${rawToUi(holding, snapshot.baseDecimals)} ${snapshot.symbol}.`);
          return;
        }
      } catch {
        // buildQuote reports an amount the parser cannot read.
      }
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void buildQuote(side, uiAmount)
        .then((next) => {
          if (!cancelled) {
            setQuote(next);
            setError("");
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setQuote(null);
            setError(cause instanceof Error ? cause.message : "Could not quote that amount.");
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // buildQuote reads the latest pool, amount, and slippage from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, slippageBps, snapshot, connection, address, holding, spendDollars, solUsd]);

  async function sizeCompletingBuy() {
    if (!snapshot) return;
    setError("");
    const remaining = snapshot.threshold.sub(snapshot.raised);
    if (remaining.lte(new BN(0))) {
      setError("This curve has already reached the graduation threshold.");
      return;
    }
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const pool = await client.state.getPool(address);
      const config = pool ? await client.state.getPoolConfig(pool.poolState.config) : null;
      if (!pool || !config) throw new Error("Pool disappeared.");
      const currentPoint =
        config.activationType === ActivationType.Slot
          ? new BN(await connection.getSlot())
          : new BN(Math.floor(Date.now() / 1000));
      const quoted = client.pool.swapQuote2({
        virtualPool: pool,
        config,
        swapBaseForQuote: false,
        swapMode: SwapMode.PartialFill,
        amountIn: remaining,
        slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
      });
      const excluded = new BN(quoted.excludedFeeInputAmount.toString());
      const included = new BN(quoted.includedFeeInputAmount.toString());
      const gross = excluded.isZero()
        ? remaining
        : remaining.mul(included).add(excluded).sub(new BN(1)).div(excluded);
      setSpendDollars(false);
      setSide("buy");
      setAmount(rawToUi(gross, snapshot.quoteDecimals));
      setQuote(null);
      setStatus(`Amount set to the ${snapshot.quoteSymbol} that fills the curve at the current fee. The quote will show that amount.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not size the completing buy.");
    }
  }

  async function signSwap(preview: QuotePreview) {
    if (!publicKey || !signTransaction || !snapshot) {
      setError("Connect a wallet to swap.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = snapshot.isMigrated && snapshot.dammPool
        ? await graduatedSwapTransaction(connection, publicKey, snapshot, preview)
        : await client.pool.swap2({
        owner: publicKey,
        pool: new PublicKey(address),
        swapBaseForQuote: preview.side === "sell",
        swapMode: preview.side === "buy" ? SwapMode.PartialFill : SwapMode.ExactIn,
        amountIn: preview.amountIn,
        minimumAmountOut: preview.minimumAmountOut,
        referralTokenAccount: null,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const unit = preview.side === "buy" ? snapshot.quoteSymbol : snapshot.symbol;
      const outUnit = preview.side === "buy" ? snapshot.symbol : snapshot.quoteSymbol;
      const lines = [
        `Action: ${preview.side}`,
        `Network: ${cluster}`,
        `Pool: ${address}`,
        preview.typedDollars
          ? `You typed: ${preview.typedDollars}. That is ${preview.entered} SOL at ${formatDollars(solUsd)} per SOL. The pool spends SOL.`
          : `You typed: ${preview.entered} ${unit}`,
        `This trade uses: ${preview.used} ${unit}`,
        `Tokens at this price: ${preview.tokens} ${outUnit}`,
        `Average price: ${preview.averagePrice} ${snapshot.quoteSymbol} per ${snapshot.symbol}`,
        `Lowest the wallet will accept: ${preview.floor} ${outUnit}`,
        `Trading fee: ${preview.tradingFee} ${snapshot.quoteSymbol} (${preview.feeRate} of the amount used)`,
        `Protocol fee: ${preview.protocolFee} ${snapshot.quoteSymbol}`,
        `Returned to your wallet: ${preview.unspent} ${unit}`,
        `Slippage: ${bpsToPercent(preview.slippageBps)} (${preview.slippageBps} bps). This is not a fee.`,
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const signature = await sendPrepared(connection, prepared, signTransaction);
      setSignature(signature);
      setStatus("Swap confirmed.");
      setQuote(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Swap failed.");
    } finally {
      setBusy(false);
    }
  }

  async function claimCreatorFee() {
    if (!snapshot || !publicKey || !signTransaction) {
      setError("Connect the creator wallet to claim.");
      return;
    }
    if (publicKey.toBase58() !== snapshot.creator) {
      setError("This wallet did not create the token.");
      return;
    }
    const quoteFee = snapshot.creatorQuoteFee;
    const baseFee = snapshot.creatorBaseFee;
    if (quoteFee.isZero() && baseFee.isZero()) {
      setError("Nothing is waiting for the creator wallet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.creator.claimCreatorTradingFee({
        creator: publicKey,
        payer: publicKey,
        pool: new PublicKey(address),
        maxBaseAmount: baseFee,
        maxQuoteAmount: quoteFee,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const lines = [
        "Action: claim creator curve fee",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `${snapshot.quoteSymbol} sent to this wallet: ${formatMoney(quoteFee, snapshot.quoteDecimals)}`,
        baseFee.isZero()
          ? `${snapshot.symbol} sent to this wallet: 0`
          : `${snapshot.symbol} sent to this wallet: ${rawToUi(baseFee, snapshot.baseDecimals)}`,
        `Receiver: ${publicKey.toBase58()}`,
        "This withdraws the creator share of the curve fee. It does not take tokens out of the locked pool.",
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("Claimed the creator curve fee.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function claimPlatformFee() {
    if (!snapshot || !publicKey || !signTransaction) {
      setError("Connect the platform wallet to claim.");
      return;
    }
    if (publicKey.toBase58() !== snapshot.feeClaimer || publicKey.toBase58() !== PLATFORM_FEE_CLAIMER) {
      setError("The platform wallet has to sign this claim.");
      return;
    }
    const quoteFee = snapshot.partnerQuoteFee;
    const baseFee = snapshot.partnerBaseFee;
    if (quoteFee.isZero() && baseFee.isZero()) {
      setError("Nothing is waiting for the platform wallet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.partner.claimPartnerTradingFee({
        feeClaimer: publicKey,
        payer: publicKey,
        pool: new PublicKey(address),
        maxBaseAmount: baseFee,
        maxQuoteAmount: quoteFee,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const lines = [
        "Action: claim platform curve fee",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `${snapshot.quoteSymbol} sent to the platform wallet: ${formatMoney(quoteFee, snapshot.quoteDecimals)}`,
        baseFee.isZero()
          ? `${snapshot.symbol} sent to the platform wallet: 0`
          : `${snapshot.symbol} sent to the platform wallet: ${rawToUi(baseFee, snapshot.baseDecimals)}`,
        `Receiver: ${publicKey.toBase58()}`,
        "This withdraws the platform share of the curve fee. It does not take tokens out of the locked pool.",
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("Claimed the platform curve fee.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function withdrawLeftover() {
    if (!snapshot || !publicKey || !signTransaction) {
      setError("Connect the platform wallet to withdraw the leftover.");
      return;
    }
    if (publicKey.toBase58() !== PLATFORM_FEE_CLAIMER || publicKey.toBase58() !== snapshot.leftoverReceiver) {
      setError("The platform wallet has to sign this withdrawal.");
      return;
    }
    if (snapshot.leftoverWithdrawn || snapshot.leftoverBase.isZero()) {
      setError("No leftover is waiting.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.migration.withdrawLeftover({
        payer: publicKey,
        pool: new PublicKey(address),
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const amount = rawToUi(snapshot.leftoverBase, snapshot.baseDecimals);
      const lines = [
        "Action: withdraw leftover tokens",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `${snapshot.symbol} sent to the platform wallet: ${amount}`,
        `Receiver: ${snapshot.leftoverReceiver}`,
        "These tokens were left on the curve. They are not taken out of the locked pool.",
        `${snapshot.quoteSymbol} spent: 0`,
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("Withdrew the leftover tokens.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The leftover withdrawal failed.");
    } finally {
      setBusy(false);
    }
  }

  async function lockCreatorSupply() {
    if (!snapshot || !publicKey || !signTransaction) {
      setError("Connect a wallet to lock the creator supply.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.migration.createLocker({
        payer: publicKey,
        pool: new PublicKey(address),
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const reserved = snapshot.vestingCliffUnlock.add(snapshot.vestingPerPeriod.mul(new BN(snapshot.vestingPeriods)));
      const lines = [
        "Action: lock the creator supply",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `${snapshot.symbol} reserved for the creator: ${rawToUi(reserved, snapshot.baseDecimals)}`,
        `Creator: ${snapshot.creator}`,
        "These tokens come out of the curve. They do not come out of the trading pool.",
        `${snapshot.quoteSymbol} spent: 0`,
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("The creator supply is locked.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The creator supply could not be locked.");
    } finally {
      setBusy(false);
    }
  }

  async function claimCreatorSupply() {
    if (!snapshot || !creatorClaim || !publicKey || !signTransaction) {
      setError("Connect the creator wallet to claim this supply.");
      return;
    }
    if (publicKey.toBase58() !== snapshot.creator) {
      setError("The creator wallet has to sign this claim.");
      return;
    }
    if (creatorClaim.claimable.isZero()) {
      setError("Nothing is unlocked yet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const transaction = await new LockClient(connection, "confirmed").claimV2({
        escrow: new PublicKey(creatorClaim.escrow),
        recipient: publicKey,
        maxAmount: creatorClaim.claimable,
        payer: publicKey,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const lines = [
        "Action: claim creator supply",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `${snapshot.symbol} sent to the creator: ${rawToUi(creatorClaim.claimable, snapshot.baseDecimals)}`,
        `Receiver: ${publicKey.toBase58()}`,
        "This is the reserved supply that the schedule has unlocked. It does not take tokens out of the trading pool.",
        `${snapshot.quoteSymbol} spent: 0`,
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("Claimed the unlocked creator supply.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The creator supply claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function migrate() {
    if (!snapshot || !publicKey || !signTransaction) {
      setError("Connect a wallet to open the trading pool.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const feeConfig = snapshot.dammConfig;
      if (!feeConfig) {
        setError("This curve has no Meteora pool config, so this page cannot open the trading pool.");
        return;
      }
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const result = await client.migration.migrateToDammV2({
        payer: publicKey,
        pool: new PublicKey(address),
        dammConfig: new PublicKey(feeConfig),
      });
      const prepared = await prepareTransaction(connection, publicKey, result.transaction, [
        result.firstPositionNftKeypair,
        result.secondPositionNftKeypair,
      ]);
      const lines = [
        "Open the Meteora trading pool",
        `Network: ${cluster === "devnet" ? "practice" : "real"}`,
        `Curve: ${address}`,
        `Pool fee after it opens: ${bpsToPercent(snapshot.migrationFeeBps)}`,
        `${snapshot.quoteSymbol} spent: 0`,
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
        `The tokens and ${snapshot.quoteSymbol} that move into the pool stay locked. This signature opens the pool. It does not send them to a wallet.`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("The trading pool is open.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Migration failed.");
    } finally {
      setBusy(false);
    }
  }

  const wallet = publicKey?.toBase58() ?? "";
  const authority = !!snapshot && (wallet === snapshot.creator || isAdminWallet(wallet));
  const creatorWallet = !!snapshot && wallet === snapshot.creator;
  const reserved = snapshot
    ? snapshot.vestingCliffUnlock.add(snapshot.vestingPerPeriod.mul(new BN(snapshot.vestingPeriods)))
    : new BN(0);
  const shares = snapshot ? feeShares(snapshot.creatorTradingFeePercentage) : null;
  const platformSigner = !!snapshot && wallet === snapshot.feeClaimer && wallet === PLATFORM_FEE_CLAIMER;
  const schedule =
    snapshot && !reserved.isZero()
      ? publicSchedule(
          snapshot.vestingCliffUnlock,
          snapshot.vestingPerPeriod,
          snapshot.vestingPeriods,
          snapshot.vestingFrequency,
          snapshot.vestingCliffSeconds,
          Number(snapshot.supply),
        )
      : [];
  const livePrice = market?.spot ?? snapshot?.price ?? "";
  const cap = snapshot ? marketCap(livePrice, snapshot.supply) : "";
  const nextUnlock =
    creatorClaim && snapshot
      ? nextUnlockSeconds(
          Math.floor(Date.now() / 1000),
          creatorClaim.cliffTime,
          creatorClaim.frequency,
          creatorClaim.periods,
          creatorClaim.claimed,
          creatorClaim.total,
        )
      : null;

  return (
    <div className="board">
      <p className="eyebrow">
        <Link href="/">PAR</Link>
        {authority ? (creatorWallet ? " · creator" : " · platform") : " · token"}
      </p>
      {!snapshot && !error ? <p>Loading the curve…</p> : null}
      {snapshot ? (
        <>
          <header className="board-title">
            {snapshot.image ? <img className="token-preview" src={snapshot.image} alt="" /> : null}
            <h1>
              {snapshot.name} <span>{snapshot.symbol}</span>
            </h1>
            {snapshot.description ? <p>{snapshot.description}</p> : null}
            <p>
              Supply {Number(snapshot.supply).toLocaleString("en-US")}. Opens at{" "}
              {snapshot.quoteSymbol === "SOL" ? `${snapshot.startPrice} SOL` : `${snapshot.startPrice} ${snapshot.quoteSymbol}`}.
              {snapshot.shelfPrice
                ? ` Shelf holds through ${snapshot.quoteSymbol === "SOL" ? `${snapshot.shelfPrice} SOL` : `${snapshot.shelfPrice} ${snapshot.quoteSymbol}`}.`
                : ""}{" "}
              Pool price {snapshot.quoteSymbol === "SOL" ? `${snapshot.endPrice} SOL` : `${snapshot.endPrice} ${snapshot.quoteSymbol}`}. Full
              at {formatMoney(snapshot.threshold, snapshot.quoteDecimals)} {snapshot.quoteSymbol}.
              {cap ? ` Market cap ${cap} ${snapshot.quoteSymbol}.` : ""}
            </p>
            <p className="note">
              {snapshot.isMigrated
                ? "The trading pool is open. Liquidity is locked."
                : snapshot.canMigrate || snapshot.needsLocker
                  ? "The curve is full. The trading pool is not open yet."
                  : "The curve is still filling. Buys and sells on this page move the price."}{" "}
              {cluster === "devnet" ? "Practice network." : "Real network."}{" "}
              <a href={explorerAccount(snapshot.baseMint, cluster)}>Token</a>
              {" · "}
              <a href={explorerAccount(snapshot.address, cluster)}>Curve</a>
              {snapshot.dammPool ? (
                <>
                  {" · "}
                  <a href={explorerAccount(snapshot.dammPool, cluster)}>Trading pool</a>
                </>
              ) : null}
            </p>
            <ListingActions
              name={snapshot.name}
              mint={snapshot.baseMint}
              fullAt={`${formatMoney(snapshot.threshold, snapshot.quoteDecimals)} ${snapshot.quoteSymbol}`}
              viewHref={`/pool/${snapshot.address}`}
              meteoraHref={snapshot.dammPool ? meteoraPoolUrl(snapshot.dammPool, cluster) : undefined}
              sharePath={`/pool/${snapshot.address}`}
              quoteMint={snapshot.quoteMint}
              opensAt={snapshot.startPrice}
              endsAt={snapshot.endPrice}
              cluster={cluster}
            />
          </header>
          <RecordPanel uri={snapshot.uri} mint={snapshot.baseMint} pool={snapshot.address} cluster={cluster} />
          <section className="quotes" aria-label={snapshot.isMigrated ? "Trading pool balances" : "Curve progress"}>
            <article>
              <h2>Price</h2>
              <p className="figure">
                {market?.spot ?? snapshot.price} <span>{snapshot.quoteSymbol}</span>
              </p>
              <p className="note">
                {market
                  ? `Trading pool. The curve finished at ${snapshot.endPrice} ${snapshot.quoteSymbol}.`
                  : `Curve price. Opens at ${snapshot.startPrice}. Pool price ${snapshot.endPrice}.`}
                {snapshot.quoteSymbol === "SOL" && solUsd > 0
                  ? ` About ${formatDollars(Number(livePrice) * solUsd)} per token at ${formatDollars(solUsd)} per SOL.`
                  : ""}
              </p>
            </article>
            {cap ? (
              <article>
                <h2>Market cap</h2>
                <p className="figure">
                  {cap} <span>{snapshot.quoteSymbol}</span>
                </p>
                <p className="note">Price times the {Number(snapshot.supply).toLocaleString("en-US")} supply.</p>
              </article>
            ) : null}
            {snapshot.isMigrated && market ? (
              <>
                <article>
                  <h2>{snapshot.quoteSymbol} in the pool</h2>
                  <p className="figure">
                    {formatMoney(market.quote, snapshot.quoteDecimals)} <span>{snapshot.quoteSymbol}</span>
                  </p>
                  <p className="note">
                    In the trading pool now.
                    {snapshot.quoteSymbol === "SOL" && solUsd > 0
                      ? ` About ${formatDollars(Number(rawToUi(market.quote, snapshot.quoteDecimals)) * solUsd)} at ${formatDollars(solUsd)} per SOL.${cluster === "devnet" ? " Practice SOL is not worth that." : ""}`
                      : ""}
                  </p>
                </article>
                <article>
                  <h2>{snapshot.symbol} in the pool</h2>
                  <p className="figure">
                    {groupUi(rawToUi(market.base, snapshot.baseDecimals))} <span>{snapshot.symbol}</span>
                  </p>
                  <p className="note">In the trading pool now.</p>
                </article>
              </>
            ) : (
              <>
                <article>
                  <h2>{snapshot.quoteSymbol} raised</h2>
                  <p className="figure">
                    {formatMoney(snapshot.raised, snapshot.quoteDecimals)} <span>/ {formatMoney(snapshot.threshold, snapshot.quoteDecimals)}</span>
                  </p>
                  <p className="note">
                    In the curve, of the amount that fills it.
                    {snapshot.quoteSymbol === "SOL" && solUsd > 0
                      ? ` About ${formatDollars(Number(rawToUi(snapshot.raised, snapshot.quoteDecimals)) * solUsd)} raised, and about ${formatDollars(Number(rawToUi(snapshot.threshold, snapshot.quoteDecimals)) * solUsd)} when full, at ${formatDollars(solUsd)} per SOL.`
                      : ""}
                  </p>
                </article>
                <article>
                  <h2>Filled</h2>
                  <p className="figure">
                    {snapshot.percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                    <span>%</span>
                  </p>
                  <div className="meter" aria-hidden="true">
                    <span style={{ width: `${snapshot.percent}%` }} />
                  </div>
                  <p className="note">
                    {snapshot.percent >= 40 && snapshot.percent < 60
                      ? "About halfway to graduation."
                      : "How full the curve is. At 100% the trading pool can open."}
                  </p>
                </article>
              </>
            )}
          </section>

          <dl className="quote-slip" aria-label="Token record">
            <div>
              <dt>Mint</dt>
              <dd>
                <a href={explorerAccount(snapshot.baseMint, cluster)}>{shortAddress(snapshot.baseMint)}</a>
              </dd>
            </div>
            <div>
              <dt>Curve</dt>
              <dd>
                <a href={explorerAccount(snapshot.address, cluster)}>{shortAddress(snapshot.address)}</a>
              </dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>
                <a href={explorerAccount(snapshot.config, cluster)}>{shortAddress(snapshot.config)}</a>
              </dd>
            </div>
            <div>
              <dt>Trading pool</dt>
              <dd>
                {snapshot.dammPool ? (
                  <a href={meteoraPoolUrl(snapshot.dammPool, cluster)} target="_blank" rel="noreferrer">
                    {shortAddress(snapshot.dammPool)}
                  </a>
                ) : (
                  "Not open"
                )}
              </dd>
            </div>
            <div>
              <dt>Quote</dt>
              <dd>
                {snapshot.quoteSymbol}{" "}
                <a href={explorerAccount(snapshot.quoteMint, cluster)}>{shortAddress(snapshot.quoteMint)}</a>
              </dd>
            </div>
            <div>
              <dt>Decimals</dt>
              <dd>
                {snapshot.baseDecimals} token, {snapshot.quoteDecimals} quote
              </dd>
            </div>
            <div>
              <dt>Supply</dt>
              <dd>{Number(snapshot.supply).toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Creator supply</dt>
              <dd>
                {reserved.isZero()
                  ? "None"
                  : `${groupUi(rawToUi(reserved, snapshot.baseDecimals))} ${snapshot.symbol}`}
              </dd>
            </div>
            {shares ? (
              <div>
                <dt>Trading fee split</dt>
                <dd>
                  Meteora {shareLabel(shares.meteora)}, creator {shareLabel(shares.creator)}, platform {shareLabel(shares.platform)}
                </dd>
              </div>
            ) : null}
            {snapshot.isMigrated ? null : (
              <div>
                <dt>Tokens on the curve</dt>
                <dd>
                  {groupUi(rawToUi(snapshot.baseReserve, snapshot.baseDecimals))} {snapshot.symbol}
                </dd>
              </div>
            )}
            <div>
              <dt>Opening price</dt>
              <dd>
                {snapshot.startPrice} {snapshot.quoteSymbol}
              </dd>
            </div>
            {snapshot.shelfPrice ? (
              <div>
                <dt>Shelf through</dt>
                <dd>
                  {snapshot.shelfPrice} {snapshot.quoteSymbol}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Pool price</dt>
              <dd>
                {snapshot.endPrice} {snapshot.quoteSymbol}
              </dd>
            </div>
            <div>
              <dt>Curve fills at</dt>
              <dd>
                {formatMoney(snapshot.threshold, snapshot.quoteDecimals)} {snapshot.quoteSymbol}
              </dd>
            </div>
            <div>
              <dt>Curve fee</dt>
              <dd>
                {snapshot.feeDecaySeconds > 0
                  ? `${bpsToPercent(snapshot.openingFeeBps)} to ${bpsToPercent(snapshot.endingFeeBps)} over ${feeDecayLabel(snapshot.feeDecaySeconds)}`
                  : bpsToPercent(snapshot.openingFeeBps)}
              </dd>
            </div>
            <div>
              <dt>Pool fee</dt>
              <dd>
                {snapshot.migrationFeeBps > 0 ? bpsToPercent(snapshot.migrationFeeBps) : "Saved on the template"}
                {snapshot.compoundingFeeBps > 0
                  ? `. Compounding puts ${snapshot.compoundingFeeBps / 100}% of the liquidity fee back into the pool. Meteora's 20% still comes out first.`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Liquidity</dt>
              <dd>{snapshot.isMigrated ? "Locked in the trading pool" : "Still on the curve"}</dd>
            </div>
            <div>
              <dt>Creator</dt>
              <dd>
                <a href={explorerAccount(snapshot.creator, cluster)}>{shortAddress(snapshot.creator)}</a>
              </dd>
            </div>
          </dl>

          {schedule.length > 0 ? (
            <section className="migrate" aria-label="Creator allocation">
              <h2>Creator allocation</h2>
              {schedule.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {creatorClaim ? (
                <p>
                  Claimed {groupUi(rawToUi(creatorClaim.claimed, snapshot.baseDecimals))} {snapshot.symbol}. Unlocked now{" "}
                  {groupUi(rawToUi(creatorClaim.claimable, snapshot.baseDecimals))} {snapshot.symbol}.
                  {nextUnlock
                    ? ` Next unlock ${new Date(nextUnlock * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}.`
                    : " The schedule is fully unlocked."}
                </p>
              ) : snapshot.migrationProgress < 1 ? (
                <p>The curve is still filling. This allocation stays reserved until the supply is locked.</p>
              ) : (
                <p>The curve is full. The supply is not locked yet, so the clock has not started.</p>
              )}
            </section>
          ) : null}

          <section className="ledger" aria-label="Holders">
            <h2>Holders</h2>
            {holders.length === 0 ? <p className="note">No wallet holds this token outside the pool.</p> : null}
            <ol>
              {holders.map((row) => {
                const supply = Number(snapshot.supply);
                const share = supply > 0 ? (Number(row.amount) / supply) * 100 : 0;
                return (
                  <li key={row.owner}>
                    <a href={explorerAccount(row.owner, cluster)}>{shortAddress(row.owner)}</a>
                    <span>
                      {groupUi(row.amount)} {snapshot.symbol}
                    </span>
                    <span>{share.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</span>
                  </li>
                );
              })}
            </ol>
            {holdersCapped ? <p className="note">These are the 20 largest holdings. Smaller wallets are not in this list.</p> : null}
          </section>

          <section className="ledger" aria-label="Buys and sells">
            <h2>Buys and sells</h2>
            {trades.length === 0 ? <p className="note">No buys or sells yet.</p> : null}
            <ol>
              {trades.map((trade) => (
                <li key={trade.signature}>
                  <span className={trade.side}>{trade.side === "buy" ? "Buy" : "Sell"}</span>
                  <span>{tradeWhen(trade.time)}</span>
                  {trade.wallet ? <a href={explorerAccount(trade.wallet, cluster)}>{shortAddress(trade.wallet)}</a> : <span />}
                  <span>
                    {groupUi(trade.base)} {snapshot.symbol}
                  </span>
                  <span>
                    {groupUi(trade.quote)} {snapshot.quoteSymbol}
                  </span>
                  <a href={explorerTx(trade.signature, cluster)}>Transaction</a>
                </li>
              ))}
            </ol>
          </section>

          {snapshot.trading || (snapshot.isMigrated && snapshot.dammPool) ? (
            <form
              className="trade"
              onSubmit={(event) => {
                event.preventDefault();
                if (quote && quote.side === side && quote.slippageBps === slippageBps) void signSwap(quote);
              }}
            >
              <div className="segmented" role="group" aria-label="Side">
                <button
                  type="button"
                  aria-pressed={side === "buy"}
                  onClick={() => {
                    setSide("buy");
                    setAmount("");
                    setQuote(null);
                  }}
                >
                  Buy
                </button>
                <button
                  type="button"
                  aria-pressed={side === "sell"}
                  onClick={() => {
                    setSide("sell");
                    setAmount("");
                    setQuote(null);
                  }}
                >
                  Sell
                </button>
              </div>
              {side === "buy" && snapshot.quoteSymbol === "SOL" ? (
                <div className="choices" role="group" aria-label="Buy amount unit">
                  <button
                    type="button"
                    aria-pressed={!spendDollars}
                    onClick={() => {
                      setSpendDollars(false);
                      setAmount("");
                      setQuote(null);
                    }}
                  >
                    SOL
                  </button>
                  <button
                    type="button"
                    aria-pressed={spendDollars}
                    onClick={() => {
                      setSpendDollars(true);
                      setAmount("");
                      setQuote(null);
                    }}
                  >
                    Dollars
                  </button>
                </div>
              ) : null}
              <label>
                {side === "sell"
                  ? `${snapshot.symbol} you want to sell`
                  : snapshot.quoteSymbol === "SOL" && spendDollars
                    ? "Dollars you want to spend"
                    : `${snapshot.quoteSymbol} you want to spend`}
                <span className="money">
                  {side === "buy" && (snapshot.quoteSymbol !== "SOL" || spendDollars) ? <span>$</span> : null}
                  <input
                    inputMode="decimal"
                    value={amount}
                    placeholder="0.00"
                    onChange={(event) => {
                      const next = event.target.value.replace(/[^\d.]/g, "");
                      const parts = next.split(".");
                      setAmount(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : next);
                      setQuote(null);
                    }}
                    onBlur={() => {
                      if (side === "buy" && snapshot.quoteSymbol === "SOL" && !spendDollars) return;
                      if (/^\d+$/.test(amount)) setAmount(`${amount}.00`);
                      else if (/^\d+\.\d$/.test(amount)) setAmount(`${amount}0`);
                    }}
                    required
                  />
                  <span>
                    {side === "sell" ? snapshot.symbol : snapshot.quoteSymbol === "SOL" && spendDollars ? "USD" : snapshot.quoteSymbol}
                  </span>
                </span>
              </label>
              {side === "buy" ? (
                <div className="choices" role="group" aria-label="Amount shortcuts">
                  {(snapshot.quoteSymbol === "SOL" && spendDollars
                    ? ["1", "5", "10"]
                    : snapshot.quoteSymbol === "SOL"
                      ? ["0.01", "0.1", "1"]
                      : ["1.00", "5.00", "10.00"]
                  ).map((choice) => (
                    <button key={choice} type="button" onClick={() => { setAmount(choice); setQuote(null); }}>
                      {snapshot.quoteSymbol === "SOL" && spendDollars
                        ? `$${choice}`
                        : snapshot.quoteSymbol === "SOL"
                          ? `${choice} SOL`
                          : `$${choice}`}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <p className="note">
                    {publicKey
                      ? holding
                        ? `Available to sell: ${rawToUi(holding, snapshot.baseDecimals)} ${snapshot.symbol}`
                        : "Reading the token balance in this wallet…"
                      : "Connect a wallet to see what you can sell."}
                  </p>
                  <div className="choices" role="group" aria-label="Sell the wallet balance">
                    <button
                      type="button"
                      disabled={!holding || holding.isZero()}
                      onClick={() => {
                        if (!holding) return;
                        setAmount(rawToUi(holding, snapshot.baseDecimals));
                        setQuote(null);
                      }}
                    >
                      Max
                    </button>
                  </div>
                </>
              )}
              <p className="note">
                {side === "sell"
                  ? `Sells ${snapshot.symbol} from this wallet. The quote is the ${snapshot.quoteSymbol} that comes back.`
                  : snapshot.quoteSymbol === "SOL" && spendDollars
                    ? `Dollars become SOL at ${solUsd > 0 ? formatDollars(solUsd) : "the live price"} per SOL. The swap spends SOL.${cluster === "devnet" ? " Practice SOL is not worth that price." : ""}`
                    : `The fee is taken out of the ${snapshot.quoteSymbol} this trade uses.`}
              </p>
              <fieldset className="slippage">
                <legend>Slippage</legend>
                <div className="choices" role="group" aria-label="Slippage">
                  {SLIPPAGE_CHOICES.map((choice) => (
                    <button
                      key={choice.bps}
                      type="button"
                      aria-pressed={slippageBps === choice.bps}
                      onClick={() => setSlippageBps(choice.bps)}
                    >
                      {choice.label}
                      <small>{choice.detail}</small>
                    </button>
                  ))}
                </div>
                <p className="note">
                  The wallet refuses if you receive less than this quote minus {bpsToPercent(slippageBps)}. Slippage is not a fee.
                </p>
              </fieldset>
              <div className="actions">
                {side === "buy" && snapshot.trading ? (
                  <button type="button" onClick={() => void sizeCompletingBuy()}>
                    Use the amount that fills the curve
                  </button>
                ) : null}
                <button
                  className="solid"
                  type="submit"
                  disabled={!quote || quote.side !== side || quote.slippageBps !== slippageBps || busy}
                >
                  {busy ? "Signing…" : quote ? `Sign ${side}` : "Waiting for the quote"}
                </button>
              </div>
              {amount.trim() && !quote ? <p className="note">Reading the quote for the amount you typed…</p> : null}
              {quote && quote.side === side ? (
                <dl className="quote-slip">
                  <div>
                    <dt>You typed</dt>
                    <dd>
                      {quote.typedDollars
                        ? `${quote.typedDollars}, which is ${quote.entered} SOL`
                        : `${side === "buy" && snapshot.quoteSymbol !== "SOL" ? `$${quote.entered}` : quote.entered} ${side === "buy" ? snapshot.quoteSymbol : snapshot.symbol}`}
                    </dd>
                  </div>
                  <div>
                    <dt>This trade uses</dt>
                    <dd>
                      {quote.used} {side === "buy" ? snapshot.quoteSymbol : snapshot.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Trading fee</dt>
                    <dd>
                      {quote.tradingFee} {snapshot.quoteSymbol} ({quote.feeRate} of the amount used)
                    </dd>
                  </div>
                  <div>
                    <dt>Protocol fee</dt>
                    <dd>{quote.protocolFee} {snapshot.quoteSymbol}</dd>
                  </div>
                  <div>
                    <dt>{side === "buy" ? "Tokens at this price" : `${snapshot.quoteSymbol} you receive`}</dt>
                    <dd>
                      {side === "sell" && snapshot.quoteSymbol !== "SOL" ? "$" : ""}
                      {quote.tokens} {side === "buy" ? snapshot.symbol : snapshot.quoteSymbol}
                    </dd>
                  </div>
                  <div>
                    <dt>{side === "buy" ? "Average price of this buy" : "Average price of this sale"}</dt>
                    <dd>
                      {snapshot.quoteSymbol === "SOL" ? `${quote.averagePrice} SOL` : `$${quote.averagePrice} USDC`} per {snapshot.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Lowest the wallet will accept</dt>
                    <dd>
                      {quote.floor} {side === "buy" ? snapshot.symbol : snapshot.quoteSymbol} at {bpsToPercent(quote.slippageBps)}{" "}
                      slippage
                    </dd>
                  </div>
                  <div>
                    <dt>Comes back to your wallet</dt>
                    <dd>
                      {quote.unspent} {side === "buy" ? snapshot.quoteSymbol : snapshot.symbol}
                      {quote.unspent !== "0.00"
                        ? ". The curve cannot take the whole amount you typed."
                        : ". The whole amount is used."}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </form>
          ) : null}

          {authority && shares ? (
            <section className="migrate" aria-label="Creator and platform">
              <h2>{creatorWallet ? "Creator" : "Platform"}</h2>
              <p>
                {snapshot.shelfPrice
                  ? `Par is ${snapshot.startPrice} ${snapshot.quoteSymbol}. The shelf holds through ${snapshot.shelfPrice}. After that, the price walks to the pool at ${snapshot.endPrice}.`
                  : `Par is off. The price climbs from ${snapshot.startPrice} to the pool at ${snapshot.endPrice} ${snapshot.quoteSymbol}.`}{" "}
                Those prices, the supply, and the fee split were written into the template and cannot be edited. Market cap is the live price times the whole supply. A later buy can move the pool price up, and a later sell can move it down.
              </p>
              <dl className="quote-slip">
                <div>
                  <dt>Creator wallet</dt>
                  <dd>
                    <a href={explorerAccount(snapshot.creator, cluster)}>{shortAddress(snapshot.creator)}</a>
                  </dd>
                </div>
                <div>
                  <dt>Platform fee wallet</dt>
                  <dd>
                    <a href={explorerAccount(snapshot.feeClaimer, cluster)}>{shortAddress(snapshot.feeClaimer)}</a>
                  </dd>
                </div>
                <div>
                  <dt>Leftover receiver</dt>
                  <dd>
                    <a href={explorerAccount(snapshot.leftoverReceiver, cluster)}>{shortAddress(snapshot.leftoverReceiver)}</a>
                  </dd>
                </div>
                <div>
                  <dt>Base vault</dt>
                  <dd>
                    <a href={explorerAccount(snapshot.baseVault, cluster)}>{shortAddress(snapshot.baseVault)}</a>
                  </dd>
                </div>
                <div>
                  <dt>Quote vault</dt>
                  <dd>
                    <a href={explorerAccount(snapshot.quoteVault, cluster)}>{shortAddress(snapshot.quoteVault)}</a>
                  </dd>
                </div>
                <div>
                  <dt>Curve progress</dt>
                  <dd>
                    {snapshot.isMigrated
                      ? "Trading pool open"
                      : snapshot.canMigrate
                        ? "Full, waiting for the trading pool"
                        : snapshot.needsLocker
                          ? "Full, creator supply not locked"
                          : `Filling, ${snapshot.percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`}
                  </dd>
                </div>
              </dl>
              <h2>Curve fee</h2>
              <p>
                Of each curve trading fee, Meteora keeps {shareLabel(shares.meteora)}. That share is fixed in the program. The creator keeps {shareLabel(shares.creator)} of the gross fee. The platform keeps {shareLabel(shares.platform)}. On this token the creator's on-chain setting is {snapshot.creatorTradingFeePercentage}% of the fee left after Meteora, which is the {shareLabel(shares.creator)} above. Fees wait until they are claimed. They are not sent by themselves. These buttons withdraw the curve fee from trades before the trading pool opens. They do not withdraw the fee that later swaps pay on the locked position.
              </p>
              <dl className="quote-slip">
                <div>
                  <dt>Creator curve fee waiting</dt>
                  <dd>
                    {formatMoney(snapshot.creatorQuoteFee, snapshot.quoteDecimals)} {snapshot.quoteSymbol}
                    {snapshot.creatorBaseFee.isZero()
                      ? ""
                      : `, plus ${rawToUi(snapshot.creatorBaseFee, snapshot.baseDecimals)} ${snapshot.symbol}`}
                  </dd>
                </div>
                <div>
                  <dt>Platform curve fee waiting</dt>
                  <dd>
                    {formatMoney(snapshot.partnerQuoteFee, snapshot.quoteDecimals)} {snapshot.quoteSymbol}
                    {snapshot.partnerBaseFee.isZero()
                      ? ""
                      : `, plus ${rawToUi(snapshot.partnerBaseFee, snapshot.baseDecimals)} ${snapshot.symbol}`}
                  </dd>
                </div>
                <div>
                  <dt>Meteora curve fee waiting</dt>
                  <dd>
                    {formatMoney(snapshot.protocolQuoteFee, snapshot.quoteDecimals)} {snapshot.quoteSymbol}
                    {snapshot.protocolBaseFee.isZero()
                      ? ""
                      : `, plus ${rawToUi(snapshot.protocolBaseFee, snapshot.baseDecimals)} ${snapshot.symbol}`}
                    . Their program wallet claims this. This page cannot.
                  </dd>
                </div>
              </dl>
              <div className="actions">
                {creatorWallet ? (
                  <button
                    className="solid"
                    type="button"
                    disabled={busy || (snapshot.creatorQuoteFee.isZero() && snapshot.creatorBaseFee.isZero())}
                    onClick={() => void claimCreatorFee()}
                  >
                    Claim creator fee
                  </button>
                ) : (
                  <p className="note">The creator wallet {shortAddress(snapshot.creator)} claims the creator share.</p>
                )}
                {platformSigner ? (
                  <button
                    className="solid"
                    type="button"
                    disabled={busy || (snapshot.partnerQuoteFee.isZero() && snapshot.partnerBaseFee.isZero())}
                    onClick={() => void claimPlatformFee()}
                  >
                    Claim platform fee
                  </button>
                ) : (
                  <p className="note">
                    The platform wallet {shortAddress(snapshot.feeClaimer)} claims the platform share on this page. Admin lists every token for the same claim.
                  </p>
                )}
              </div>
              <h2>After the pool opens</h2>
              <p>
                Each swap pays {snapshot.migrationFeeBps > 0 ? bpsToPercent(snapshot.migrationFeeBps) : "the pool fee saved on the template"}. Meteora keeps {shareLabel(shares.meteora)} of that fee before anyone else is paid. The other {100 - METEORA_TRADING_FEE_PERCENT}% is the fee on the locked liquidity: platform {snapshot.partnerLockedLiquidity}%, creator {snapshot.creatorLockedLiquidity}%. That split is {shareLabel(shares.meteora)} Meteora, {shareLabel(Math.round((snapshot.partnerLockedLiquidity * (100 - METEORA_TRADING_FEE_PERCENT)) / 100))} platform, and {shareLabel(Math.round((snapshot.creatorLockedLiquidity * (100 - METEORA_TRADING_FEE_PERCENT)) / 100))} creator, out of the whole fee.{" "}
                {snapshot.compoundingFeeBps > 0
                  ? `Compounding puts ${snapshot.compoundingFeeBps / 100}% of the liquidity fee back into the pool. Meteora's ${shareLabel(shares.meteora)} still comes out first.`
                  : ""}{" "}
                {snapshot.partnerVestingLiquidity === 0 && snapshot.creatorVestingLiquidity === 0
                  ? "No liquidity is on a vesting schedule. The locked tokens and the locked quote stay in the pool. The position cannot be withdrawn."
                  : `Liquidity vesting is on: platform ${snapshot.partnerVestingLiquidity}%, creator ${snapshot.creatorVestingLiquidity}%. The permanent locked share still cannot be withdrawn.`}
              </p>
              <h2>Creator supply</h2>
              {reserved.isZero() ? (
                <p>No creator supply was reserved. Buyers and the pool use the whole supply.</p>
              ) : (
                <>
                  <p>
                    {storyFromRaw(
                      snapshot.vestingCliffUnlock,
                      snapshot.vestingPerPeriod,
                      snapshot.vestingPeriods,
                      snapshot.vestingFrequency,
                      snapshot.vestingCliffSeconds,
                      Number(snapshot.supply),
                    )}
                  </p>
                  {snapshot.needsLocker ? (
                    <button className="solid" type="button" disabled={busy} onClick={() => void lockCreatorSupply()}>
                      Lock the creator supply
                    </button>
                  ) : null}
                  {snapshot.migrationProgress >= 2 && creatorClaim ? (
                    creatorWallet ? (
                      <button
                        className="solid"
                        type="button"
                        disabled={busy || creatorClaim.claimable.isZero()}
                        onClick={() => void claimCreatorSupply()}
                      >
                        Claim {rawToUi(creatorClaim.claimable, snapshot.baseDecimals)} {snapshot.symbol}
                      </button>
                    ) : (
                      <p className="note">The creator wallet signs the supply claim. The unlocked amount is on the allocation above.</p>
                    )
                  ) : snapshot.migrationProgress < 1 ? (
                    <p className="note">The curve is still filling. The lock button appears after it fills, and the clock starts at that signature.</p>
                  ) : null}
                </>
              )}
              <h2>Left on the curve</h2>
              <dl className="quote-slip">
                <div>
                  <dt>Meteora migration fee</dt>
                  <dd>
                    {snapshot.protocolMigrationBase.isZero() && snapshot.protocolMigrationQuote.isZero()
                      ? "None sitting on the curve."
                      : `${groupUi(rawToUi(snapshot.protocolMigrationBase, snapshot.baseDecimals))} ${snapshot.symbol}${
                          snapshot.protocolMigrationQuote.isZero()
                            ? ""
                            : ` and ${formatMoney(snapshot.protocolMigrationQuote, snapshot.quoteDecimals)} ${snapshot.quoteSymbol}`
                        }. This is Meteora's 0.2% migration fee. Their program wallet claims it. The platform wallet and the creator wallet cannot withdraw it.`}
                  </dd>
                </div>
                <div>
                  <dt>Leftover tokens</dt>
                  <dd>
                    {snapshot.leftoverWithdrawn
                      ? "Already withdrawn to the leftover receiver."
                      : snapshot.leftoverBase.isZero()
                        ? "None waiting. Leftover is the dust the curve could not sell or put in the pool."
                        : `${groupUi(rawToUi(snapshot.leftoverBase, snapshot.baseDecimals))} ${snapshot.symbol} go to ${shortAddress(snapshot.leftoverReceiver)}. This is not the migration fee.`}
                  </dd>
                </div>
              </dl>
              {platformSigner && !snapshot.leftoverWithdrawn && !snapshot.leftoverBase.isZero() ? (
                <button className="solid" type="button" disabled={busy} onClick={() => void withdrawLeftover()}>
                  Withdraw leftover
                </button>
              ) : null}
              {snapshot.canMigrate ? (
                <>
                  <h2>Open the trading pool</h2>
                  <p>
                    Trading on the curve has stopped. Sign once to open the Meteora trading pool. On the real network,{" "}
                    {snapshot.quoteSymbol === "SOL"
                      ? "Meteora opens a SOL curve by itself once it has collected 10 SOL."
                      : snapshot.quoteSymbol === "USDC"
                        ? "Meteora opens a USDC curve by itself once it has collected at least $750."
                        : "Meteora opens a badged stock quote by itself once the quote collected is worth at least $750. A plain token is opened by itself only if it is on their keeper list, or Jupiter has verified it with an organic score above 50 and the raise is worth more than $750."}{" "}
                    On the practice network, this signature is required.
                  </p>
                  <button className="solid" type="button" disabled={busy} onClick={() => void migrate()}>
                    Open the trading pool
                  </button>
                </>
              ) : snapshot.isMigrated ? (
                <p className="note">The trading pool is already open. Liquidity is locked.</p>
              ) : null}
              <p className="note">
                Slippage is in basis points. 100 bps is 1%, 200 is 2%, 300 is 3%, 400 is 4%. It is the furthest the amount received may fall below the quote before the wallet refuses. It does not change the price. On a SOL pool, the Dollars button turns a dollar amount into SOL at the live SOL price and then spends that SOL.
                {cluster === "devnet" && snapshot.quoteSymbol === "SOL" ? " Practice SOL is not worth that dollar price." : ""}
              </p>
            </section>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="status">{status}</p> : null}
      {signature ? (
        <p className="note">
          <a href={explorerTx(signature, cluster)}>View signature</a>
        </p>
      ) : null}
      <button type="button" className="text" onClick={() => void refresh()}>
        Refresh
      </button>
      {pending ? (
        <MainnetGate
          title="Sign this mainnet transaction?"
          lines={pending.lines}
          confirmLabel="Open wallet"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const next = pending;
            setPending(null);
            if (!signTransaction) return;
            setBusy(true);
            sendPrepared(connection, next.prepared, signTransaction)
              .then(async (confirmed) => {
                setSignature(confirmed);
                setStatus("Confirmed.");
                await refresh();
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Transaction failed.");
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
