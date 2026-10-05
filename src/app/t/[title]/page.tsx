import { getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { ObjectPicture } from "@/components/AssetOnPool";
import { EscrowTrade } from "@/components/EscrowTrade";
import { NoCoinChoice, OpenEscrow } from "@/components/OpenEscrow";
import { SaleTrade } from "@/components/SaleTrade";
import { DBC_PROGRAM_ID, explorerAccount, explorerTx, rpcUrl, type ClusterName } from "@/lib/constants";
import { formatMoney, shortAddress } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";
import { RECORD_VAULT, readRecord } from "@/lib/record";
import { readCopy } from "@/lib/record-copy";
import { creatorSalePercent, ESCROW_PROGRAM, readListing, readPayouts, readTitle, SALE_PROGRAM_FEE_PERCENT, TENSOR_TAKER_FEE_PERCENT, titleStatus } from "@/lib/title";

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
  name?: string;
  description?: string;
  image?: string;
  claim?: string;
  handoff?: string;
  promises?: string[];
  record?: {
    pitch?: string;
    object?: { story?: string; name?: string; kind?: string };
    claim?: { text?: string };
    redemption?: { handoff?: string; declaredValue?: string; declaredUnit?: string };
    title?: { promises?: string[] };
    token?: { symbol?: string; pool?: string };
  };
};

function writtenLines(sheet: Sheet): string[] {
  const lines = [
    sheet.description || "",
    sheet.claim ? `Claim: ${sheet.claim}` : "",
    sheet.handoff || "",
    ...(sheet.promises || []),
    sheet.record?.object?.story || "",
    sheet.record?.pitch || "",
    sheet.record?.claim?.text ? `Claim: ${sheet.record.claim.text}` : "",
    sheet.record?.redemption?.handoff || "",
    sheet.record?.redemption?.declaredValue
      ? `Declared value: ${sheet.record.redemption.declaredValue} ${sheet.record.redemption.declaredUnit || ""}`.trim()
      : "",
    ...(sheet.record?.title?.promises || []),
  ];
  return lines.map((line) => line.trim()).filter(Boolean);
}

async function firstSeen(connection: Connection, address: string): Promise<{ signature: string; at: number | null } | null> {
  if (!ADDRESS.test(address)) return null;
  try {
    let before: string | undefined;
    let found: { signature: string; at: number | null } | null = null;
    for (let page = 0; page < 4; page += 1) {
      const rows = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 1000, before });
      if (!rows.length) break;
      const last = rows[rows.length - 1];
      found = { signature: last.signature, at: last.blockTime ?? null };
      if (rows.length < 1000) break;
      before = last.signature;
    }
    return found;
  } catch {
    return null;
  }
}

function attributeList(heading: string, rows: Record<string, string>) {
  const entries = Object.entries(rows);
  if (!entries.length) return null;
  return (
    <>
      <h2>{heading}</h2>
      <p className="note">These lines are stored on the NFT. The explorer link at the bottom opens the same account. The words there should match these words.</p>
      <dl className="quote-slip">
        {entries.map(([key, value]) => (
          <div key={`${heading}-${key}`}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

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
  const stored = recordAddress ? await readCopy(cluster, recordAddress).catch(() => null) : null;
  if (stored) {
    try {
      sheet = JSON.parse(stored) as Sheet;
    } catch {
      sheet = { description: stored };
    }
  } else if (record?.uri?.startsWith("https://")) {
    sheet = (await fetch(record.uri, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))) as Sheet;
  }
  const prose = writtenLines(sheet);
  const [recordMint, titleMint] = await Promise.all([
    firstSeen(connection, recordAddress),
    firstSeen(connection, address),
  ]);
  const noCoin = record?.attributes.coin === "none";
  const pool = ADDRESS.test(record?.attributes.pool || "") ? record?.attributes.pool || "" : "";
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
  const openSale = listing?.pool === PublicKey.default.toBase58();
  const payees =
    openSale && ESCROW_PROGRAM[cluster]
      ? await readPayouts(connection, new PublicKey(ESCROW_PROGRAM[cluster]), new PublicKey(address)).catch(() => [])
      : [];
  const openDecimals = openSale && listing ? (await getMint(connection, new PublicKey(listing.mint), "confirmed").catch(() => null))?.decimals : undefined;
  const opensAt = listing && listing.graduatedAt > 0 ? listing.graduatedAt + listing.delaySeconds : 0;
  const curveOpensAt = finishedAt > 0 ? finishedAt + delay * 86_400 : 0;
  const leftEscrow = status?.rail === "escrow" && title.exists && Boolean(status.listing) && status.owner !== status.listing;
  const waitSeconds = leftEscrow
    ? 0
    : listing && listing.delaySeconds > 0
      ? listing.delaySeconds
      : Number.isFinite(delay)
        ? delay * (cluster === "devnet" && status?.rail === "escrow" ? 1 : 86_400)
        : 0;
  const waitStart = listing && listing.graduatedAt > 0 ? listing.graduatedAt : finishedAt;
  const now = Math.floor(Date.now() / 1000);
  const waitGone = waitStart > 0 ? Math.min(waitSeconds, Math.max(0, now - waitStart)) : 0;
  const waitPercent = waitSeconds > 0 && waitStart > 0 ? Math.min(100, (waitGone / waitSeconds) * 100) : 0;
  const fill = snapshot && !snapshot.isMigrated ? Math.max(0, Math.min(100, snapshot.percent)) : snapshot?.isMigrated ? 100 : 0;
  const cap = snapshot ? marketCap(snapshot.price, snapshot.supply) : "";
  const saleOpen = Boolean(graduated) && curveOpensAt > 0 && Math.floor(Date.now() / 1000) >= curveOpensAt;

  const saleLine = noCoin
    ? "The creator can list this title through Tensor, or put it in the escrow and name the token."
    : !title.exists
    ? "This title is not on chain."
    : !Number.isFinite(delay) || !Number.isFinite(burn)
      ? "This title does not state its sale terms. Treat it as unverified."
    : graduated === null
      ? "The pool could not be read."
      : !graduated
        ? `The token has not graduated. The sale opens ${delay} ${cluster === "devnet" && status?.rail === "escrow" ? "seconds" : "days"} after it does.`
        : leftEscrow
          ? "The sale finished. The title has left the escrow."
          : opensAt && now >= opensAt
            ? listing?.sale === "auction"
              ? `The auction is open. It opened ${day(opensAt)}.`
              : `The sale is open. It opened ${day(opensAt)}.`
            : opensAt
              ? `The token graduated. The sale opens ${day(opensAt)}.`
              : saleOpen
            ? `The sale is open. It opened ${day(curveOpensAt)}.`
            : curveOpensAt
              ? `The token graduated on ${day(finishedAt)}. The sale opens ${day(curveOpensAt)}.`
              : `The token graduated. The sale opens ${delay} days after graduation.`;

  const inEscrow = Boolean(status?.rail === "escrow" && status.listing && title.owner === status.listing);
  const tokenDecimals = Number.parseInt(record?.attributes.decimals || "", 10);
  const decimals = Number.isFinite(tokenDecimals) ? tokenDecimals : snapshot?.baseDecimals ?? 6;
  const tensorOpen = noCoin ? Boolean(status?.tensor) : Boolean(status?.tensor && saleOpen);
  const creatorHolds = Boolean(
    status?.rail === "creator" && record && status.owner === record.attributes.creator && !status.tensor,
  );
  const sold =
    leftEscrow ||
    Boolean(
      status?.rail === "creator" && record && status.owner && status.owner !== record.attributes.creator && !status.tensor,
    );
  const auction = listing?.sale === "auction";
  const clockOver = Boolean(auction && listing && listing.endsAt > 0 && now >= listing.endsAt && inEscrow);
  const forSaleNow = (inEscrow && opensAt > 0 && now >= opensAt && !clockOver) || tensorOpen;
  const stateLine = !title.exists
    ? "This title is not on chain."
    : sold
      ? "Sold."
      : clockOver
        ? "The auction clock has ended."
        : auction && forSaleNow
          ? "In auction."
          : forSaleNow
            ? "For sale."
            : graduated === false
              ? "Waiting for graduation."
              : inEscrow
                ? "Waiting for the sale to open."
                : creatorHolds
                  ? "The creator holds this title. It is not listed."
                  : saleLine;
  const holderLine = !title.exists
    ? "The title is not on chain."
    : inEscrow
      ? "The PAR escrow holds this title."
      : status?.tensor
        ? "Tensor's marketplace program holds this title."
        : creatorHolds
          ? "The creator wallet holds this title."
          : `The wallet ${shortAddress(title.owner)} holds this title.`;
  const vault = record?.attributes.vault || RECORD_VAULT[cluster];
  const objectName = sheet.name || sheet.record?.object?.name || title.name || "This object";

  return (
    <section className="card record-create">
      <p className="eyebrow">Sales page</p>
      <h2>{objectName}</h2>
      <p className="object-status">{stateLine}</p>
      <p>
        {noCoin
          ? `This title has no coin. The price is paid in ${symbol}.`
          : `This token${symbol && symbol !== "the token" ? `, ${symbol},` : ""} is attached to this real-world asset.`}{" "}
        {holderLine} {saleLine}{" "}
        {pool ? <Link href={`/pool/${pool}`}>Open the coin page</Link> : null}
      </p>
      <ObjectPicture src={typeof sheet.image === "string" ? sheet.image : ""} alt={objectName} />
      {sold ? (
        <>
          <h2>Not for purchase</h2>
          <p>This title has been sold. The purchase is closed.</p>
        </>
      ) : null}
      {inEscrow && listing && record?.attributes.mint && ESCROW_PROGRAM[cluster] && !sold ? (
        <>
          <h2>{forSaleNow ? (auction ? "In auction" : "Available for purchase") : "Purchase"}</h2>
          <p className="note">
            {forSaleNow
              ? `This title is available for purchase from the PAR escrow, paid in ${symbol}.`
              : `The PAR escrow holds this title. Purchase stays closed until ${graduated === false ? "the coin graduates and the wait ends" : "the sale opens"}.`}
          </p>
          <EscrowTrade
            pageCluster={cluster}
            program={ESCROW_PROGRAM[cluster]}
            title={address}
            mint={listing.mint}
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
            decimals={openDecimals ?? decimals}
            payees={payees.map((row) => ({ wallet: row.wallet, amount: row.amount.toString() }))}
          />
        </>
      ) : null}
      {noCoin && creatorHolds && recordAddress && record?.attributes.mint && !sold ? (
        <>
          <h2>How this title sells</h2>
          <NoCoinChoice
            escrow={<OpenEscrow pageCluster={cluster} title={address} record={recordAddress} />}
            tensor={
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
                holdsTitle={creatorHolds}
                decimals={decimals}
                noCoin={noCoin}
                listing={
                  status?.tensor
                    ? { amount: status.tensor.amount.toString(), currency: status.tensor.currency, seller: status.tensor.seller }
                    : null
                }
              />
            }
          />
        </>
      ) : null}
      {status?.rail === "creator" && record?.attributes.mint && !sold && !(noCoin && creatorHolds) ? (
        <>
          <h2>{tensorOpen ? "Available for purchase" : "Purchase"}</h2>
          <p className="note">
            {tensorOpen
              ? `This title is available for purchase through Tensor's program, paid in ${symbol}.`
              : noCoin
                ? `This title has no coin. The creator lists it through Tensor, paid in ${symbol}.`
                : `The creator lists this title through Tensor's program, paid in ${symbol}. The listing may also show on Tensor's own site.`}
          </p>
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
            holdsTitle={creatorHolds}
            decimals={decimals}
            noCoin={noCoin}
            listing={
              status.tensor
                ? { amount: status.tensor.amount.toString(), currency: status.tensor.currency, seller: status.tensor.seller }
                : null
            }
          />
        </>
      ) : null}
      <h2>How this was minted</h2>
      <dl className="quote-slip">
        <div>
          <dt>When the record was minted</dt>
          <dd>
            {recordMint?.at ? day(recordMint.at) : "The chain did not return a mint time."}
            {recordMint ? (
              <>
                {" "}
                <a href={explorerTx(recordMint.signature, cluster)} target="_blank" rel="noreferrer">
                  Mint transaction
                </a>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>When the title was minted</dt>
          <dd>
            {titleMint?.at ? day(titleMint.at) : "The chain did not return a mint time."}
            {titleMint ? (
              <>
                {" "}
                <a href={explorerTx(titleMint.signature, cluster)} target="_blank" rel="noreferrer">
                  Mint transaction
                </a>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Record minted to</dt>
          <dd>
            The program vault{vault ? ` ${vault}` : ""}. It stays frozen there.
          </dd>
        </div>
        <div>
          <dt>Title minted to</dt>
          <dd>
            {status?.rail === "escrow"
              ? "The creator minted the title, then placed it in the PAR escrow."
              : "The creator minted the title into the creator wallet."}
          </dd>
        </div>
        <div>
          <dt>Held now</dt>
          <dd>
            {holderLine}
            {title.owner ? ` ${title.owner}` : ""}
          </dd>
        </div>
        <div>
          <dt>How</dt>
          <dd>
            Metaplex Core. The record is the master. It was minted to the program vault and frozen there, and its words are locked. The title is the one edition that can be sold. Its words are locked, and its update authority is none.
          </dd>
        </div>
      </dl>
      <h2>{title.name || "Title"}</h2>
      {attributeList("Written on this title", title.attributes)}
      {record?.exists ? attributeList("Written on the record", record.attributes) : null}
      {prose.length ? (
        <>
          <h2>The sheet</h2>
          {prose.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </>
      ) : (
        <p className="note">
          The long object story is not stored beside this test record. What you can compare is the attribute list above. Those lines are the words on the NFT.
        </p>
      )}
      <p className="note">
        This coin is a payment token and a meme. It pays for this title. The meme is the joy and heart of the object. It is not a share, and it pays nothing.{" "}
        {Number.isFinite(burn)
          ? status?.rail === "escrow"
            ? `${burn}% of the price is burned by the escrow, ${creatorSalePercent(burn)}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
            : `The creator is paid the full price and promised to burn ${burn}% of it.`
          : ""}
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
          {status.checks.map((check) => {
            const finished =
              (sold && check.label === "The escrow holds the title") ||
              (sold && check.label === "The creator wallet still holds the title");
            const label =
              sold && check.label === "The escrow holds the title"
                ? "The title has left the escrow"
                : sold && check.label === "The creator wallet still holds the title"
                  ? "The title has moved to the buyer"
                  : check.label;
            return (
              <li key={check.label} className={finished || check.ok ? "ok" : "no"}>
                {label}
              </li>
            );
          })}
          {status.tensor ? (
            <li className={saleOpen ? "ok" : "no"}>
              {saleOpen ? "The sale is open" : "Listed before the sale could open"}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="error">No master in the program vault names this title. Treat it as unverified.</p>
      )}
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
        {sold
          ? "This sale is closed. "
          : status?.rail === "escrow"
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
