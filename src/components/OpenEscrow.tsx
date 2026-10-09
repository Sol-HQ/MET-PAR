"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { readClassicMint, type PayFacts } from "@/lib/coin-read";
import { useCluster } from "@/lib/cluster";
import { USDC_DEVNET, USDC_MAINNET, WSOL, explorerTx, type ClusterName } from "@/lib/constants";
import { prepareTransaction, sendPrepared } from "@/lib/send";
import { formatTokenAmount, parseTokenAmount } from "@/lib/tensor-sale";
import { ESCROW_PATH, ESCROW_PROGRAM, SALE_PROGRAM_FEE_PERCENT, escrowDepositAllowed, escrowDepositOpenInstruction } from "@/lib/title";

type Row = { wallet: string; amount: string };

const EMPTY: Row[] = [
  { wallet: "", amount: "" },
  { wallet: "", amount: "" },
  { wallet: "", amount: "" },
];

export function NoCoinChoice({
  escrow,
  tensor,
  pageCluster,
}: {
  escrow: ReactNode;
  tensor: ReactNode;
  pageCluster: ClusterName;
}) {
  const escrowOpen = pageCluster === "devnet";
  const [path, setPath] = useState<"escrow" | "tensor" | null>(null);
  return (
    <>
      <p className="note">Choose one way to sell this title. The other form stays closed until you switch.</p>
      <div className="segmented" role="group" aria-label="How this title sells">
        <button
          type="button"
          aria-pressed={path === "escrow"}
          disabled={!escrowOpen}
          className={escrowOpen ? undefined : "fuzzed"}
          onClick={() => setPath("escrow")}
        >
          Escrow
          {escrowOpen ? null : <span className="soon-stamp">Coming soon</span>}
        </button>
        <button type="button" aria-pressed={path === "tensor"} onClick={() => setPath("tensor")}>Tensor</button>
      </div>
      {path === null ? (
        <p className="note">
          {escrowOpen
            ? "Escrow holds the title. The sale is a fixed price or an auction. The bids run inside the program. A whole-percent burn from 0% to 98% happens in the program at the sale. The PAR program keeps 2%. Up to three extra wallets can be named. Tensor lists one price in the token already written on the title, and PAR takes none of that sale."
            : `You list this title through Tensor's marketplace program, at one price in the token already written on it. A buyer pays that price. Tensor pays you the full price. PAR takes none of that sale. A burn, if you promised one, is your own promise. ${ESCROW_PATH}`}
        </p>
      ) : null}
      {path === "escrow" ? escrow : null}
      {path === "tensor" ? tensor : null}
    </>
  );
}

export function OpenEscrow({
  pageCluster,
  title,
  record,
}: {
  pageCluster: ClusterName;
  title: string;
  record: string;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { cluster } = useCluster();
  const router = useRouter();
  const [mintInput, setMintInput] = useState("");
  const [pay, setPay] = useState<PayFacts | null>(null);
  const [note, setNote] = useState("");
  const [sale, setSale] = useState<"fixed" | "auction">("fixed");
  const [price, setPrice] = useState("");
  const [burn, setBurn] = useState("0");
  const [wait, setWait] = useState("0");
  const [rows, setRows] = useState<Row[]>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const allowed = escrowDepositAllowed(pageCluster, publicKey?.toBase58());
  const program = ESCROW_PROGRAM[pageCluster];
  const ready = terms(pay, price, burn, wait, rows, publicKey?.toBase58() ?? "");

  async function loadMint(mint = mintInput) {
    setPay(null);
    setError("");
    setNote("Reading the token…");
    try {
      const read = await readClassicMint(connection, mint);
      setPay(read);
      setMintInput(read.mint);
      setNote(`${read.name} (${read.symbol}), ${read.decimals} decimals. This token can be used.`);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Could not read that token.");
    }
  }

  function patchRow(index: number, partial: Partial<Row>) {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...partial } : row)));
  }

  async function deposit() {
    if (!publicKey || !signTransaction || !pay || !program || ready.error || !ready.raw) return;
    setBusy(true);
    setError("");
    try {
      const transaction = new Transaction().add(
        escrowDepositOpenInstruction({
          program: new PublicKey(program),
          creator: publicKey,
          title: new PublicKey(title),
          record: new PublicKey(record),
          mint: new PublicKey(pay.mint),
          price: ready.raw,
          delayDays: ready.delayDays,
          burnPercent: ready.burnPercent,
          sale,
          payouts: ready.payouts,
        }),
      );
      const prepared = await prepareTransaction(connection, publicKey, transaction, []);
      const signature = await sendPrepared(connection, prepared, signTransaction, "The sale escrow is open.");
      setNote(explorerTx(signature, pageCluster));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not finish.");
    } finally {
      setBusy(false);
    }
  }

  if (pageCluster !== "devnet" || !program) {
    return <p className="note">The escrow path is not a mainnet option yet. Coming soon.</p>;
  }
  if (cluster !== pageCluster) {
    return <p className="error">Switch the network toggle to Devnet before signing on this page.</p>;
  }

  return (
    <form className="record-promises" onSubmit={(event) => { event.preventDefault(); void deposit(); }}>
      <p className="eyebrow">1. Token</p>
      <p className="note">
        Name the token the buyer pays. USDC and SOL are filled in. Any other ordinary SPL token can be read. Token-2022 stops here.
        The PAR program keeps {SALE_PROGRAM_FEE_PERCENT}% of the price. That does not move.
      </p>
      {!allowed ? <p className="note">Connect the me wallet or the pa wallet to test the escrow path.</p> : null}
      <div className="segmented" role="group" aria-label="Payment token">
        <button type="button" onClick={() => void loadMint(pageCluster === "devnet" ? USDC_DEVNET : USDC_MAINNET)}>USDC</button>
        <button type="button" onClick={() => void loadMint(WSOL)}>SOL</button>
      </div>
      <label>
        Token address
        <input value={mintInput} onChange={(event) => { setMintInput(event.target.value.trim()); setPay(null); }} spellCheck={false} />
      </label>
      <button type="button" onClick={() => void loadMint()}>Read this token</button>
      {note ? <p className="note">{note.startsWith("http") ? <a href={note} target="_blank" rel="noreferrer">Confirmed. See the transaction.</a> : note}</p> : null}
      {pay ? (
        <>
          <label>Name<input value={pay.name} readOnly /></label>
          <label>Symbol<input value={pay.symbol} readOnly /></label>
          <label>Decimals<input value={String(pay.decimals)} readOnly /></label>
          <p className="eyebrow">2. Price and burn</p>
          <div className="segmented" role="group" aria-label="How the title sells">
            <button type="button" aria-pressed={sale === "fixed"} onClick={() => setSale("fixed")}>Fixed price</button>
            <button type="button" aria-pressed={sale === "auction"} onClick={() => setSale("auction")}>Auction</button>
          </div>
          <label>
            {sale === "auction" ? `Reserve, in ${pay.symbol}` : `Price, in ${pay.symbol}`}
            <input value={price} onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" />
          </label>
          <label>
            Burn, whole percent from 0 to 98
            <input value={burn} onChange={(event) => setBurn(event.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" />
            <span className="note">Zero burns nothing. 99 and above are refused. The 2% program share stays.</span>
          </label>
          <label>
            Days before the sale opens
            <input value={wait} onChange={(event) => setWait(event.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" />
            <span className="note">
              Zero opens the sale now. The highest is 365.
              {pageCluster === "devnet" ? " On the practice network each of these days is one second." : ""}
            </span>
          </label>
        </>
      ) : (
        <p className="note">Read a token before the price, the burn, and the extra wallets.</p>
      )}
      {pay && ready.termsOk ? (
        <>
          <p className="eyebrow">3. Extra wallets</p>
          <p className="note">Optional. Fill from the first row. A blank row ends the list. Your own wallet already receives what is left, so leave it out. Each amount is a fixed piece of this token, not a percent.</p>
          {rows.map((row, index) => (
            <div key={index}>
              <label>
                Extra wallet {index + 1}
                <input value={row.wallet} onChange={(event) => patchRow(index, { wallet: event.target.value.trim() })} spellCheck={false} />
              </label>
              <label>
                Amount in {pay.symbol}
                <input value={row.amount} onChange={(event) => patchRow(index, { amount: event.target.value.replace(/[^\d.]/g, "") })} inputMode="decimal" />
              </label>
            </div>
          ))}
          <dl className="quote-slip">
            {ready.lines.map((line) => (
              <div key={line.label}>
                <dt>{line.label}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {ready.error ? <p className="error">{ready.error}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {pay ? (
        <button type="submit" className="solid" disabled={busy || !allowed || Boolean(ready.error)}>
          {busy ? "Working…" : "Put the title in the escrow"}
        </button>
      ) : null}
    </form>
  );
}

function terms(
  pay: PayFacts | null,
  price: string,
  burn: string,
  wait: string,
  rows: Row[],
  creator: string,
): {
  error: string;
  termsOk: boolean;
  raw: bigint | null;
  burnPercent: number;
  delayDays: number;
  payouts: { wallet: PublicKey; amount: bigint }[];
  lines: { label: string; value: string }[];
} {
  const empty = { error: "", termsOk: false, raw: null, burnPercent: 0, delayDays: 0, payouts: [] as { wallet: PublicKey; amount: bigint }[], lines: [] as { label: string; value: string }[] };
  if (!pay) return empty;
  if (!/^\d+$/.test(burn) || Number(burn) > 98) {
    return { ...empty, error: "Type the burn. It is a whole percent from 0 to 98. Zero burns nothing." };
  }
  if (!/^\d+$/.test(wait) || Number(wait) > 365) {
    return { ...empty, error: "Type the wait. Zero opens the sale now. The highest is 365." };
  }
  const raw = parseTokenAmount(price, pay.decimals);
  if (!raw) {
    return { ...empty, error: `Type the price in ${pay.symbol}. This token uses ${pay.decimals} decimals.` };
  }
  const burnPercent = Number(burn);
  const delayDays = Number(wait);
  const payouts: { wallet: PublicKey; amount: bigint }[] = [];
  const seen = new Set<string>();
  let closed = false;
  for (const row of rows) {
    const blank = !row.wallet.trim() && !row.amount.trim();
    if (blank) {
      closed = true;
      continue;
    }
    if (closed) {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: "Fill the extra wallets from the top. A blank row ends the list." };
    }
    if (!row.wallet.trim() || !row.amount.trim()) {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: "Each extra wallet needs an address and an amount, or leave the row blank." };
    }
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(row.wallet.trim());
    } catch {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: "One of the extra wallets is not an address." };
    }
    if (creator && wallet.toBase58() === creator) {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: "Your wallet already receives what is left. Leave it out of the extra rows." };
    }
    if (seen.has(wallet.toBase58())) {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: "That wallet is already named. Use it once." };
    }
    const amount = parseTokenAmount(row.amount, pay.decimals);
    if (!amount) {
      return { ...empty, termsOk: true, raw, burnPercent, delayDays, error: `That amount does not fit ${pay.symbol}. It uses ${pay.decimals} decimals.` };
    }
    seen.add(wallet.toBase58());
    payouts.push({ wallet, amount });
  }
  const fee = (raw * BigInt(SALE_PROGRAM_FEE_PERCENT * 100)) / BigInt(10000);
  const burned = (raw * BigInt(burnPercent * 100)) / BigInt(10000);
  const named = payouts.reduce((sum, row) => sum + row.amount, BigInt(0));
  const show = (amount: bigint) => `${formatTokenAmount(amount, pay.decimals)} ${pay.symbol}`;
  const lines = [
    { label: "Price", value: show(raw) },
    { label: "Program", value: `${show(fee)}. This 2% does not move.` },
    { label: "Burn", value: show(burned) },
    ...payouts.map((row, index) => ({ label: `Wallet ${index + 1}`, value: `${show(row.amount)} to ${row.wallet.toBase58()}` })),
  ];
  if (fee + burned + named > raw) {
    return { ...empty, termsOk: true, raw, burnPercent, delayDays, payouts, lines, error: "The 2% program fee, the burn, and the named amounts are more than the price." };
  }
  lines.push({ label: "You receive", value: show(raw - fee - burned - named) });
  return { error: "", termsOk: true, raw, burnPercent, delayDays, payouts, lines };
}
