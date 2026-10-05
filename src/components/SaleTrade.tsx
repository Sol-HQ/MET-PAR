"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { explorerTx, type ClusterName } from "@/lib/constants";
import { prepareTransaction, sendPrepared } from "@/lib/send";
import {
  buyOnTensorTransaction,
  buyerTotal,
  delistOnTensorInstruction,
  formatTokenAmount,
  listOnTensorInstruction,
  parseTokenAmount,
} from "@/lib/tensor-sale";
import { CREATOR_BURN_DAYS, TENSOR_TAKER_FEE_PERCENT } from "@/lib/title";

type Listing = { amount: string; currency: string | null; seller: string };

export function SaleTrade({
  pageCluster,
  title,
  mint,
  creator,
  symbol,
  burn,
  delayDays,
  finishedAt,
  graduated,
  holdsTitle,
  listing,
  decimals = 6,
  noCoin = false,
}: {
  pageCluster: ClusterName;
  title: string;
  mint: string;
  creator: string;
  symbol: string;
  burn: number;
  delayDays: number;
  finishedAt: number;
  graduated: boolean;
  holdsTitle: boolean;
  listing: Listing | null;
  decimals?: number;
  noCoin?: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { cluster } = useCluster();
  const router = useRouter();
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ title: string; lines: string[]; transaction: Transaction } | null>(null);

  const opensAt = finishedAt > 0 ? finishedAt + delayDays * 86_400 : 0;
  const open = noCoin || (graduated && opensAt > 0 && Math.floor(Date.now() / 1000) >= opensAt);
  const wallet = publicKey?.toBase58() ?? "";
  const isCreator = wallet === creator;
  const pricedInCoin = Boolean(listing) && listing?.currency === mint;
  const canBuy = Boolean(listing) && pricedInCoin && listing?.seller === creator && open;
  const wait = !graduated
    ? `The token has not graduated. The list button opens ${delayDays} days after it does.`
    : opensAt
      ? `The list button opens ${new Date(opensAt * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC")}.`
      : "The pool does not show when the token graduated, so the list button stays closed.";

  async function send(transaction: Transaction) {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setError("");
    setGate(null);
    try {
      const signature = await sendPrepared(connection, await prepareTransaction(connection, publicKey, transaction, []), signTransaction);
      setDone(explorerTx(signature, pageCluster));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  function confirm(titleText: string, lines: string[], transaction: Transaction) {
    if (cluster === "mainnet-beta") setGate({ title: titleText, lines, transaction });
    else void send(transaction);
  }

  function list() {
    const amount = parseTokenAmount(price, decimals);
    if (!amount || !publicKey) {
      setError("Enter the price in the token.");
      return;
    }
    const transaction = new Transaction().add(
      listOnTensorInstruction({ title: new PublicKey(title), creator: publicKey, mint: new PublicKey(mint), price: amount }),
    );
    confirm(
      "List this title",
      [
        `Price: ${formatTokenAmount(amount, decimals)} ${symbol}, paid to your wallet.`,
        `The buyer pays about ${TENSOR_TAKER_FEE_PERCENT}% more. That fee goes to Tensor.`,
        noCoin
          ? "PAR takes none of this sale."
          : `You burn ${burn}% of what you receive, within ${CREATOR_BURN_DAYS} days.`,
        "The title moves into Tensor's listing until it sells or you take it down.",
      ],
      transaction,
    );
  }

  function buy() {
    if (!listing || !publicKey) return;
    const amount = BigInt(listing.amount);
    const transaction = buyOnTensorTransaction({
      title: new PublicKey(title),
      mint: new PublicKey(mint),
      seller: new PublicKey(listing.seller),
      buyer: publicKey,
      price: amount,
    });
    confirm(
      "Buy this title",
      [
        `You pay ${formatTokenAmount(buyerTotal(amount), decimals)} ${symbol}.`,
        `${formatTokenAmount(amount, decimals)} ${symbol} goes to the creator. The rest is Tensor's fee.`,
        "The title moves to your wallet.",
      ],
      transaction,
    );
  }

  function delist() {
    if (!publicKey) return;
    const transaction = new Transaction().add(delistOnTensorInstruction({ title: new PublicKey(title), creator: publicKey }));
    confirm("Take the listing down", ["The title returns to your wallet. Nobody can buy it until you list it again."], transaction);
  }

  if (cluster !== pageCluster) {
    return <p className="error">Switch the network toggle to {pageCluster === "devnet" ? "Devnet" : "Mainnet"} before signing on this page.</p>;
  }

  return (
    <div className="record-promises">
      <p className="eyebrow">This page</p>
      {listing && pricedInCoin ? (
        <p className="note">
          Listed for {formatTokenAmount(BigInt(listing.amount), decimals)} {symbol}. A buyer pays {formatTokenAmount(buyerTotal(BigInt(listing.amount)), decimals)}{" "}
          {symbol}. Tensor keeps the extra {TENSOR_TAKER_FEE_PERCENT}%.
        </p>
      ) : listing ? (
        <p className="error">This listing is not priced in {symbol}.</p>
      ) : (
        <p className="note">
          {open
            ? noCoin
              ? "Tensor pays you the full price in the token already on this title. PAR takes none of this sale."
              : "The sale is open. The creator lists the title here, through Tensor's program."
            : wait}
        </p>
      )}
      {holdsTitle && isCreator && open ? (
        <label>
          Price in {symbol}
          <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" />
        </label>
      ) : null}
      <div className="asset-nav">
        {holdsTitle && isCreator && open ? (
          <button type="button" className="solid" disabled={busy} onClick={list}>
            {busy ? "Listing…" : "List on this page"}
          </button>
        ) : null}
        {canBuy && wallet !== creator ? (
          <button type="button" className="solid" disabled={busy || !wallet} onClick={buy}>
            {busy ? "Buying…" : `Buy for ${formatTokenAmount(buyerTotal(BigInt(listing?.amount || "0")), decimals)} ${symbol}`}
          </button>
        ) : null}
        {listing && isCreator && listing.seller === creator ? (
          <button type="button" disabled={busy} onClick={delist}>
            {busy ? "Working…" : "Take the listing down"}
          </button>
        ) : null}
      </div>
      {!wallet && listing && !open ? <p className="note">Connect the creator wallet to take this listing down.</p> : null}
      {!wallet && !listing && holdsTitle ? <p className="note">Connect the creator wallet to list it.</p> : null}
      {!wallet && canBuy ? <p className="note">Connect a wallet to buy it.</p> : null}
      {canBuy && wallet === creator ? <p className="note">Your listing is up. A different wallet buys it.</p> : null}
      {listing && !open ? <p className="error">This listing is early. Buying stays closed on this page until the sale opens.</p> : null}
      {done.startsWith("http") ? (
        <p className="note">
          <a href={done} target="_blank" rel="noreferrer">
            Confirmed. See the transaction.
          </a>
        </p>
      ) : done ? (
        <p className="note">{done}</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {gate ? (
        <MainnetGate
          title={gate.title}
          lines={gate.lines}
          confirmLabel="Open wallet"
          onCancel={() => setGate(null)}
          onConfirm={() => void send(gate.transaction)}
        />
      ) : null}
    </div>
  );
}
