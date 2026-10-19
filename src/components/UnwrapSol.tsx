"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { useClusterWallet } from "@/lib/cluster-wallet";
import { explorerTx, type ClusterName } from "@/lib/constants";
import { formatLamports } from "@/lib/format";
import { landingCost, prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";
import { formatTokenAmount } from "@/lib/tensor-sale";
import { readWrappedSol, unwrapSolInstruction, type WrappedSolHolding } from "@/lib/token-pay";

/**
 * A Tensor sale priced in SOL pays the seller in wrapped SOL. This shows the connected wallet's wrapped SOL on this
 * page's network and turns it back into native SOL by closing the wrapped-SOL account. It moves nothing else.
 */
export function UnwrapSol({ pageCluster }: { pageCluster: ClusterName }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useClusterWallet();
  const { cluster } = useCluster();
  const [holding, setHolding] = useState<WrappedSolHolding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ lines: string[]; prepared: PreparedTransaction } | null>(null);
  const [tick, setTick] = useState(0);

  // A different wallet or network starts clean.
  useEffect(() => {
    setDone("");
    setError("");
  }, [publicKey, cluster]);

  useEffect(() => {
    let live = true;
    setHolding(null);
    if (!publicKey || cluster !== pageCluster) return;
    readWrappedSol(connection, publicKey)
      .then((read) => {
        if (live) setHolding(read);
      })
      .catch(() => {
        if (live) setHolding(null);
      });
    return () => {
      live = false;
    };
  }, [connection, publicKey, cluster, pageCluster, tick]);

  if (!publicKey || cluster !== pageCluster) return null;
  // After an unwrap the account is gone, so keep the explorer link until the wallet or network changes.
  if (!holding || holding.amount === BigInt(0)) {
    return done.startsWith("http") ? (
      <p className="status" role="status">
        Unwrapped.{" "}
        <a href={done} target="_blank" rel="noreferrer">
          View the transaction
        </a>
      </p>
    ) : null;
  }

  const lines = [
    `Your wrapped-SOL account holds ${formatTokenAmount(holding.amount, 9)} wrapped SOL.`,
    `Unwrap closes that account. ${formatLamports(Number(holding.lamports))} comes back to your wallet as SOL: the wrapped amount plus the account's rent.`,
    "Nothing else moves. A later Tensor sale or buy opens the account again when it needs it.",
  ];

  async function finish(prepared: PreparedTransaction) {
    if (!signTransaction) return;
    setBusy(true);
    setError("");
    setGate(null);
    try {
      const signature = await sendPrepared(connection, prepared, signTransaction, "Wrapped SOL is back as SOL.");
      setDone(explorerTx(signature, pageCluster));
      setTick((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  async function unwrap() {
    if (!publicKey || !holding?.closable) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await prepareTransaction(connection, publicKey, new Transaction().add(unwrapSolInstruction(publicKey)), []);
      if (pageCluster === "mainnet-beta") {
        setGate({ lines: [...lines, landingCost(prepared)], prepared });
        return;
      }
      setBusy(false);
      await finish(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="record-promises">
      <p className="eyebrow">Wrapped SOL</p>
      {holding.amount > BigInt(0) ? (
        <p className="note">
          This wallet holds {formatTokenAmount(holding.amount, 9)} wrapped SOL, for example from a Tensor sale priced in SOL. Unwrap turns it back
          into SOL in this wallet.
        </p>
      ) : null}
      {holding.reason ? <p className="error">{holding.reason}</p> : null}
      {holding.amount > BigInt(0) ? (
        <button type="button" disabled={busy || !holding.closable || !signTransaction} onClick={() => void unwrap()}>
          {busy ? "Working…" : "Unwrap SOL"}
        </button>
      ) : null}
      {done.startsWith("http") ? (
        <p className="status" role="status">
          Unwrapped.{" "}
          <a href={done} target="_blank" rel="noreferrer">
            View the transaction
          </a>
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {gate ? (
        <MainnetGate
          title="Unwrap SOL"
          lines={gate.lines}
          confirmLabel="Open wallet"
          onCancel={() => setGate(null)}
          onConfirm={() => void finish(gate.prepared)}
        />
      ) : null}
    </div>
  );
}
