"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { explorerTx, type ClusterName } from "@/lib/constants";
import { formatLamports } from "@/lib/format";
import { prepareTransaction, sendPrepared } from "@/lib/send";
import { formatTokenAmount, parseTokenAmount } from "@/lib/tensor-sale";
import { escrowBidInstruction, escrowBuyInstruction, escrowSetPriceInstruction, markGraduatedInstruction, SALE_PROGRAM_FEE_PERCENT, type SaleMode } from "@/lib/title";

function split(price: bigint, burnPercent: number): { paid: bigint; burned: bigint; fee: bigint } {
  const fee = (price * BigInt(SALE_PROGRAM_FEE_PERCENT * 100)) / BigInt(10000);
  const burned = (price * BigInt(Math.round(burnPercent * 100))) / BigInt(10000);
  return { paid: price - fee - burned, burned, fee };
}

export function EscrowTrade({
  pageCluster,
  program,
  title,
  mint,
  creator,
  pool,
  symbol,
  price,
  burnPercent,
  sale,
  graduatedAt,
  delaySeconds,
  highBid,
  previousBidder,
  endsAt,
  curveFull,
}: {
  pageCluster: ClusterName;
  program: string;
  title: string;
  mint: string;
  creator: string;
  pool: string;
  symbol: string;
  price: string;
  burnPercent: number;
  sale: SaleMode;
  graduatedAt: number;
  delaySeconds: number;
  highBid: string;
  previousBidder: string | null;
  endsAt: number;
  curveFull: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { cluster } = useCluster();
  const router = useRouter();
  const [bid, setBid] = useState("");
  const [nextPrice, setNextPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ title: string; lines: string[]; transaction: Transaction } | null>(null);

  const reserve = BigInt(price);
  const leading = BigInt(highBid);
  const parts = split(reserve, burnPercent);
  const opensAt = graduatedAt > 0 ? graduatedAt + delaySeconds : 0;
  const now = Math.floor(Date.now() / 1000);
  const open = opensAt > 0 && now >= opensAt;
  const needsMark = curveFull && graduatedAt === 0;
  const clockOver = sale === "auction" && endsAt > 0 && now >= endsAt;

  async function tokenProgram(): Promise<PublicKey> {
    const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
    if (!info) throw new Error("The coin mint is not on this network.");
    return info.owner;
  }

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

  async function mark() {
    if (!publicKey) return;
    const transaction = new Transaction().add(
      markGraduatedInstruction(new PublicKey(program), new PublicKey(title), new PublicKey(pool)),
    );
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Mark graduation", [`Network: ${pageCluster}`, `Title: ${title}`, `Network fee: ${formatLamports(prepared.feeLamports)}`, "Quote token spent: 0"], prepared.transaction);
  }

  async function buy() {
    if (!publicKey) return;
    const owner = await tokenProgram();
    const mintKey = new PublicKey(mint);
    const creatorKey = new PublicKey(creator);
    const treasury = new PublicKey(PLATFORM_FEE_CLAIMER);
    const ata = (holder: PublicKey) => getAssociatedTokenAddressSync(mintKey, holder, true, owner);
    const transaction = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(publicKey, ata(publicKey), publicKey, mintKey, owner),
      createAssociatedTokenAccountIdempotentInstruction(publicKey, ata(creatorKey), creatorKey, mintKey, owner),
      createAssociatedTokenAccountIdempotentInstruction(publicKey, ata(treasury), treasury, mintKey, owner),
      escrowBuyInstruction({
        program: new PublicKey(program),
        buyer: publicKey,
        creator: new PublicKey(creator),
        title: new PublicKey(title),
        mint: new PublicKey(mint),
        tokenProgram: owner,
        price: reserve,
      }),
    );
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Buy this title", [
      `You pay ${formatTokenAmount(reserve)} ${symbol}.`,
      `${formatTokenAmount(parts.burned)} ${symbol} is burned.`,
      `${formatTokenAmount(parts.paid)} ${symbol} goes to the creator.`,
      `${formatTokenAmount(parts.fee)} ${symbol} goes to the PAR program.`,
      "The title moves to your wallet.",
      `Network fee: ${formatLamports(prepared.feeLamports)}`,
    ], prepared.transaction);
  }

  async function changePrice() {
    if (!publicKey) return;
    const next = parseTokenAmount(nextPrice);
    if (!next) {
      setError("Type the new price in tokens.");
      return;
    }
    const transaction = new Transaction().add(
      escrowSetPriceInstruction({
        program: new PublicKey(program),
        creator: publicKey,
        title: new PublicKey(title),
        price: next,
      }),
    );
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Change the title price", [
      `The price becomes ${formatTokenAmount(next)} ${symbol}.`,
      sale === "auction" ? "This is the reserve. It can change until the first bid." : "A fixed price can change until a buyer pays.",
      `Network fee: ${formatLamports(prepared.feeLamports)}`,
    ], prepared.transaction);
  }

  async function placeBid() {
    if (!publicKey) return;
    const amount = parseTokenAmount(bid);
    if (!amount || amount < reserve || (leading > BigInt(0) && amount <= leading)) {
      setError(leading > BigInt(0) ? `Bid more than ${formatTokenAmount(leading)} ${symbol}.` : `Bid at least ${formatTokenAmount(reserve)} ${symbol}.`);
      return;
    }
    const owner = await tokenProgram();
    const transaction = new Transaction().add(
      escrowBidInstruction({
        program: new PublicKey(program),
        bidder: publicKey,
        title: new PublicKey(title),
        mint: new PublicKey(mint),
        tokenProgram: owner,
        amount,
        previousBidder: previousBidder ? new PublicKey(previousBidder) : null,
      }),
    );
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Bid on this title", [
      `You bid ${formatTokenAmount(amount)} ${symbol}. The coins stay in the escrow until the clock ends.`,
      leading > BigInt(0) ? `The current bid is ${formatTokenAmount(leading)} ${symbol}. That bidder is repaid if you lead.` : "This is the first bid. It starts the clock.",
      `Network fee: ${formatLamports(prepared.feeLamports)}`,
    ], prepared.transaction);
  }

  if (!program) return <p className="note">The escrow is not on this network.</p>;
  if (cluster !== pageCluster) {
    return <p className="error">Switch the network toggle to {pageCluster === "devnet" ? "Devnet" : "Mainnet"} before signing on this page.</p>;
  }

  return (
    <div className="record-promises">
      <p className="eyebrow">Escrow</p>
      <h2>Price on this title</h2>
      <p className="note">
        The price now is {formatTokenAmount(reserve)} {symbol}.
        {sale === "auction"
          ? " On an auction this number is the reserve. The creator can change it until the first bid. A bid locks it."
          : " On a fixed price the creator can change it until a buyer pays."}
      </p>
      {leading > BigInt(0) ? (
        <p className="note">A bid of {formatTokenAmount(leading)} {symbol} is in, so this price stays.</p>
      ) : publicKey?.toBase58() === creator ? (
        <label>
          New price in {symbol}
          <input value={nextPrice} onChange={(event) => setNextPrice(event.target.value)} inputMode="decimal" />
          <button type="button" className="solid" disabled={busy} onClick={() => void changePrice().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The price was not changed."))}>
            {busy ? "Working…" : "Change the price"}
          </button>
        </label>
      ) : (
        <p className="note">Connect the creator wallet to change this price. The box appears for that wallet.</p>
      )}
      {needsMark ? (
        <p className="note">The curve is full. Graduation has not been marked, so the sale wait has not started.</p>
      ) : open ? (
        <p className="note">
          {sale === "auction"
            ? `The auction is open. The reserve is ${formatTokenAmount(reserve)} ${symbol}.${leading > BigInt(0) ? ` The bid is ${formatTokenAmount(leading)} ${symbol}.` : ""}`
            : `The sale is open at ${formatTokenAmount(reserve)} ${symbol}. ${formatTokenAmount(parts.burned)} is burned, ${formatTokenAmount(parts.paid)} goes to the creator, and ${formatTokenAmount(parts.fee)} goes to the PAR program.`}
        </p>
      ) : (
        <p className="note">The buy stays closed until the sale wait ends.</p>
      )}
      {clockOver ? <p className="note">The bidding clock has ended. This site finishes the auction.</p> : null}
      <div className="asset-nav">
        {needsMark && publicKey ? (
          <button type="button" className="solid" disabled={busy} onClick={() => void mark().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Graduation was not marked."))}>
            {busy ? "Working…" : "Mark graduation"}
          </button>
        ) : null}
        {open && sale === "fixed" && !clockOver ? (
          <button type="button" className="solid" disabled={busy || !publicKey} onClick={() => void buy().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The buy was not sent."))}>
            {busy ? "Buying…" : `Buy for ${formatTokenAmount(reserve)} ${symbol}`}
          </button>
        ) : null}
      </div>
      {open && sale === "auction" && !clockOver ? (
        <label>
          Bid in {symbol}
          <input value={bid} onChange={(event) => setBid(event.target.value)} inputMode="decimal" />
          <button type="button" className="solid" disabled={busy || !publicKey} onClick={() => void placeBid().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The bid was not sent."))}>
            {busy ? "Bidding…" : "Place the bid"}
          </button>
        </label>
      ) : null}
      {!publicKey && (needsMark || (open && !clockOver)) ? <p className="note">Connect a wallet to {needsMark ? "mark graduation, " : ""}{sale === "auction" ? "bid" : "buy"}.</p> : null}
      {done.startsWith("http") ? (
        <p className="note">
          <a href={done} target="_blank" rel="noreferrer">
            Confirmed. See the transaction.
          </a>
        </p>
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
