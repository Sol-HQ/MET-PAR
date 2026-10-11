"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { explorerTx, type ClusterName } from "@/lib/constants";
import { landingCost, prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";

type ActionMetadata = {
  title: string;
  icon: string;
  description: string;
  label: string;
  links?: { actions?: Array<{ href: string; label: string }> };
};

export function BlinkPurchase({ title, pageCluster }: { title: string; pageCluster: ClusterName }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { cluster } = useCluster();
  const [action, setAction] = useState<ActionMetadata | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ prepared: PreparedTransaction; lines: string[] } | null>(null);
  const wallet = publicKey?.toBase58() || "";
  const salePage = `/t/${encodeURIComponent(title)}${pageCluster === "devnet" ? "?c=devnet" : ""}`;

  const load = useCallback(async () => {
    setLoadError("");
    setAction(null);
    try {
      const query = pageCluster === "devnet" ? "?c=devnet" : "";
      const response = await fetch(`/api/actions/title/${encodeURIComponent(title)}${query}`, { cache: "no-store" });
      const body = (await response.json()) as ActionMetadata & { message?: string };
      if (!response.ok) throw new Error(body.message || "This Blink is not available right now.");
      if (!body.title || !body.icon || !body.description || !body.links?.actions?.[0]?.href) {
        throw new Error("The purchase details could not be verified.");
      }
      setAction(body);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "This Blink is not available right now.");
    }
  }, [pageCluster, title]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!publicKey || !signTransaction || !action?.links?.actions?.[0]?.href) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const actionUrl = new URL(action.links.actions[0].href, window.location.origin);
      if (actionUrl.origin !== window.location.origin) throw new Error("The purchase endpoint is not on the PAR site.");
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: wallet }),
        cache: "no-store",
      });
      const body = (await response.json()) as { transaction?: string; message?: string };
      if (!response.ok || !body.transaction) throw new Error(body.message || "The live listing is no longer available. Refresh and try again.");
      const bytes = Uint8Array.from(atob(body.transaction), (character) => character.charCodeAt(0));
      const transaction = Transaction.from(bytes);
      const compiled = transaction.compileMessage();
      if (
        transaction.feePayer?.toBase58() !== wallet ||
        compiled.header.numRequiredSignatures !== 1 ||
        compiled.accountKeys[0]?.toBase58() !== wallet
      ) {
        throw new Error("The returned transaction does not match your wallet. Nothing was signed.");
      }
      const prepared = await prepareTransaction(connection, publicKey, transaction, [], { tip: false });
      const lines = [body.message || "Buy this title NFT. Physical handoff is arranged on the PAR sale page.", landingCost(prepared)];
      if (pageCluster === "mainnet-beta") {
        setGate({ prepared, lines });
        return;
      }
      const signature = await sendPrepared(connection, prepared, signTransaction, "Blink purchase confirmed.");
      setDone(explorerTx(signature, pageCluster));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not complete the purchase.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmMainnet() {
    if (!gate || !signTransaction) return;
    setBusy(true);
    setError("");
    try {
      const signature = await sendPrepared(connection, gate.prepared, signTransaction, "Blink purchase confirmed.");
      setDone(explorerTx(signature, pageCluster));
      setGate(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not complete the purchase.");
    } finally {
      setBusy(false);
    }
  }

  const connectedToPageCluster = cluster === pageCluster;

  return (
    <section className="card blink-purchase">
      <div className="blink-heading">
        {action?.icon ? <img src={action.icon} alt="PAR" width={56} height={56} /> : null}
        <div>
          <p className="eyebrow">PAR · Tensor purchase</p>
          <h1>{action?.title || "Buy this title"}</h1>
        </div>
      </div>
      {action ? <p className="blink-description">{action.description}</p> : null}
      {loadError ? <p className="error" role="alert">{loadError}</p> : null}
      {!connectedToPageCluster ? (
        <p className="error" role="alert">Switch PAR to {pageCluster === "devnet" ? "Devnet" : "Mainnet"} before signing.</p>
      ) : null}
      <div className="blink-controls">
        <WalletMultiButton />
        <button className="solid blink-buy" type="button" disabled={!action || !wallet || busy || !connectedToPageCluster} onClick={() => void submit()}>
          {busy ? "Preparing…" : action?.label || "Buy title"}
        </button>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh listing
        </button>
      </div>
      {done ? (
        <p className="status" role="status">
          Purchase confirmed. <a href={done} target="_blank" rel="noreferrer">View transaction</a>. <Link href={salePage}>Open PAR handoff</Link>.
        </p>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <p className="blink-footnote">Your wallet reviews and signs the Tensor transaction. NFT ownership transfers on-chain; physical handoff is arranged separately on PAR.</p>
      <Link className="blink-back" href={salePage}>View the full PAR sale page</Link>
      {gate ? (
        <MainnetGate
          title="Buy this title from the Blink"
          lines={gate.lines}
          confirmLabel="Review in wallet"
          onCancel={() => setGate(null)}
          onConfirm={() => void confirmMainnet()}
        />
      ) : null}
    </section>
  );
}
