import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { DBC_PROGRAM_ID, explorerAccount, rpcUrl, type ClusterName } from "@/lib/constants";
import { formatMoney } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";
import { readRecord } from "@/lib/record";
import { EscrowTrade } from "@/components/EscrowTrade";
import { SaleTrade } from "@/components/SaleTrade";
import { creatorSalePercent, ESCROW_PROGRAM, readListing, readTitle, SALE_PROGRAM_FEE_PERCENT, TENSOR_TAKER_FEE_PERCENT, titleStatus } from "@/lib/title";

const TOKEN_DECIMALS = 6;

function formatUnits(amount: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(amount / scale).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POOL_MIGRATED_AT = 305;
const POOL_FINISHED_AT = 344;

type Sheet = {
  image?: string;
  record?: {
    title?: { promises?: string[] };
    token?: { symbol?: string; pool?: string };
  };
};

async function poolSale(connection: Connection, pool: string): Promise<{ graduated: boolean; finishedAt: number } | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(pool), "confirmed");
    if (!info || info.owner.toBase58() !== DBC_PROGRAM_ID || info.data.length < POOL_FINISHED_AT + 8) return null;
    return { graduated: info.data[POOL_MIGRATED_AT] === 1, finishedAt: Number(info.data.readBigUInt64LE(POOL_FINISHED_AT)) };
  } catch {
    return null;
  }
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC");
}

function marketCap(price: string, supply: string): string {
  const cap = Number(price) * Number(supply);
  if (!Number.isFinite(cap) || cap <= 0) return "";
  return cap.toLocaleString("en-US", { maximumFractionDigits: cap >= 1 ? 2 : 6 });
}

function leftWords(seconds: number): string {
  if (seconds <= 0) return "The wait is over.";
  if (seconds < 90) return `${seconds} seconds left.`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes left.`;
  const days = Math.ceil(seconds / 86_400);
  return days === 1 ? "1 day left." : `${days} days left.`;
}

export default async function SalePage({
  params,
  searchParams,
}: {
  params: Promise<{ title: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { title: address } = await params;
  const cluster: ClusterName = (await searchParams).c === "devnet" ? "devnet" : "mainnet-beta";
  if (!ADDRESS.test(address)) {
    return (
      <section className="card">
        <h2>That is not a title address</h2>
      </section>
    );
  }
  const endpoint = rpcUrl(cluster);
  const connection = new Connection(endpoint, "confirmed");
  const title = await readTitle(endpoint, address);
  const recordAddress = title.attributes.record || "";
  const record = ADDRESS.test(recordAddress) ? await readRecord(endpoint, recordAddress) : null;
  const status =
    record?.exists && record.attributes.title === address
      ? await titleStatus(endpoint, cluster, { address: recordAddress, attributes: record.attributes })
      : null;

  let sheet: Sheet = {};
  if (title.uri.startsWith("https://")) {
    sheet = (await fetch(title.uri, { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))) as Sheet;
  }
  const pool = record?.attributes.pool || "";
  const sale = pool ? await poolSale(connection, pool) : null;
  const snapshot = pool ? await loadPool(connection, pool).catch(() => null) : null;
  const graduated = sale ? sale.graduated : null;
  const finishedAt = sale?.finishedAt ?? 0;
  const delay = Number.parseInt(title.attributes["sale opens"] || "", 10);
  const burn = Number.parseInt(title.attributes.burned || "", 10);
  const symbol = record?.attributes.symbol || "the token";
  const listing =
    status?.rail === "escrow" && ESCROW_PROGRAM[cluster]
      ? await readListing(connection, new PublicKey(ESCROW_PROGRAM[cluster]), new PublicKey(address)).catch(() => null)
      : null;
  const opensAt = listing && listing.graduatedAt > 0 ? listing.graduatedAt + listing.delaySeconds : 0;
  const curveOpensAt = finishedAt > 0 ? finishedAt + delay * 86_400 : 0;
  const waitSeconds = listing && listing.delaySeconds > 0 ? listing.delaySeconds : Number.isFinite(delay) ? delay * 86_400 : 0;
  const waitStart = listing && listing.graduatedAt > 0 ? listing.graduatedAt : finishedAt;
  const now = Math.floor(Date.now() / 1000);
  const waitGone = waitStart > 0 ? Math.min(waitSeconds, Math.max(0, now - waitStart)) : 0;
  const waitPercent = waitSeconds > 0 && waitStart > 0 ? Math.min(100, (waitGone / waitSeconds) * 100) : 0;
  const fill = snapshot && !snapshot.isMigrated ? Math.max(0, Math.min(100, snapshot.percent)) : snapshot?.isMigrated ? 100 : 0;
  const cap = snapshot ? marketCap(snapshot.price, snapshot.supply) : "";
  const saleOpen = Boolean(graduated) && curveOpensAt > 0 && Math.floor(Date.now() / 1000) >= curveOpensAt;

  const saleLine = !title.exists
    ? "This title is not on chain."
    : !Number.isFinite(delay) || !Number.isFinite(burn)
      ? "This title does not state its sale terms. Treat it as unverified."
    : graduated === null
      ? "The pool could not be read."
      : !graduated
        ? `The token has not graduated. The sale opens ${delay} ${cluster === "devnet" && status?.rail === "escrow" ? "seconds" : "days"} after it does.`
        : opensAt
          ? `The token graduated. The sale opens ${day(opensAt)}.`
          : saleOpen
            ? `The sale is open. It opened ${day(curveOpensAt)}.`
            : curveOpensAt
              ? `The token graduated on ${day(finishedAt)}. The sale opens ${day(curveOpensAt)}.`
              : `The token graduated. The sale opens ${delay} days after graduation.`;

  return (
    <section className="card record-create">
      <p className="eyebrow">Title sale</p>
      <h2>{title.name || "Unknown title"}</h2>
      {typeof sheet.image === "string" && sheet.image ? (
        <img src={sheet.image} alt={title.name} style={{ maxWidth: 320, borderRadius: 12 }} />
      ) : null}
      <p className="note">
        This coin is a payment token and a meme. It pays for this title. The meme is the joy and heart of the object. It is not a share, and it pays nothing.{" "}
        {status?.rail === "escrow"
          ? `The PAR escrow holds this title. A buyer calls that program and pays in ${symbol} only. `
          : `The creator lists this title on this page, through Tensor's program, paid in ${symbol} only. The listing may also show on Tensor's own site. `}
        {Number.isFinite(burn)
          ? status?.rail === "escrow"
            ? `${burn}% of the price is burned by the escrow, ${creatorSalePercent(burn)}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program. `
            : `The creator is paid the full price and promised to burn ${burn}% of it. `
          : ""}
        {saleLine}
      </p>
      {snapshot ? (
        <section className="quotes" aria-label="This coin">
          <article>
            <h2>Price</h2>
            <p className="figure">
              {snapshot.price} <span>{snapshot.quoteSymbol}</span>
            </p>
            <p className="note">The live curve price. The pool page is the full coin page.</p>
          </article>
          {cap ? (
            <article>
              <h2>Market cap</h2>
              <p className="figure">
                {cap} <span>{snapshot.quoteSymbol}</span>
              </p>
              <p className="note">Price times the whole supply.</p>
            </article>
          ) : null}
          <article>
            <h2>{snapshot.isMigrated ? "Graduated" : "Graduation"}</h2>
            <p className="figure">
              {fill.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              <span>%</span>
            </p>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${fill}%` }} />
            </div>
            <p className="note">
              {snapshot.isMigrated
                ? "The curve is full and the trading pool is open."
                : fill >= 40 && fill < 60
                  ? `About halfway. ${formatMoney(snapshot.raised, snapshot.quoteDecimals)} of ${formatMoney(snapshot.threshold, snapshot.quoteDecimals)} ${snapshot.quoteSymbol} is in the curve.`
                  : `${formatMoney(snapshot.raised, snapshot.quoteDecimals)} of ${formatMoney(snapshot.threshold, snapshot.quoteDecimals)} ${snapshot.quoteSymbol} is in the curve.`}
            </p>
          </article>
          {waitSeconds > 0 ? (
            <article>
              <h2>Sale wait</h2>
              <p className="figure">
                {waitStart > 0 ? waitPercent.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "0"}
                <span>%</span>
              </p>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${waitStart > 0 ? waitPercent : 0}%` }} />
              </div>
              <p className="note">
                {waitStart > 0
                  ? leftWords(waitSeconds - waitGone)
                  : `These ${delay} ${cluster === "devnet" && status?.rail === "escrow" ? "seconds" : "days"} start when the coin graduates. The title stays where it is until then.`}
              </p>
            </article>
          ) : null}
        </section>
      ) : null}
      {status?.tensor ? (
        <p className="note">
          Listed on Tensor for {formatUnits(status.tensor.amount, TOKEN_DECIMALS)}{" "}
          {status.tensor.currency === record?.attributes.mint ? symbol : "another currency"}. Tensor adds about{" "}
          {TENSOR_TAKER_FEE_PERCENT}% on the buyer&apos;s side.
        </p>
      ) : null}
      {status ? (
        <ul className="record-checks">
          <li className="ok">The record in the vault names this title</li>
          {status.checks.map((check) => (
            <li key={check.label} className={check.ok ? "ok" : "no"}>
              {check.label}
            </li>
          ))}
          {status.tensor ? (
            <li className={saleOpen ? "ok" : "no"}>
              {saleOpen ? "The sale is open" : "Listed before the sale could open"}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="error">No master in the program vault names this title. Treat it as unverified.</p>
      )}
      {status?.rail === "escrow" && listing && record?.attributes.mint && ESCROW_PROGRAM[cluster] ? (
        <EscrowTrade
          pageCluster={cluster}
          program={ESCROW_PROGRAM[cluster]}
          title={address}
          mint={record.attributes.mint}
          creator={listing.creator}
          pool={listing.pool}
          symbol={symbol}
          price={listing.price.toString()}
          burnPercent={listing.burnPercent}
          sale={listing.sale}
          graduatedAt={listing.graduatedAt}
          delaySeconds={listing.delaySeconds}
          highBid={listing.highBid.toString()}
          previousBidder={listing.highBidder}
          endsAt={listing.endsAt}
          curveFull={snapshot?.isMigrated === true}
        />
      ) : null}
      {status?.rail === "creator" && record?.attributes.mint ? (
        <SaleTrade
          pageCluster={cluster}
          title={address}
          mint={record.attributes.mint}
          creator={record.attributes.creator}
          symbol={symbol}
          burn={Number.isFinite(burn) ? burn : 0}
          delayDays={Number.isFinite(delay) ? delay : 0}
          finishedAt={finishedAt}
          graduated={graduated === true}
          holdsTitle={status.owner === record.attributes.creator && !status.tensor}
          listing={
            status.tensor
              ? { amount: status.tensor.amount.toString(), currency: status.tensor.currency, seller: status.tensor.seller }
              : null
          }
        />
      ) : null}
      {sheet.record?.title?.promises?.length ? (
        <>
          <p className="eyebrow">What the creator signed</p>
          <ol className="record-lines">
            {sheet.record.title.promises.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </>
      ) : null}
      <p className="note">
        {status?.rail === "escrow"
          ? "A buyer calls the PAR escrow program from this page. "
          : "Listing and buying on this page both go through Tensor's program. "}
        {pool ? <Link href={`/pool/${pool}`}>Open the pool page</Link> : null}
        {pool ? " · " : null}
        <a href={explorerAccount(address, cluster)} target="_blank" rel="noreferrer">
          Title on the explorer
        </a>
        {recordAddress ? (
          <>
            {" · "}
            <a href={explorerAccount(recordAddress, cluster)} target="_blank" rel="noreferrer">
              Record on the explorer
            </a>
          </>
        ) : null}
        . PAR is software. It does not hold, insure, or guarantee the item.
      </p>
    </section>
  );
}
