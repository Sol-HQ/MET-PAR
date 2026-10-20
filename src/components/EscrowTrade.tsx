"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useClusterWallet } from "@/lib/cluster-wallet";
import { PublicKey, Transaction } from "@solana/web3.js";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { explorerTx, type ClusterName } from "@/lib/constants";
import { landingCost, prepareTransaction, sendPrepared } from "@/lib/send";
import { formatTokenAmount, parseTokenAmount } from "@/lib/tensor-sale";
import { escrowOpenLine } from "@/lib/escrow-card";
import { escrowBidInstruction, escrowBuyInstruction, escrowSetPriceInstruction, markGraduatedInstruction, SALE_PROGRAM_FEE_PERCENT, type SaleMode } from "@/lib/title";
import { openTokenAccount, paymentInstructions, planTokenPayment, type TokenPayPlan } from "@/lib/token-pay";

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
  decimals,
  payees = [],
  collection = null,
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
  /** Read from the price mint on this network. The page hides this panel when it cannot read them. */
  decimals: number;
  payees?: { wallet: string; amount: string }[];
  /** The title's collection. Every title the app mints now has one; older escrow titles do not. */
  collection?: string | null;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useClusterWallet();
  const { cluster } = useCluster();
  const router = useRouter();
  const [bid, setBid] = useState("");
  const [nextPrice, setNextPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [gate, setGate] = useState<{ title: string; lines: string[]; transaction: Transaction; landed: string } | null>(null);
  const showAmount = (amount: bigint) => formatTokenAmount(amount, decimals);
  const readAmount = (text: string) => parseTokenAmount(text, decimals);

  const reserve = BigInt(price);
  const leading = BigInt(highBid);
  const parts = split(reserve, burnPercent);
  const assigned = payees.reduce((sum, row) => sum + BigInt(row.amount), BigInt(0));
  const creatorPaid = parts.paid > assigned ? parts.paid - assigned : BigInt(0);
  const opensAt = graduatedAt > 0 ? graduatedAt + delaySeconds : 0;
  const now = Math.floor(Date.now() / 1000);
  const open = opensAt > 0 && now >= opensAt;
  const needsMark = curveFull && graduatedAt === 0;
  const clockOver = sale === "auction" && endsAt > 0 && now >= endsAt;

  const collectionKey = collection ? new PublicKey(collection) : null;
  // A listing with no pool is a no-coin sale; the program then reads its payout account on every sale.
  const openSale = pool === PublicKey.default.toBase58();

  /** Plans the payment in the listing's price token, wrapping SOL only when that token is wrapped SOL. */
  async function plan(need: bigint): Promise<TokenPayPlan> {
    if (!publicKey) throw new Error("Connect a wallet.");
    const read = await planTokenPayment(connection, new PublicKey(mint), publicKey, need);
    if (read.short > BigInt(0)) {
      throw new Error(
        read.wrappedSol
          ? `This needs ${showAmount(need)} ${symbol} plus network fees. Your wallet is short by ${showAmount(read.short)} SOL. Nothing was signed.`
          : `This needs ${showAmount(need)} ${symbol}. Your wallet holds ${showAmount(read.held)} ${symbol}. Nothing was signed.`,
      );
    }
    return read;
  }

  function wrapLines(read: TokenPayPlan): string[] {
    return [
      ...(read.wrap > BigInt(0) ? [`${showAmount(read.wrap)} SOL is wrapped into your wrapped-SOL account first, in the same transaction.`] : []),
      ...(read.wrappedSol && !read.existed ? ["That wrapped-SOL account is closed again after the buy, so its rent comes back."] : []),
    ];
  }

  async function send(transaction: Transaction, landed: string) {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setError("");
    setGate(null);
    try {
      const signature = await sendPrepared(connection, await prepareTransaction(connection, publicKey, transaction, []), signTransaction, landed);
      setDone(explorerTx(signature, pageCluster));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  function confirm(titleText: string, lines: string[], transaction: Transaction) {
    const landed = `${titleText}.`;
    if (cluster === "mainnet-beta") setGate({ title: titleText, lines, transaction, landed });
    else void send(transaction, landed);
  }

  async function mark() {
    if (!publicKey) return;
    const transaction = new Transaction().add(
      markGraduatedInstruction(new PublicKey(program), new PublicKey(title), new PublicKey(pool)),
    );
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Mark graduation", [`Network: ${pageCluster}`, `Title: ${title}`, landingCost(prepared), "Quote token spent: 0"], prepared.transaction);
  }

  async function buy() {
    if (!publicKey) return;
    const read = await plan(reserve);
    const owner = read.tokenProgram;
    const mintKey = new PublicKey(mint);
    const creatorKey = new PublicKey(creator);
    const treasury = new PublicKey(PLATFORM_FEE_CLAIMER);
    const named = payees.map((row) => ({ wallet: new PublicKey(row.wallet), amount: BigInt(row.amount) }));
    const pay = paymentInstructions(read, publicKey);
    const transaction = new Transaction().add(
      ...pay.before,
      openTokenAccount(publicKey, creatorKey, mintKey, owner),
      openTokenAccount(publicKey, treasury, mintKey, owner),
      ...named.map((row) => openTokenAccount(publicKey, row.wallet, mintKey, owner)),
      escrowBuyInstruction({
        program: new PublicKey(program),
        buyer: publicKey,
        creator: creatorKey,
        title: new PublicKey(title),
        mint: mintKey,
        tokenProgram: owner,
        price: reserve,
        openSale,
        payees: named.map((row) => row.wallet),
        collection: collectionKey,
      }),
      ...pay.after,
    );
    const assigned = named.reduce((sum, row) => sum + row.amount, BigInt(0));
    const creatorPaid = parts.paid > assigned ? parts.paid - assigned : BigInt(0);
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Buy this title", [
      `You pay ${showAmount(reserve)} ${symbol}.`,
      ...(parts.burned > BigInt(0) ? [`${showAmount(parts.burned)} ${symbol} is burned.`] : []),
      ...named.map((row) => `${showAmount(row.amount)} ${symbol} goes to ${row.wallet.toBase58()}.`),
      `${showAmount(creatorPaid)} ${symbol} goes to the creator.`,
      `${showAmount(parts.fee)} ${symbol} goes to the PAR program.`,
      ...wrapLines(read),
      "The title moves to your wallet.",
      landingCost(prepared),
    ], prepared.transaction);
  }

  async function changePrice() {
    if (!publicKey) return;
    const next = readAmount(nextPrice);
    if (!next) {
      setError("Type the new price in tokens.");
      return;
    }
    const nextParts = split(next, burnPercent);
    const assignedNow = payees.reduce((sum, row) => sum + BigInt(row.amount), BigInt(0));
    if (nextParts.paid < assignedNow) {
      setError("That price is too low. The 2% program fee, the burn, and the named wallets have to fit inside it.");
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
      `The price becomes ${showAmount(next)} ${symbol}.`,
      sale === "auction" ? "This is the reserve. It can change until the first bid." : "A fixed price can change until a buyer pays.",
      landingCost(prepared),
    ], prepared.transaction);
  }

  async function placeBid() {
    if (!publicKey) return;
    const amount = readAmount(bid);
    if (!amount || amount < reserve || (leading > BigInt(0) && amount <= leading)) {
      setError(leading > BigInt(0) ? `Bid more than ${showAmount(leading)} ${symbol}.` : `Bid at least ${showAmount(reserve)} ${symbol}.`);
      return;
    }
    // A raise by the leader only pulls the difference; anyone else pays the whole bid.
    const raising = leading > BigInt(0) && previousBidder === publicKey.toBase58();
    const read = await plan(raising ? amount - leading : amount);
    const owner = read.tokenProgram;
    const pay = paymentInstructions(read, publicKey);
    const transaction = new Transaction().add(
      ...pay.before,
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
    // The bid's coins stay in the escrow. A refund comes back to the wrapped-SOL account, so it is not closed here.
    const prepared = await prepareTransaction(connection, publicKey, transaction, []);
    confirm("Bid on this title", [
      `You bid ${showAmount(amount)} ${symbol}. The coins stay in the escrow until the clock ends.`,
      leading > BigInt(0) ? `The current bid is ${showAmount(leading)} ${symbol}. That bidder is repaid if you lead.` : "This is the first bid. It starts the clock.",
      ...(read.wrap > BigInt(0) ? [`${showAmount(read.wrap)} SOL is wrapped into your wrapped-SOL account first, in the same transaction.`] : []),
      ...(read.wrappedSol ? ["If you are outbid, the refund comes back as wrapped SOL in that account."] : []),
      landingCost(prepared),
    ], prepared.transaction);
  }

  const isCreator = publicKey?.toBase58() === creator;

  if (!program) return <p className="note">The escrow is not on this network.</p>;
  if (cluster !== pageCluster) {
    return <p className="error">Switch the network toggle to {pageCluster === "devnet" ? "Devnet" : "Mainnet"} before signing on this page.</p>;
  }

  return (
    <div className="record-promises">
      <p className="eyebrow">Escrow</p>
      <h2>Price on this title</h2>
      <p className="note">
        The price now is {showAmount(reserve)} {symbol}.
        {sale === "auction" ? " On an auction this number is the reserve." : ""}
      </p>
      {/* Changing the price is the creator's control. Buyers and visitors see nothing about it. */}
      {isCreator && leading > BigInt(0) ? (
        <p className="note">A bid of {showAmount(leading)} {symbol} is in, so you can no longer change this price.</p>
      ) : isCreator ? (
        <>
          <p className="note">
            {sale === "auction"
              ? "You listed this title. You can change the reserve until the first bid. A bid locks it."
              : "You listed this title. You can change the price until a buyer pays."}
          </p>
          <label>
            New price in {symbol}
            <input value={nextPrice} onChange={(event) => setNextPrice(event.target.value)} inputMode="decimal" />
            <button type="button" className="solid" disabled={busy} onClick={() => void changePrice().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The price was not changed."))}>
              {busy ? "Working…" : "Change the price"}
            </button>
          </label>
        </>
      ) : null}
      {needsMark ? (
        <p className="note">The curve is full. Graduation has not been marked, so the sale wait has not started.</p>
      ) : open ? (
        <p className="note">
          {sale === "auction"
            ? `The auction is open. The reserve is ${showAmount(reserve)} ${symbol}.${leading > BigInt(0) ? ` The bid is ${showAmount(leading)} ${symbol}.` : ""}`
            : escrowOpenLine({
                price: `${showAmount(reserve)} ${symbol}`,
                burned: parts.burned > BigInt(0) ? `${showAmount(parts.burned)} ${symbol}` : "",
                fee: showAmount(parts.fee),
                payees: payees.map((row) => ({ amount: showAmount(BigInt(row.amount)), wallet: row.wallet })),
                creator: showAmount(creatorPaid),
              })}
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
            {busy ? "Buying…" : `Buy for ${showAmount(reserve)} ${symbol}`}
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
          onConfirm={() => void send(gate.transaction, gate.landed)}
        />
      ) : null}
    </div>
  );
}
