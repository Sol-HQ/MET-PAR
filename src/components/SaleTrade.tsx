"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useClusterWallet } from "@/lib/cluster-wallet";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { readPayToken, type PayFacts } from "@/lib/coin-read";
import { WSOL, explorerTx, quoteMintAddress, type ClusterName } from "@/lib/constants";
import { landingCost, prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";
import {
  buyOnTensorTransaction,
  buyerTotal,
  delistOnTensorInstruction,
  formatTokenAmount,
  listOnTensorInstruction,
  parseTokenAmount,
} from "@/lib/tensor-sale";
import { CREATOR_BURN_DAYS, TENSOR_TAKER_FEE_PERCENT } from "@/lib/title";
import { planTokenPayment } from "@/lib/token-pay";

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
  collection = null,
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
  collection?: string | null;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useClusterWallet();
  const { cluster } = useCluster();
  const router = useRouter();
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ title: string; lines: string[]; prepared: PreparedTransaction; landed: string } | null>(null);
  // The title's own token: the coin, or the token a no-coin title names. It is the default, not the only choice.
  const ownPay: PayFacts = { mint, name: symbol, symbol, decimals };
  // The token this listing will be priced in. Read on this network (decimals, symbol, token program) before listing.
  const [listPay, setListPay] = useState<PayFacts>(ownPay);
  const [otherMint, setOtherMint] = useState("");
  const [payNote, setPayNote] = useState("");
  // The token the live listing is priced in, read from Tensor's list state, never assumed.
  const [listingPay, setListingPay] = useState<PayFacts | null>(null);
  const [listingPayError, setListingPayError] = useState("");
  const currency = listing?.currency ?? null;
  useEffect(() => {
    let live = true;
    setListingPay(null);
    setListingPayError("");
    if (!currency) return;
    readPayToken(connection, currency)
      .then((read) => {
        if (live) setListingPay(read);
      })
      .catch((cause: unknown) => {
        if (live) setListingPayError(cause instanceof Error ? cause.message : "The listing's token could not be read.");
      });
    return () => {
      live = false;
    };
  }, [connection, currency]);

  const opensAt = finishedAt > 0 ? finishedAt + delayDays * 86_400 : 0;
  const open = noCoin || (graduated && opensAt > 0 && Math.floor(Date.now() / 1000) >= opensAt);
  const wallet = publicKey?.toBase58() ?? "";
  const isCreator = wallet === creator;
  const collectionKey = collection ? new PublicKey(collection) : null;
  const canBuy = Boolean(listing) && Boolean(listingPay) && listing?.seller === creator && open;
  const shown = (amount: bigint, pay: PayFacts) => `${formatTokenAmount(amount, pay.decimals)} ${pay.symbol}`;

  async function choosePay(next: string) {
    setPayNote("Reading the token…");
    try {
      const read = await readPayToken(connection, next);
      setListPay(read);
      setPayNote(`${read.name} (${read.symbol}), ${read.decimals} decimals, read on this network.`);
    } catch (cause) {
      setPayNote(cause instanceof Error ? cause.message : "Could not read that token.");
    }
  }
  const wait = !graduated
    ? `The list button opens ${delayDays} days after the token graduates.`
    : opensAt
      ? `The list button opens ${new Date(opensAt * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC")}.`
      : "The pool does not show when the token graduated, so the list button stays closed.";

  async function send(prepared: PreparedTransaction, landed: string) {
    if (!signTransaction) return;
    setBusy(true);
    setError("");
    setGate(null);
    try {
      const signature = await sendPrepared(connection, prepared, signTransaction, landed);
      setDone(explorerTx(signature, pageCluster));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(titleText: string, lines: string[], transaction: Transaction) {
    if (!publicKey) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      if (cluster === "mainnet-beta") {
        setGate({ title: titleText, lines: [...lines, landingCost(prepared)], prepared, landed: `${titleText}.` });
        return;
      }
      if (!signTransaction) return;
      const signature = await sendPrepared(connection, prepared, signTransaction, `${titleText}.`);
      setDone(explorerTx(signature, pageCluster));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  function list() {
    const amount = parseTokenAmount(price, listPay.decimals);
    if (!amount || !publicKey) {
      setError(`Enter the price in ${listPay.symbol}. It uses ${listPay.decimals} decimals.`);
      return;
    }
    const transaction = new Transaction().add(
      listOnTensorInstruction({
        title: new PublicKey(title),
        creator: publicKey,
        mint: new PublicKey(listPay.mint),
        price: amount,
        collection: collectionKey,
      }),
    );
    confirm(
      "List this title",
      [
        `Price: ${shown(amount, listPay)}, paid to your wallet in ${listPay.symbol}.`,
        `Price token: ${listPay.mint}.`,
        `The buyer pays about ${TENSOR_TAKER_FEE_PERCENT}% more. That fee goes to Tensor.`,
        noCoin
          ? "PAR takes none of this sale."
          : `You burn ${burn}% of what you receive, within ${CREATOR_BURN_DAYS} days.`,
        "The title moves into Tensor's listing until it sells or you take it down.",
      ],
      transaction,
    );
  }

  async function buy() {
    if (!listing || !publicKey || !listingPay) return;
    const amount = BigInt(listing.amount);
    const mintKey = new PublicKey(listingPay.mint);
    const total = buyerTotal(amount);
    let plan;
    try {
      // Read on this page's connection, which is the page's network (the guard below refuses any other).
      plan = await planTokenPayment(connection, mintKey, publicKey, total);
    } catch {
      setError(`Your ${listingPay.symbol} balance could not be read. Nothing was signed.`);
      return;
    }
    if (plan.short > BigInt(0)) {
      setError(
        plan.wrappedSol
          ? `This needs ${shown(total, listingPay)} plus network fees. Your wallet is short by ${shown(plan.short, listingPay)}. Nothing was signed.`
          : `This needs ${shown(total, listingPay)}. Your wallet holds ${shown(plan.held, listingPay)}. Nothing was signed.`,
      );
      return;
    }
    const transaction = buyOnTensorTransaction({
      title: new PublicKey(title),
      mint: mintKey,
      seller: new PublicKey(listing.seller),
      buyer: publicKey,
      price: amount,
      collection: collectionKey,
      wrappedSolShortfall: plan.wrap,
      tokenProgram: plan.tokenProgram,
      closeWrappedAfter: plan.wrappedSol && !plan.existed,
    });
    void confirm(
      "Buy this title",
      [
        `You pay ${shown(total, listingPay)}.`,
        `${shown(amount, listingPay)} goes to the creator. ${shown(total - amount, listingPay)} is Tensor's ${TENSOR_TAKER_FEE_PERCENT}% fee.`,
        ...(plan.wrap > BigInt(0)
          ? [`${formatTokenAmount(plan.wrap, listingPay.decimals)} SOL is wrapped into your wrapped-SOL account first, in the same transaction. Tensor is paid from that account.`]
          : []),
        ...(plan.wrappedSol && !plan.existed ? ["The wrapped-SOL account opened for this buy is closed after it, so its rent comes back."] : []),
        "If the creator or Tensor's fee vault has no account for this token yet, Tensor opens it inside the buy and your wallet pays its rent (about 0.003 SOL in a mainnet test). That rent is not in the account rent line below.",
        "The title moves to your wallet.",
      ],
      transaction,
    );
  }

  function delist() {
    if (!publicKey) return;
    const transaction = new Transaction().add(
      delistOnTensorInstruction({ title: new PublicKey(title), creator: publicKey, collection: collectionKey }),
    );
    confirm("Take the listing down", ["The title returns to your wallet. Nobody can buy it until you list it again."], transaction);
  }

  if (cluster !== pageCluster) {
    return <p className="error">Switch the network toggle to {pageCluster === "devnet" ? "Devnet" : "Mainnet"} before signing on this page.</p>;
  }

  return (
    <div className="record-promises">
      <p className="eyebrow">This page</p>
      {listing && listingPay ? (
        <p className="note">
          Listed for {shown(BigInt(listing.amount), listingPay)}. A buyer pays {shown(buyerTotal(BigInt(listing.amount)), listingPay)}. Tensor keeps the extra{" "}
          {TENSOR_TAKER_FEE_PERCENT}%.{listingPay.mint !== mint ? ` This listing is priced in ${listingPay.symbol}, not ${symbol}.` : ""}
        </p>
      ) : listing && !currency ? (
        <p className="error">This listing is priced in native SOL by a tool other than this page. Buy it on Tensor.</p>
      ) : listing ? (
        <p className={listingPayError ? "error" : "note"}>{listingPayError || "Reading the listing's token…"}</p>
      ) : (
        <p className="note">
          {open
            ? noCoin
              ? "Tensor pays you the full price in the token already on this title. PAR takes none of this sale."
              : "The sale is open. The creator lists the title here, through Tensor's program."
            : wait}
        </p>
      )}
      {holdsTitle && isCreator && open && !listing ? (
        <>
          <div className="segmented" role="group" aria-label="Price token">
            <button type="button" aria-pressed={listPay.mint === mint} onClick={() => { setListPay(ownPay); setPayNote(""); }}>{symbol}</button>
            {mint !== WSOL ? <button type="button" aria-pressed={listPay.mint === WSOL} onClick={() => void choosePay(WSOL)}>SOL</button> : null}
            {mint !== quoteMintAddress(pageCluster, "usdc").toBase58() ? (
              <button type="button" aria-pressed={listPay.mint === quoteMintAddress(pageCluster, "usdc").toBase58()} onClick={() => void choosePay(quoteMintAddress(pageCluster, "usdc").toBase58())}>USDC</button>
            ) : null}
          </div>
          <label>
            Or another token address
            <input value={otherMint} onChange={(event) => setOtherMint(event.target.value.trim())} spellCheck={false} />
          </label>
          <button type="button" disabled={!otherMint} onClick={() => void choosePay(otherMint)}>Read this token</button>
          {payNote ? <p className="note">{payNote}</p> : null}
          <label>
            Price in {listPay.symbol}
            <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" />
          </label>
        </>
      ) : null}
      <div className="asset-nav">
        {noCoin && holdsTitle && isCreator && open ? (
          <p className="note">No coin is attached. You can list this title, and you can delist it. Delist returns the title to your wallet. You can list it again.</p>
        ) : null}
        {holdsTitle && isCreator && open && !listing ? (
          <button type="button" className="solid" disabled={busy} onClick={list}>
            {busy ? "Listing…" : "List on this page"}
          </button>
        ) : null}
        {canBuy && wallet !== creator ? (
          <button type="button" className="solid" disabled={busy || !wallet} onClick={() => void buy()}>
            {busy ? "Buying…" : `Buy for ${listingPay ? shown(buyerTotal(BigInt(listing?.amount || "0")), listingPay) : "…"}`}
          </button>
        ) : null}
        {listing && isCreator && listing.seller === creator ? (
          <button type="button" disabled={busy} onClick={delist}>
            {busy ? "Working…" : noCoin ? "Delist" : "Take the listing down"}
          </button>
        ) : null}
      </div>
      {noCoin && listing && isCreator ? (
        <p className="note">No coin is attached. Delist returns this title to your wallet. You can list it again.</p>
      ) : null}
      {!wallet && listing && !open ? <p className="note">Connect the creator wallet to take this listing down.</p> : null}
      {!wallet && !listing && holdsTitle ? <p className="note">Connect the creator wallet to list it.</p> : null}
      {!wallet && canBuy ? <p className="note">Connect a wallet to buy it.</p> : null}
      {canBuy && wallet === creator ? <p className="note">Your listing is up. A different wallet buys it.</p> : null}
      {listing && !open ? <p className="error">This listing is early. Buying stays closed on this page until the sale opens.</p> : null}
      {done.startsWith("http") ? (
        <>
          <p className="status" role="status">
            Transaction complete.{" "}
            <a href={done} target="_blank" rel="noreferrer">
              View the transaction
            </a>
          </p>
        </>
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
          onConfirm={() => void send(gate.prepared, gate.landed)}
        />
      ) : null}
    </div>
  );
}
