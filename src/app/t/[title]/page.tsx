import { getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { CLAIMED_STATUS, titleWasPurchased } from "@/lib/asset-on-pool";
import { ObjectPicture } from "@/components/AssetOnPool";
import { objectPictureUrl } from "@/lib/sheet-html";
import { LockReady, OpenPool } from "@/components/CurveHandoff";
import { EscrowTrade } from "@/components/EscrowTrade";
import { HandoffDesk } from "@/components/HandoffDesk";
import { NoCoinChoice, OpenEscrow } from "@/components/OpenEscrow";
import { SaleTrade } from "@/components/SaleTrade";
import { explorerAccount, explorerTx, rpcUrl, type ClusterName } from "@/lib/constants";
import { formatMoney, shortAddress } from "@/lib/format";
import { curveSale, loadPool } from "@/lib/load-pool";
import { RECORD_VAULT, REMOVED_TITLES, readRecord } from "@/lib/record";
import { readCopy } from "@/lib/record-copy";
import { creatorSalePercent, ESCROW_PROGRAM, poolPath, readListing, readPayouts, readTitle, SALE_PROGRAM_FEE_PERCENT, TENSOR_TAKER_FEE_PERCENT, titleStatus } from "@/lib/title";

const TOKEN_DECIMALS = 6;

function formatUnits(amount: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(amount / scale).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Sheet = {
  name?: string;
  description?: string;
  image?: string;
  claim?: string;
  handoff?: string;
  promises?: string[];
  record?: {
    pitch?: string;
    object?: { story?: string; name?: string; kind?: string; existsNow?: boolean; holder?: string; where?: string };
    claim?: { text?: string };
    redemption?: { handoff?: string; ifClaimGoesWrong?: string; declaredValue?: string; declaredUnit?: string };
    title?: { promises?: string[] };
    token?: { name?: string; symbol?: string; supply?: string };
    image?: { arweave?: string };
    sheetImage?: { arweave?: string };
  };
};

type SaleKind = "paired" | "rwa" | "token";

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
  if (REMOVED_TITLES.has(address)) {
    return (
      <section className="card">
        <h2>That record is off this site</h2>
        <p>The token it was paired with is still listed.</p>
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
  const [recordMint, titleMint] = await Promise.all([
    firstSeen(connection, recordAddress),
    firstSeen(connection, address),
  ]);
  const noCoin = record?.attributes.coin === "none";
  const pool = ADDRESS.test(record?.attributes.pool || "") ? record?.attributes.pool || "" : "";
  const sale = pool ? await curveSale(connection, pool) : null;
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
    ? "The creator lists this title (NFT) at one price through Tensor's marketplace program. A buyer pays that price."
    : !title.exists
    ? "This title (NFT) is not on chain."
    : !Number.isFinite(delay) || !Number.isFinite(burn)
      ? "This title (NFT) does not state its sale terms. Treat it as unverified."
    : graduated === null
      ? "The pool could not be read."
      : !graduated
        ? `The sale opens ${delay} ${cluster === "devnet" && status?.rail === "escrow" ? "seconds" : "days"} after the token graduates.`
        : leftEscrow
          ? "The sale finished. The title (NFT) has left the escrow."
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
  const creatorAccount = status?.creator || "";
  const creatorHolds = Boolean(
    status?.rail === "creator" && creatorAccount && status.owner === creatorAccount && !status.tensor,
  );
  const leftSeller =
    leftEscrow ||
    Boolean(
      status?.rail === "creator" && creatorAccount && status.owner && status.owner !== creatorAccount && !status.tensor,
    );
  const sold = titleWasPurchased({
    coin: noCoin ? "none" : "attached",
    graduated,
    saleOpen,
    leftSeller,
  });
  const auction = listing?.sale === "auction";
  const clockOver = Boolean(auction && listing && listing.endsAt > 0 && now >= listing.endsAt && inEscrow);
  const forSaleNow = (inEscrow && opensAt > 0 && now >= opensAt && !clockOver) || tensorOpen;
  const stateLine = !title.exists
    ? "This title (NFT) is not on chain."
    : sold
      ? CLAIMED_STATUS
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
                  ? "The creator holds this title (NFT). It is not listed."
                  : saleLine;
  const holderLine = !title.exists
    ? "The title (NFT) is not on chain."
    : inEscrow
      ? "The PAR escrow holds this title (NFT)."
      : status?.tensor
        ? "Tensor's marketplace program holds this title (NFT)."
        : creatorHolds
          ? "The creator wallet holds this title (NFT)."
          : `The wallet ${shortAddress(title.owner)} holds this title (NFT).`;
  const vault = record?.attributes.vault || RECORD_VAULT[cluster];
  const tokenName = sheet.record?.token?.name || snapshot?.name || (symbol !== "the token" ? symbol : "This token");
  const namedObject = (sheet.record?.object?.name || sheet.name || "").trim();
  const objectKind = (sheet.record?.object?.kind || "").trim();
  const story = (sheet.record?.object?.story || "").trim();
  const pitch = (sheet.record?.pitch || "").trim();
  const claimText = (sheet.record?.claim?.text || sheet.claim || "").trim();
  const handoffText = (sheet.record?.redemption?.handoff || sheet.handoff || "").trim();
  const existsNow = sheet.record?.object?.existsNow;
  const objectHolder = (sheet.record?.object?.holder || "").trim();
  const where = (sheet.record?.object?.where || "").trim();
  const picture = objectPictureUrl(sheet);
  const distinctObject = Boolean(namedObject) && namedObject !== tokenName && namedObject !== symbol;
  const hasObject = Boolean(
    distinctObject || story || objectKind || objectHolder || where || claimText || handoffText || picture || existsNow === true || existsNow === false,
  );
  const saleKind: SaleKind = noCoin ? "rwa" : hasObject ? "paired" : "token";
  const pageTitle = saleKind === "token" ? tokenName : namedObject || title.name || tokenName;
  const shownState = sold && saleKind === "token" ? "Claimed." : stateLine;
  const tokenLabel = symbol && symbol !== "the token" && symbol !== tokenName ? `${tokenName} (${symbol})` : tokenName;
  const burnLine =
    Number.isFinite(burn) && saleKind !== "rwa"
      ? status?.rail === "escrow"
        ? `${burn}% of the price is burned, ${creatorSalePercent(burn)}% goes to the creator, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
        : `The creator is paid the full price and burns ${burn}% of it.`
      : "";
  const sentence = (value: string) => (value.endsWith(".") ? value : `${value}.`);
  const sheetRows = [
    namedObject ? ["Name", namedObject] : null,
    objectKind ? ["Kind", objectKind] : null,
    existsNow === true ? ["Exists now", "Yes"] : existsNow === false ? ["Exists now", "No"] : null,
    objectHolder ? ["Holder", objectHolder] : null,
    where ? ["Where", where] : null,
    story ? ["Story", story] : null,
    claimText ? ["Claim", claimText] : null,
    handoffText ? ["Handoff", handoffText] : null,
    sheet.record?.redemption?.ifClaimGoesWrong ? ["If a claim goes wrong", sheet.record.redemption.ifClaimGoesWrong] : null,
    sheet.record?.redemption?.declaredValue
      ? ["Declared value", `${sheet.record.redemption.declaredValue} ${sheet.record.redemption.declaredUnit || ""}`.trim()]
      : null,
    pitch ? ["Pitch", pitch] : null,
  ].filter((row): row is [string, string] => Boolean(row));
  const tokenSentence = [
    `${tokenLabel} trades on a curve${snapshot ? `, quoted in ${snapshot.quoteSymbol}` : ""}.`,
    snapshot?.supply ? `The supply is ${Number(snapshot.supply).toLocaleString("en-US")}.` : "",
    saleKind === "paired"
      ? "It is not a share of this RWA, and it pays nothing. A buyer uses this token to pay for the title (NFT)."
      : "Buys and sells on the token page move the price.",
    burnLine,
  ]
    .filter(Boolean)
    .join(" ");
  const rwaBasics = [
    saleKind === "paired" ? `The token paired with this RWA is ${tokenLabel}.` : `A buyer pays for this RWA in ${symbol}.`,
    objectKind ? sentence(objectKind) : "",
    existsNow === true ? "It exists now." : existsNow === false ? "It does not exist yet." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const claimPath =
    status?.rail === "escrow"
      ? "The sale of the title (NFT) runs through the PAR escrow on this page."
      : "The creator lists the title (NFT) through Tensor on this page.";

  return (
    <section className="card record-create sale-page">
      <p className="eyebrow">Sales page</p>
      <h2>{pageTitle}</h2>
      <p className="object-status">{shownState}</p>
      <p>
        {saleKind === "paired"
          ? `This is a real-world asset. It is paired with the token ${tokenLabel}.`
          : saleKind === "rwa"
            ? `This is a real-world asset. It is not paired with its own token. A buyer pays in ${symbol}.`
            : `${tokenLabel} is a token. It is not paired with a real-world asset.`}
      </p>
      {stateLine !== saleLine ? <p className="note">{holderLine} {saleLine}</p> : <p className="note">{holderLine}</p>}
      {saleKind !== "token" ? (
        <>
          <h2>The RWA</h2>
          <p>{rwaBasics}</p>
          <ObjectPicture src={picture} alt={namedObject || "The RWA"} wide />
          <p>The holder of the title (NFT) can claim this RWA. {claimPath}</p>
          <p>For the unique information on this RWA, read the meta sheet.</p>
          {sheetRows.length > 0 ? (
            <details className="specs">
              <summary>Meta sheet …</summary>
              <dl className="specs-body">
                {sheetRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </>
      ) : null}
      {saleKind !== "rwa" ? (
        <>
          <h2>The token</h2>
          <p>
            {tokenSentence}
            {pool ? (
              <>
                {" "}
                <Link href={poolPath(pool, cluster)}>Open the token page</Link>.
              </>
            ) : null}
          </p>
          {snapshot?.needsLocker ? (
            <LockReady
              pool={pool}
              symbol={snapshot.symbol}
              fullAt={`${formatMoney(snapshot.threshold, snapshot.quoteDecimals)} ${snapshot.quoteSymbol}`}
            />
          ) : null}
          {snapshot?.canMigrate && snapshot.dammConfig ? (
            <OpenPool
              pool={pool}
              dammConfig={snapshot.dammConfig}
              quoteSymbol={snapshot.quoteSymbol}
              feeBps={snapshot.migrationFeeBps}
            />
          ) : null}
          {snapshot ? (
            <section className="quotes" aria-label="This token">
              <article>
                <h2>Price</h2>
                <p className="figure">
                  {snapshot.price} <span>{snapshot.quoteSymbol}</span>
                </p>
                <p className="note">Live curve price.</p>
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
                  {snapshot.needsLocker
                    ? "The curve is full. Trading is stopped. The gold box takes the lock signature. Any wallet can pay the rent."
                    : snapshot.canMigrate
                      ? "The creator supply is locked. The trading pool still needs a signature."
                      : snapshot.isMigrated
                        ? "The curve is full and the trading pool is open."
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
                      : `These ${delay} ${cluster === "devnet" && status?.rail === "escrow" ? "seconds" : "days"} start when the token graduates. The title (NFT) stays where it is until then.`}
                  </p>
                </article>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      {sold ? (
        <>
          <h2>Claimed</h2>
          <p>
            This title (NFT) has been purchased.
            {saleKind === "token"
              ? " This sale is finished."
              : " The handoff is in the meta sheet. This sale is finished."}
            {pool && saleKind !== "rwa" ? " The token can still be traded." : ""}
          </p>
        </>
      ) : null}
      {inEscrow && listing && record?.attributes.mint && ESCROW_PROGRAM[cluster] && !sold ? (
        <>
          <h2>{forSaleNow ? (auction ? "In auction" : "Available for purchase") : "Purchase"}</h2>
          <p className="note">
            {forSaleNow
              ? `This title (NFT) is available for purchase from the PAR escrow, paid in ${symbol}.`
              : `The PAR escrow holds this title (NFT). Purchase stays closed until ${graduated === false ? "the token graduates and the wait ends" : "the sale opens"}.`}
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
            pageCluster={cluster}
            escrow={<OpenEscrow pageCluster={cluster} title={address} record={recordAddress} />}
            tensor={
              <SaleTrade
                pageCluster={cluster}
                title={address}
                mint={record.attributes.mint}
                creator={creatorAccount}
                symbol={symbol}
                burn={Number.isFinite(burn) ? burn : 0}
                delayDays={Number.isFinite(delay) ? delay : 0}
                finishedAt={finishedAt}
                graduated={graduated === true}
                holdsTitle={creatorHolds}
                decimals={decimals}
                noCoin={noCoin}
                collection={status?.collection ?? null}
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
              ? `This title (NFT) is available for purchase through Tensor's program, paid in ${symbol}.`
              : noCoin
                ? `The creator lists this title (NFT) through Tensor, paid in ${symbol}.`
                : `The creator lists this title (NFT) through Tensor's program, paid in ${symbol}. The listing may also show on Tensor's own site.`}
          </p>
          <SaleTrade
            pageCluster={cluster}
            title={address}
            mint={record.attributes.mint}
            creator={creatorAccount}
            symbol={symbol}
            burn={Number.isFinite(burn) ? burn : 0}
            delayDays={Number.isFinite(delay) ? delay : 0}
            finishedAt={finishedAt}
            graduated={graduated === true}
            holdsTitle={creatorHolds}
            decimals={decimals}
            noCoin={noCoin}
            collection={status.collection}
            listing={
              status.tensor
                ? { amount: status.tensor.amount.toString(), currency: status.tensor.currency, seller: status.tensor.seller }
                : null
            }
          />
        </>
      ) : null}
      <HandoffDesk cluster={cluster} title={address} />
      <h2>On chain</h2>
      <p className="note">
        The record was minted {recordMint?.at ? day(recordMint.at) : "at a time the chain did not return"}
        {recordMint ? (
          <>
            {" "}
            (<a href={explorerTx(recordMint.signature, cluster)} target="_blank" rel="noreferrer">record mint</a>)
          </>
        ) : null}
        . The title (NFT) was minted {titleMint?.at ? day(titleMint.at) : "at a time the chain did not return"}
        {titleMint ? (
          <>
            {" "}
            (<a href={explorerTx(titleMint.signature, cluster)} target="_blank" rel="noreferrer">title mint</a>)
          </>
        ) : null}
        . The record stays in the vault{vault ? ` ${shortAddress(vault)}` : ""}. The title (NFT) is the one edition that can be sold, and its words are locked.
      </p>
      {status?.tensor ? (
        <p className="note">
          Listed on Tensor for {formatUnits(status.tensor.amount, TOKEN_DECIMALS)}{" "}
          {status.tensor.currency === record?.attributes.mint ? symbol : "another currency"}. Tensor adds about{" "}
          {TENSOR_TAKER_FEE_PERCENT}% on the buyer&apos;s side.
        </p>
      ) : null}
      {status ? (
        <ul className="record-checks">
          <li className="ok">The record in the vault names this title (NFT)</li>
          {status.checks.map((check) => {
            const finished =
              (sold && check.label === "The escrow holds the title") ||
              (sold && check.label === "The creator wallet still holds the title");
            const label =
              sold && check.label === "The escrow holds the title"
                ? "The title (NFT) has left the escrow"
                : sold && check.label === "The creator wallet still holds the title"
                  ? "The title (NFT) has moved to the buyer"
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
        <p className="error">No master in the program vault names this title (NFT). Treat it as unverified.</p>
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
          ? saleKind === "token"
            ? "This title (NFT) is claimed. The sale is finished. "
            : "This title (NFT) is claimed. The handoff of the RWA remains the promise above. "
          : status?.rail === "escrow"
            ? "A buyer calls the PAR escrow program from this page. "
            : "Listing and buying on this page both go through Tensor's program. "}
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
