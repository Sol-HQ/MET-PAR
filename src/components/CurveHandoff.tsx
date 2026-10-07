"use client";

import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { bpsToPercent } from "@/lib/format";
import { landingCost, prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";

type Pending = { prepared: PreparedTransaction; lines: string[]; done: string };

function useHandoff(onDone?: () => void) {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  async function send(prepared: PreparedTransaction, done: string) {
    if (!signTransaction) {
      setError("Connect a wallet. That wallet pays the rent and signs.");
      return;
    }
    setBusy(true);
    try {
      const signature = await sendPrepared(connection, prepared, signTransaction, done);
      setStatus(done);
      setError("");
      onDone?.();
      return signature;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The signature failed.");
    } finally {
      setBusy(false);
    }
  }

  async function gateOrSend(prepared: PreparedTransaction, lines: string[], done: string) {
    if (cluster === "mainnet-beta") {
      setPending({ prepared, lines, done });
      return;
    }
    await send(prepared, done);
  }

  const gate = pending ? (
    <MainnetGate
      title="Sign this mainnet transaction?"
      lines={pending.lines}
      confirmLabel="Open wallet"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const next = pending;
        setPending(null);
        void send(next.prepared, next.done);
      }}
    />
  ) : null;

  return { cluster, connection, publicKey, busy, error, setError, status, gateOrSend, gate };
}

export function LockReady({
  pool,
  symbol,
  fullAt,
  framed = true,
  compact = false,
  onDone,
}: {
  pool: string;
  symbol: string;
  fullAt: string;
  framed?: boolean;
  compact?: boolean;
  onDone?: () => void;
}) {
  const { cluster, connection, publicKey, busy, error, setError, status, gateOrSend, gate } = useHandoff(onDone);

  async function lock() {
    if (!publicKey) return;
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.migration.createLocker({
        payer: publicKey,
        pool: new PublicKey(pool),
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const lines = [
        "Action: lock the creator supply",
        `Network: ${cluster === "devnet" ? "practice" : "real"}`,
        `Pool: ${pool}`,
        `Token: ${symbol}`,
        "These tokens come out of the curve and stay reserved for the creator.",
        "Quote spent: 0",
        landingCost(prepared),
        "The wallet also pays the SOL rent for the locker. The wallet shows that amount before you approve.",
      ];
      const done =
        cluster === "devnet"
          ? "The creator supply is locked. Open the trading pool from this page. The practice network has no keepers."
          : "The creator supply is locked. Meteora's keepers can open the trading pool.";
      await gateOrSend(prepared, lines, done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The creator supply could not be locked.");
    }
  }

  const body = (
    <>
      {compact ? null : (
        <>
          <h2>The curve is full</h2>
          <p>
            Trading is stopped at {fullAt}. Any wallet can sign Lock the creator supply. That wallet pays the SOL rent. The wallet shows the amount before you approve.
          </p>
          <p>
            {cluster === "devnet"
              ? "After that signature, this page asks for Open the trading pool. The practice network has no keepers."
              : "That signature is what Meteora's keepers need before they open the trading pool."}
          </p>
        </>
      )}
      {publicKey ? (
        <button className="solid" type="button" disabled={busy} onClick={() => void lock()}>
          Lock the creator supply
        </button>
      ) : (
        <p>Connect a wallet. That wallet pays the rent and signs.</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p>{status}</p> : null}
      {gate}
    </>
  );

  if (!framed) return <div className="ready-actions">{body}</div>;
  return (
    <section className="ready-call" aria-label="Lock the creator supply">
      {body}
    </section>
  );
}

export function OpenPool({
  pool,
  dammConfig,
  quoteSymbol,
  feeBps,
  framed = true,
  onDone,
}: {
  pool: string;
  dammConfig: string;
  quoteSymbol: string;
  feeBps: number;
  framed?: boolean;
  onDone?: () => void;
}) {
  const { cluster, connection, publicKey, busy, error, setError, status, gateOrSend, gate } = useHandoff(onDone);

  async function open() {
    if (!publicKey) return;
    setError("");
    try {
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const result = await client.migration.migrateToDammV2({
        payer: publicKey,
        pool: new PublicKey(pool),
        dammConfig: new PublicKey(dammConfig),
      });
      const prepared = await prepareTransaction(connection, publicKey, result.transaction, [
        result.firstPositionNftKeypair,
        result.secondPositionNftKeypair,
      ]);
      const lines = [
        "Open the Meteora trading pool",
        `Network: ${cluster === "devnet" ? "practice" : "real"}`,
        `Curve: ${pool}`,
        `Pool fee after it opens: ${bpsToPercent(feeBps)}`,
        `${quoteSymbol} spent: 0`,
        landingCost(prepared),
        `The tokens and ${quoteSymbol} that move into the pool stay locked. This signature opens the pool.`,
      ];
      await gateOrSend(prepared, lines, "The trading pool is open.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The trading pool could not be opened.");
    }
  }

  const body = (
    <>
      <h2>Open the trading pool</h2>
      <p>
        {cluster === "devnet"
          ? "The creator supply is locked. Any wallet can sign Open the trading pool and pay the rent. Trading starts when that pool exists."
          : "The creator supply is locked. Meteora's keepers open an eligible pool. Any wallet can also sign Open the trading pool and pay the rent."}
      </p>
      {publicKey ? (
        <button className="solid" type="button" disabled={busy} onClick={() => void open()}>
          Open the trading pool
        </button>
      ) : (
        <p>Connect a wallet. That wallet pays the rent and signs.</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p>{status}</p> : null}
      {gate}
    </>
  );

  if (!framed) return <div>{body}</div>;
  return (
    <section className="handoff-call" aria-label="Open the trading pool">
      {body}
    </section>
  );
}
