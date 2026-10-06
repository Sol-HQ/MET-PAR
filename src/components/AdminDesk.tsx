"use client";

import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { isAdminWallet, PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useCluster } from "@/lib/cluster";
import { FEE_DECAY_CHOICES, HIDDEN_POOLS } from "@/lib/constants";
import { creatorSalePercent, poolPath, SALE_PROGRAM_FEE_PERCENT } from "@/lib/title";
import { formatLamports, formatMoney, rawToUi, shortAddress } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";
import { prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";
import {
  assertPlatformFeePercent,
  creatorSharePercent,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_PLATFORM_SETTINGS,
  lockedLiquiditySplit,
  METEORA_TRADING_FEE_PERCENT,
  settingsMessage,
  type PlatformSettings,
} from "@/lib/platform";

type FeeRow = {
  address: string;
  name: string;
  symbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  baseDecimals: number;
  partnerQuoteFee: BN;
  partnerBaseFee: BN;
  feeClaimer: string;
};

type LeftoverRow = {
  address: string;
  name: string;
  symbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  baseDecimals: number;
  amount: BN;
  protocolBase: BN;
  protocolQuote: BN;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function AdminDesk() {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signMessage, signTransaction } = useWallet();
  const [settings, setSettings] = useState<PlatformSettings>(DEFAULT_PLATFORM_SETTINGS);
  const [share, setShare] = useState(String(DEFAULT_PLATFORM_FEE_PERCENT));
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<FeeRow[]>([]);
  const [leftovers, setLeftovers] = useState<LeftoverRow[]>([]);
  const [rowsReady, setRowsReady] = useState(false);
  const [pending, setPending] = useState<{ prepared: PreparedTransaction; lines: string[]; title: string } | null>(null);
  const [records, setRecords] = useState<{
    index: boolean;
    objects: { record: string; title: string; mint: string; name: string; symbol: string; creator: string; rail: string; status: string; created_at: string }[];
    coins: { pool: string; name?: string | null; symbol?: string | null; creator?: string | null; mint?: string | null; created_at?: string }[];
    watcher: { last_at: string | null; ok: boolean; note: string; watched: number; marked: number; settled: number; cluster: string } | null;
  } | null>(null);
  const admin = isAdminWallet(publicKey?.toBase58());
  const platformSigner = publicKey?.toBase58() === PLATFORM_FEE_CLAIMER;

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    void fetch(`/api/admin/status?cluster=${cluster}`)
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        setRecords(await response.json());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [admin, cluster, status]);

  useEffect(() => {
    void fetch("/api/platform")
      .then(async (response) => {
        if (!response.ok) return;
        const next = (await response.json()) as PlatformSettings;
        setSettings(next);
        setShare(String(next.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    setRowsReady(false);
    async function loadFees() {
      const addresses = new Set<string>();
      const listed = await fetch(`/api/listings?cluster=${cluster}`)
        .then(async (response) => {
          if (!response.ok) return [] as string[];
          const body = (await response.json()) as { pools?: { pool?: string }[] };
          return (body.pools || []).map((item) => item.pool).filter((pool): pool is string => typeof pool === "string" && !HIDDEN_POOLS.has(pool));
        })
        .catch(() => [] as string[]);
      for (const pool of listed) addresses.add(pool);
      try {
        const remembered = JSON.parse(window.localStorage.getItem("par.listings.v1") || "[]") as { pool?: string; cluster?: string }[];
        if (Array.isArray(remembered)) {
          for (const item of remembered) {
            if (item?.cluster === cluster && item.pool && !HIDDEN_POOLS.has(item.pool)) addresses.add(item.pool);
          }
        }
      } catch {
        // A bad local list does not hide the saved pools.
      }
      const loaded: FeeRow[] = [];
      const loose: LeftoverRow[] = [];
      await Promise.all(
        [...addresses].slice(0, 40).map(async (address) => {
          try {
            const snapshot = await loadPool(connection, address);
            if (snapshot.feeClaimer !== PLATFORM_FEE_CLAIMER) return;
            loaded.push({
              address: snapshot.address,
              name: snapshot.name,
              symbol: snapshot.symbol,
              quoteSymbol: snapshot.quoteSymbol,
              quoteDecimals: snapshot.quoteDecimals,
              baseDecimals: snapshot.baseDecimals,
              partnerQuoteFee: snapshot.partnerQuoteFee,
              partnerBaseFee: snapshot.partnerBaseFee,
              feeClaimer: snapshot.feeClaimer,
            });
            if (
              snapshot.isMigrated &&
              snapshot.leftoverReceiver === PLATFORM_FEE_CLAIMER &&
              (snapshot.protocolMigrationBase.gtn(0) ||
                (!snapshot.leftoverWithdrawn && snapshot.leftoverBase.gtn(0)))
            ) {
              loose.push({
                address: snapshot.address,
                name: snapshot.name,
                symbol: snapshot.symbol,
                quoteSymbol: snapshot.quoteSymbol,
                quoteDecimals: snapshot.quoteDecimals,
                baseDecimals: snapshot.baseDecimals,
                amount: snapshot.leftoverWithdrawn ? new BN(0) : snapshot.leftoverBase,
                protocolBase: snapshot.protocolMigrationBase,
                protocolQuote: snapshot.protocolMigrationQuote,
              });
            }
          } catch {
            // Skip a pool the RPC cannot read.
          }
        }),
      );
      loaded.sort((a, b) => b.partnerQuoteFee.cmp(a.partnerQuoteFee));
      if (!cancelled) {
        setRows(loaded);
        setLeftovers(loose);
        setRowsReady(true);
      }
    }
    void loadFees();
    return () => {
      cancelled = true;
    };
  }, [admin, cluster, connection, status]);

  async function claimPlatformFee(row: FeeRow) {
    if (!publicKey || !signTransaction) {
      setError("Connect the platform wallet to claim.");
      return;
    }
    if (publicKey.toBase58() !== row.feeClaimer) {
      setError("The platform wallet has to sign this claim.");
      return;
    }
    if (row.partnerQuoteFee.isZero() && row.partnerBaseFee.isZero()) {
      setError("Nothing is waiting on that token.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.partner.claimPartnerTradingFee({
        feeClaimer: publicKey,
        payer: publicKey,
        pool: new PublicKey(row.address),
        maxBaseAmount: row.partnerBaseFee,
        maxQuoteAmount: row.partnerQuoteFee,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const lines = [
        "Action: claim platform curve fee",
        `Network: ${cluster}`,
        `Token: ${row.name} ${row.symbol}`,
        `Pool: ${row.address}`,
        `${row.quoteSymbol} sent to the platform wallet: ${formatMoney(row.partnerQuoteFee, row.quoteDecimals)}`,
        row.partnerBaseFee.isZero()
          ? `${row.symbol} sent to the platform wallet: 0`
          : `${row.symbol} sent to the platform wallet: ${rawToUi(row.partnerBaseFee, row.baseDecimals)}`,
        `Receiver: ${publicKey.toBase58()}`,
        "This withdraws the platform share of the curve fee. It does not take tokens out of the locked pool.",
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines, title: "Claim this platform fee on mainnet?" });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setStatus(`Claimed ${formatMoney(row.partnerQuoteFee, row.quoteDecimals)} ${row.quoteSymbol} from ${row.symbol}. Signature ${confirmed}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function withdrawLeftover(row: LeftoverRow) {
    if (!publicKey || !signTransaction) {
      setError("Connect the platform wallet to withdraw the leftover.");
      return;
    }
    if (publicKey.toBase58() !== PLATFORM_FEE_CLAIMER) {
      setError("The platform wallet has to sign this withdrawal.");
      return;
    }
    if (row.amount.isZero()) {
      setError("No leftover is waiting on that token.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.migration.withdrawLeftover({
        payer: publicKey,
        pool: new PublicKey(row.address),
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const amount = rawToUi(row.amount, row.baseDecimals);
      const lines = [
        "Action: withdraw leftover tokens",
        `Network: ${cluster}`,
        `Token: ${row.name} ${row.symbol}`,
        `Pool: ${row.address}`,
        `${row.symbol} sent to the platform wallet: ${amount}`,
        `Receiver: ${PLATFORM_FEE_CLAIMER}`,
        "These tokens were left on the curve. They are not taken out of the locked pool.",
        "Quote token spent: 0",
        `Network fee: ${formatLamports(prepared.feeLamports)}`,
      ];
      if (cluster === "mainnet-beta") {
        setPending({ prepared, lines, title: "Withdraw leftover tokens on mainnet?" });
        return;
      }
      const confirmed = await sendPrepared(connection, prepared, signTransaction);
      setStatus(`Withdrew ${amount} ${row.symbol} to the platform wallet. Signature ${confirmed}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The leftover withdrawal failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save(platformFeePercent: number) {
    if (!publicKey || !signMessage) throw new Error("This wallet cannot sign the admin message.");
    const issuedAt = Date.now();
    const message = settingsMessage({
      openingFeeBps: settings.openingFeeBps,
      platformFeeBps: settings.platformFeeBps,
      platformFeePercent,
      issuedAt,
    });
    const signature = await signMessage(new TextEncoder().encode(message));
    const response = await fetch("/api/platform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: publicKey.toBase58(),
        signature: bytesToBase64(signature),
        issuedAt,
        platformFeePercent,
      }),
    });
    const body = (await response.json()) as PlatformSettings & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not save the platform settings.");
    setSettings(body);
  }

  async function askWatcher() {
    if (!publicKey || !signMessage) throw new Error("This wallet cannot sign the admin message.");
    const issuedAt = Date.now();
    const message = ["PAR watcher pass", `cluster=${cluster}`, `issuedAt=${issuedAt}`].join("\n");
    const signature = await signMessage(new TextEncoder().encode(message));
    const response = await fetch("/api/admin/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: publicKey.toBase58(),
        signature: bytesToBase64(signature),
        issuedAt,
        cluster,
      }),
    });
    const body = (await response.json()) as { error?: string; watched?: number; marked?: number; settled?: number };
    if (!response.ok) throw new Error(body.error || "The pass failed.");
    return body;
  }

  async function onPublish() {
    setError("");
    setStatus("");
    if (!admin || !publicKey) {
      setError("This wallet cannot change platform settings.");
      return;
    }
    let platformFeePercent = DEFAULT_PLATFORM_FEE_PERCENT;
    try {
      if (!/^\d+$/.test(share.trim())) {
        throw new Error("Platform fee must be a whole number from 0 to 80, in steps of 4. 20 is the current law.");
      }
      platformFeePercent = Number(share.trim());
      assertPlatformFeePercent(platformFeePercent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That platform fee is not allowed.");
      return;
    }
    setBusy(true);
    try {
      await save(platformFeePercent);
      setStatus("Saved. The next token created here uses this split. Tokens already created keep their old one.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish the template.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="desk">
      <p className="eyebrow">
        <Link href="/">PAR</Link> · platform admin
      </p>
      <h1>Platform settings</h1>
      {!publicKey ? <p>Connect the pa wallet or the me wallet.</p> : null}
      {publicKey && !admin ? (
        <p className="error" role="alert">
          This wallet cannot change platform settings.
        </p>
      ) : null}
      {admin ? (
        <>
          <p>
            Saved platform share of the trading fee: <strong>{settings.platformFeePercent}%</strong>. Meteora keeps{" "}
            {METEORA_TRADING_FEE_PERCENT}%. The token creator keeps {creatorSharePercent(settings.platformFeePercent)}%.
            Claims go to {PLATFORM_FEE_CLAIMER}.
            {settings.updatedAt ? ` Last saved ${new Date(settings.updatedAt).toUTCString()}.` : ""}
          </p>
          <div className="fee-board-wrap">
            <table className="fee-board">
              <thead>
                <tr>
                  <th>Fee</th>
                  <th>Amount</th>
                  <th>Who receives it</th>
                  <th>How to change it</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Curve trading fee</th>
                  <td>
                    The buyer pays this while the curve is filling. The creator types 0.25% to 99% on the create
                    form. A flat fee stays at that percent. A falling fee opens at that percent and ends at the
                    ending fee, straight or curved, over {FEE_DECAY_CHOICES.map((choice) => choice.label).join(", ")}.
                  </td>
                  <td>Split into the three rows under this one.</td>
                  <td>On the create form, before the token exists. This page leaves a token that already exists as it was written.</td>
                </tr>
                <tr>
                  <th>Volatility add-on</th>
                  <td>
                    While the price is moving, Meteora can add at most one fifth of the curve fee. A 25% fee can rise
                    by up to 5 points, then it fades. The two together still stop at 99%. There is no second amount.
                    It does not change how much quote locks.
                  </td>
                  <td>The same split as the curve trading fee.</td>
                  <td>The checkbox on the create form. This page has no amount box for it.</td>
                </tr>
                <tr>
                  <th>Meteora’s share</th>
                  <td>{METEORA_TRADING_FEE_PERCENT}% of the trading fee, on the curve and on the pool.</td>
                  <td>Meteora.</td>
                  <td>Fixed in Meteora’s program.</td>
                </tr>
                <tr>
                  <th>Platform share</th>
                  <td>
                    {settings.platformFeePercent}% of the whole trading fee. The box below is the control. Whole
                    numbers from 0 to 80, in steps of 4. 4 is the closest step to 2. At 4, Meteora keeps 20, the
                    platform keeps 4, and the creator keeps 76.
                  </td>
                  <td>The platform wallet {PLATFORM_FEE_CLAIMER}. The section below claims what has already built up on the curve.</td>
                  <td>Save the box below. The next token uses it. A token already created keeps the split written into it.</td>
                </tr>
                <tr>
                  <th>Creator share</th>
                  <td>{creatorSharePercent(settings.platformFeePercent)}% of the whole trading fee.</td>
                  <td>The token creator.</td>
                  <td>It moves when the platform percent changes. There is no separate box.</td>
                </tr>
                <tr>
                  <th>Pool fee after the lock</th>
                  <td>
                    The creator picks 0.25%, 0.30%, 1%, 2%, 4%, or 6% on the create form. The default is 0.25%.
                    Compounding uses a pool fee from 0.1% to 10% and puts a typed share, from 1% to 100%, back into
                    the pool. With compounding off, Meteora keeps {METEORA_TRADING_FEE_PERCENT}% first. Of the remaining
                    80%, the platform’s {settings.platformFeePercent}% of the whole fee is{" "}
                    {lockedLiquiditySplit(settings.platformFeePercent).partner}% of the locked position, and the
                    creator’s {creatorSharePercent(settings.platformFeePercent)}% of the whole fee is{" "}
                    {lockedLiquiditySplit(settings.platformFeePercent).creator}% of the locked position. With
                    compounding on, Meteora’s 20% still comes out first, and the typed share of what remains goes back
                    into the pool. At 100% nothing is left to claim. The liquidity stays locked.
                  </td>
                  <td>
                    Meteora, then the platform wallet and the creator, unless compounding puts the remainder back into
                    the pool.
                  </td>
                  <td>On the create form, before the token exists.</td>
                </tr>
                <tr>
                  <th>At the lock</th>
                  <td>
                    Meteora keeps 0.2% of the tokens and 0.2% of the quote that move into the pool. The pool creation
                    fee is 0. There is no second skim on top of the 0.2%.
                  </td>
                  <td>Meteora’s program wallet claims the 0.2%.</td>
                  <td>Fixed in Meteora’s program.</td>
                </tr>
                <tr>
                  <th>Leftover tokens</th>
                  <td>Tokens the curve could not sell or put in the pool.</td>
                  <td>The platform wallet {PLATFORM_FEE_CLAIMER}.</td>
                  <td>The withdraw button in the leftover section. The platform wallet signs it.</td>
                </tr>
                <tr>
                  <th>Title, escrow path</th>
                  <td>
                    The creator chooses the burn when the title is deposited. At a {25}% burn, {25}% is burned,{" "}
                    {SALE_PROGRAM_FEE_PERCENT}% goes to the program, and {creatorSalePercent(25)}% goes to the creator.
                  </td>
                  <td>
                    The burned part is destroyed. {SALE_PROGRAM_FEE_PERCENT}% goes to {PLATFORM_FEE_CLAIMER}. The rest
                    goes to the creator.
                  </td>
                  <td>
                    The burn is chosen on the create form. The {SALE_PROGRAM_FEE_PERCENT}% is written in the escrow
                    program. Saving this page leaves that {SALE_PROGRAM_FEE_PERCENT}% as it is.
                  </td>
                </tr>
                <tr>
                  <th>Title, Tensor</th>
                  <td>The creator receives the list price. The buyer also pays Tensor about 2%.</td>
                  <td>The creator, and Tensor. The platform receives nothing on this path.</td>
                  <td>The list price is set by the creator on the sale page. This page has no Tensor cut to edit.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <form
            className="launch"
            onSubmit={(event) => {
              event.preventDefault();
              void onPublish();
            }}
          >
            <label>
              Platform fee, percent of the trading fee
              <input value={share} onChange={(event) => setShare(event.target.value)} inputMode="numeric" />
            </label>
            <p className="note">
              20 means Meteora 20, platform 20, token creator 60. 4 means Meteora 20, platform 4, token creator
              76. 4 is the closest step to 2. Public users cannot edit this. Saving it applies to the next token.
              It does not edit a token that already exists, and it does not change the escrow program or a Tensor sale.
            </p>
            <button type="button" onClick={() => setShare("4")}>
              Use 4%, the closest step to 2%
            </button>
            <button className="solid" type="submit" disabled={busy}>
              {busy ? "Waiting for the wallet…" : "Save platform fee"}
            </button>
            <p className="note">One signature on this message. SOL spent is 0. The quote token spent is 0.</p>
          </form>
          <section className="rows">
            <h2>Records</h2>
            <p>
              {cluster === "devnet" ? "Practice network" : "Real network"} only. A create on the other network is a
              different list. Each object row keeps the creator wallet, the coin, the master, the title, and the
              sheet. Each coin row keeps the wallet that created it and the token metadata. Pictures saved from a
              signed wallet are stored with that wallet.
            </p>
            {!records?.index ? <p className="note">The record store is not configured on this site yet.</p> : null}
            {records?.index && records.objects.length === 0 && records.coins.length === 0 ? (
              <p className="note">Nothing has been recorded on this network yet.</p>
            ) : null}
            <div className="card-grid">
              {(records?.objects || []).map((row) => (
                <article key={row.record} className="migrate">
                  <h3>
                    {row.name} {row.symbol}
                  </h3>
                  <p>
                    Object. {row.rail}. {row.status}. Creator {shortAddress(row.creator)}.
                  </p>
                  <p className="note">
                    Coin {shortAddress(row.mint)}. Master {shortAddress(row.record)}. Title {shortAddress(row.title)}.
                  </p>
                </article>
              ))}
              {(records?.coins || []).map((row) => (
                <article key={row.pool} className="migrate">
                  <h3>
                    {row.name || "Coin"} {row.symbol || ""}
                  </h3>
                  <p>Coin. Creator {row.creator ? shortAddress(row.creator) : "unknown"}.</p>
                  <p className="note">
                    <Link href={poolPath(row.pool, cluster)}>Pool {shortAddress(row.pool)}</Link>
                    {row.mint ? `. Mint ${shortAddress(row.mint)}` : ""}
                  </p>
                </article>
              ))}
            </div>
          </section>
          <section className="rows">
            <h2>Watcher</h2>
            <p>
              The watcher is a job on cron-job.org. About every minute it calls this site, on the practice network.
              It marks graduation and finishes an auction whose clock has ended. The real network does not use this
              job. Run a pass does the same call once, when you press it.
            </p>
            <p className="note">
              {records?.watcher?.last_at
                ? `Last pass ${new Date(records.watcher.last_at).toUTCString()}. Watching ${records.watcher.watched}. Marked ${records.watcher.marked}. Finished ${records.watcher.settled}. ${records.watcher.ok ? "The last pass completed." : records.watcher.note || "The last pass failed."}`
                : "No pass has been reported."}
            </p>
            <button
              type="button"
              disabled={busy || cluster !== "devnet"}
              onClick={() => {
                setError("");
                setBusy(true);
                askWatcher()
                  .then((result) =>
                    setStatus(
                      `Pass finished. Watching ${result.watched ?? 0}. Marked ${result.marked ?? 0}. Finished ${result.settled ?? 0}.`,
                    ),
                  )
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The watcher was not asked."))
                  .finally(() => setBusy(false));
              }}
            >
              Run a pass
            </button>
            {cluster !== "devnet" ? (
              <p className="note">Run a pass is for the practice network. The real network has no watcher.</p>
            ) : null}
          </section>
          <section className="rows">
            <h2>Platform curve fees</h2>
            <p>
              Every token launched on this network. The amount is the platform share of the curve fee,
              including trades while the buyer fee was still high. Claiming sends that quote token to the platform
              wallet. It does not take tokens out of the locked pool.
            </p>
            {!platformSigner ? (
              <p className="note">
                The platform wallet {shortAddress(PLATFORM_FEE_CLAIMER)} signs these claims. This admin wallet
                can see what is waiting.
              </p>
            ) : null}
            {!rowsReady ? <p className="note">Reading the tokens…</p> : null}
            {rowsReady && rows.length === 0 ? <p className="note">No tokens on this network yet.</p> : null}
            <div className="card-grid">
              {rows.map((row) => {
                const waiting = `${formatMoney(row.partnerQuoteFee, row.quoteDecimals)} ${row.quoteSymbol}`;
                const empty = row.partnerQuoteFee.isZero() && row.partnerBaseFee.isZero();
                return (
                  <article key={row.address} className="migrate">
                    <h3>
                      {row.name} {row.symbol}
                    </h3>
                    <p>
                      {waiting}
                      {row.partnerBaseFee.isZero()
                        ? ""
                        : ` and ${rawToUi(row.partnerBaseFee, row.baseDecimals)} ${row.symbol}`}{" "}
                      waiting for the platform wallet.
                    </p>
                    <button
                      className="solid"
                      type="button"
                      disabled={busy || (platformSigner && empty)}
                      onClick={() => {
                        if (!platformSigner) {
                          setError(
                            `Connect ${shortAddress(PLATFORM_FEE_CLAIMER)} to claim the platform share of ${row.symbol}. The token page claims the same fee when that wallet is connected.`,
                          );
                          return;
                        }
                        void claimPlatformFee(row);
                      }}
                    >
                      {platformSigner ? `Claim ${waiting}` : `Claim ${waiting} with the platform wallet`}
                    </button>
                    <p className="note">
                      <Link href={poolPath(row.address, cluster)}>View token</Link>
                    </p>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="rows">
            <h2>Leftover tokens</h2>
            <p>
              After graduation, two piles can sit on the curve. Meteora’s migration fee is 0.2% of the tokens and
              quote that moved into the trading pool. Meteora’s program wallet claims that fee. A smaller leftover is
              what the curve could not sell or put in the pool. The launch writes the platform wallet as that
              leftover receiver, separate from the creator. The button sends that leftover once to the platform wallet.
            </p>
            {!platformSigner ? (
              <p className="note">
                The platform wallet {shortAddress(PLATFORM_FEE_CLAIMER)} signs this withdrawal. This admin wallet can
                see what is waiting.
              </p>
            ) : null}
            {rowsReady && leftovers.length === 0 ? <p className="note">No leftover is waiting on this network.</p> : null}
            <div className="card-grid">
              {leftovers.map((row) => {
                const amount = rawToUi(row.amount, row.baseDecimals);
                const protocol = rawToUi(row.protocolBase, row.baseDecimals);
                return (
                  <article key={row.address} className="migrate">
                    <h3>
                      {row.name} {row.symbol}
                    </h3>
                    {row.protocolBase.isZero() ? null : (
                      <p>
                        {protocol} {row.symbol}
                        {row.protocolQuote.isZero()
                          ? ""
                          : ` and ${formatMoney(row.protocolQuote, row.quoteDecimals)} ${row.quoteSymbol}`}{" "}
                        are Meteora’s migration fee. Their program wallet claims that.
                      </p>
                    )}
                    {row.amount.isZero() ? (
                      <p className="note">No leftover is waiting for the platform wallet.</p>
                    ) : (
                      <>
                        <p>
                          {amount} {row.symbol} leftover waiting for the platform wallet.
                        </p>
                        <button
                          className="solid"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (!platformSigner) {
                              setError(
                                `Connect ${shortAddress(PLATFORM_FEE_CLAIMER)} to withdraw the leftover ${row.symbol}. The tokens go to that wallet.`,
                              );
                              return;
                            }
                            void withdrawLeftover(row);
                          }}
                        >
                          {platformSigner
                            ? `Withdraw ${amount} ${row.symbol}`
                            : `Withdraw ${amount} ${row.symbol} with the platform wallet`}
                        </button>
                      </>
                    )}
                    <p className="note">
                      <Link href={poolPath(row.address, cluster)}>View token</Link>
                    </p>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="status">{status}</p> : null}
      {pending ? (
        <MainnetGate
          title={pending.title}
          lines={pending.lines}
          confirmLabel="Open wallet"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const next = pending;
            setPending(null);
            if (!signTransaction) return;
            setBusy(true);
            sendPrepared(connection, next.prepared, signTransaction)
              .then((confirmed) => {
                setStatus(`Confirmed. Signature ${confirmed}`);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Claim failed.");
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
