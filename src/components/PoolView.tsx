"use client";

import {
  ActivationType,
  DynamicBondingCurveClient,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { ListingActions } from "@/components/ListingActions";
import { useCluster } from "@/lib/cluster";
import { DAMM_V2_FEE_25_BPS, ENDS_AT, OPENS_AT, PRESETS, explorerAccount, explorerTx } from "@/lib/constants";
import { formatLamports, formatUsdc, rawToUi, shortAddress, uiToRaw } from "@/lib/format";
import { loadPool, type PoolSnapshot } from "@/lib/load-pool";
import { prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";

type Side = "buy" | "sell";

type QuotePreview = {
  side: Side;
  pay: string;
  receive: string;
  fee: string;
  unspent: string;
  minimumAmountOut: BN;
  amountIn: BN;
};

type PendingSwap = {
  prepared: PreparedTransaction;
  lines: string[];
};

export function PoolView({ address }: { address: string }) {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [snapshot, setSnapshot] = useState<PoolSnapshot | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSwap | null>(null);
  const [signature, setSignature] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      setSnapshot(await loadPool(connection, address));
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Could not load this pool.");
    }
  }, [address, connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function buildQuote(nextSide: Side, uiAmount: string): Promise<QuotePreview> {
    if (!snapshot) throw new Error("Pool is still loading.");
    const amountIn = uiToRaw(uiAmount, nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals);
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
    const decimalsOut = nextSide === "buy" ? snapshot.baseDecimals : snapshot.quoteDecimals;
    const fee = new BN(quoted.tradingFee.toString()).add(new BN(quoted.protocolFee.toString()));
    return {
      side: nextSide,
      pay: rawToUi(new BN(quoted.includedFeeInputAmount.toString()), nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals),
      receive: rawToUi(quoted.minimumAmountOut, decimalsOut),
      fee: rawToUi(fee, snapshot.quoteDecimals),
      unspent: rawToUi(new BN(quoted.amountLeft.toString()), nextSide === "buy" ? snapshot.quoteDecimals : snapshot.baseDecimals),
      minimumAmountOut: quoted.minimumAmountOut,
      amountIn,
    };
  }

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setError("");
    setQuote(null);
    try {
      setQuote(await buildQuote(side, amount));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not quote that swap.");
    }
  }

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
      setSide("buy");
      setAmount(rawToUi(gross, snapshot.quoteDecimals));
      setQuote(null);
      setStatus("Amount set for a completing buy at the current fee. Preview the quote, then sign.");
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
      const transaction = await client.pool.swap2({
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
        `Amount in: ${preview.pay} ${unit}`,
        `Minimum out: ${preview.receive} ${outUnit}`,
        `Quote fee: ${preview.fee} ${snapshot.quoteSymbol}`,
        `Unspent input returned: ${preview.unspent} ${unit}`,
        `Slippage: ${slippageBps / 100}%`,
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

  async function migrate() {
    if (!publicKey || !signTransaction) {
      setError("Connect a wallet to migrate.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const result = await client.migration.migrateToDammV2({
        payer: publicKey,
        pool: new PublicKey(address),
        dammConfig: new PublicKey(DAMM_V2_FEE_25_BPS),
      });
      const prepared = await prepareTransaction(connection, publicKey, result.transaction, [
        result.firstPositionNftKeypair,
        result.secondPositionNftKeypair,
      ]);
      const lines = [
        "Action: migrateToDammV2",
        `Network: ${cluster}`,
        `Pool: ${address}`,
        `DAMM v2 config: ${DAMM_V2_FEE_25_BPS} (25 bps)`,
        "USDC spent: 0",
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
        "Migrated liquidity is permanently locked. The position NFT keypairs sign inside this transaction and are not stored.",
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setSignature(confirmed);
      setStatus("Migration confirmed.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Migration failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="board">
      <p className="eyebrow">
        <Link href="/">PAR</Link> · public listing
      </p>
      {!snapshot && !error ? <p>Loading the curve…</p> : null}
      {snapshot ? (
        <>
          <header className="board-title">
            <h1>
              {snapshot.name} <span>{snapshot.symbol}</span>
            </h1>
            <p>
              Opens at {OPENS_AT}, ends at {ENDS_AT}, full at{" "}
              {snapshot.threshold.eq(new BN(PRESETS.par.migrationQuoteThreshold))
                ? PRESETS.par.cardFull
                : `${formatUsdc(snapshot.threshold)} USDC`}
              .
            </p>
            <ListingActions
              name={snapshot.name}
              mint={snapshot.baseMint}
              fullAt={
                snapshot.threshold.eq(new BN(PRESETS.par.migrationQuoteThreshold))
                  ? PRESETS.par.cardFull
                  : `${formatUsdc(snapshot.threshold)} USDC`
              }
              viewHref={explorerAccount(snapshot.dammPool ?? snapshot.address, cluster)}
              sharePath={`/pool/${snapshot.address}`}
              quoteMint={snapshot.quoteMint}
            />
          </header>
          <section className="quotes" aria-label="Curve progress">
            <article>
              <h2>Price</h2>
              <p className="figure">
                {snapshot.price} <span>{snapshot.quoteSymbol}</span>
              </p>
              <p className="note">
                Chain open {snapshot.startPrice} {snapshot.quoteSymbol} · chain end {snapshot.endPrice}{" "}
                {snapshot.quoteSymbol}. Rounded, that is {OPENS_AT} to {ENDS_AT}.
              </p>
            </article>
            <article>
              <h2>{snapshot.quoteSymbol} raised</h2>
              <p className="figure">
                {formatUsdc(snapshot.raised)} <span>/ {formatUsdc(snapshot.threshold)}</span>
              </p>
              <p className="note">Quote reserve against the graduation threshold.</p>
            </article>
            <article>
              <h2>To graduation</h2>
              <p className="figure">
                {snapshot.percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                <span>%</span>
              </p>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${snapshot.percent}%` }} />
              </div>
            </article>
          </section>

          {snapshot.isMigrated ? (
            <p className="status">
              Graduated to DAMM v2
              {snapshot.dammPool ? (
                <>
                  {" · "}
                  <a href={explorerAccount(snapshot.dammPool, cluster)}>{shortAddress(snapshot.dammPool)}</a>
                </>
              ) : null}
              .
            </p>
          ) : null}

          {snapshot.trading ? (
            <form className="trade" onSubmit={onPreview}>
              <div className="segmented" role="group" aria-label="Side">
                <button type="button" aria-pressed={side === "buy"} onClick={() => setSide("buy")}>
                  Buy
                </button>
                <button type="button" aria-pressed={side === "sell"} onClick={() => setSide("sell")}>
                  Sell
                </button>
              </div>
              <label>
                {side === "buy" ? `${snapshot.quoteSymbol} in` : `${snapshot.symbol} in`}
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setQuote(null);
                  }}
                  required
                />
              </label>
              <label>
                Slippage, bps
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={slippageBps}
                  onChange={(event) => setSlippageBps(Number(event.target.value))}
                />
              </label>
              <div className="actions">
                <button type="submit">Preview quote</button>
                {side === "buy" ? (
                  <button type="button" onClick={() => void sizeCompletingBuy()}>
                    Size completing buy
                  </button>
                ) : null}
                <button
                  className="solid"
                  type="button"
                  disabled={!quote || busy}
                  onClick={() => {
                    if (quote) void signSwap(quote);
                  }}
                >
                  {busy ? "Signing…" : `Sign ${side}`}
                </button>
              </div>
              {quote ? (
                <dl className="quote-slip">
                  <div>
                    <dt>You pay</dt>
                    <dd>
                      {quote.pay} {side === "buy" ? snapshot.quoteSymbol : snapshot.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Minimum received</dt>
                    <dd>
                      {quote.receive} {side === "buy" ? snapshot.symbol : snapshot.quoteSymbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Quote fee</dt>
                    <dd>
                      {quote.fee} {snapshot.quoteSymbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Returned input</dt>
                    <dd>
                      {quote.unspent} {side === "buy" ? snapshot.quoteSymbol : snapshot.symbol}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </form>
          ) : null}

          {snapshot.canMigrate ? (
            <section className="migrate">
              <h2>Curve complete</h2>
              <p>
                Trading on the bonding curve has stopped. Migrate into DAMM v2 at 25 bps. On mainnet,
                Meteora keepers also migrate a USDC pool that reached 750 USDC. Devnet needs this signature.
              </p>
              <button className="solid" type="button" disabled={busy} onClick={() => void migrate()}>
                Sign migrateToDammV2
              </button>
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
