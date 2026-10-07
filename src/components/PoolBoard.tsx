"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import Link from "next/link";
import type { AssetStanding } from "@/lib/asset-on-pool";
import { useEffect, useState } from "react";
import { LockReady } from "@/components/CurveHandoff";
import { ListingActions } from "@/components/ListingActions";
import { useCluster } from "@/lib/cluster";
import { ObjectPicture } from "@/components/AssetOnPool";
import { objectPairing, titleSentence, tokenPairing } from "@/lib/asset-on-pool";
import { HIDDEN_POOLS, meteoraPoolUrl, type ClusterName } from "@/lib/constants";
import { formatDollars, formatMoney } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";
import { poolPath } from "@/lib/title";

const STORAGE_KEY = "par.listings.v1";

type Remembered = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  creator?: string;
  cluster: ClusterName;
};

export type CardListing = {
  pool: string;
  creator: string;
  name: string;
  symbol: string;
  mint: string;
  image: string;
  stage: "filling" | "lock" | "pool" | "trading";
  percent: number;
  fullAt: string;
  supply: string;
  opens: string;
  ends: string;
  dammPool: string | null;
  quoteMint: string;
  quoteSymbol: string;
};

function readRemembered(cluster: ClusterName): Remembered[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as Remembered[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item?.pool && item.cluster === cluster && !HIDDEN_POOLS.has(item.pool));
  } catch {
    return [];
  }
}

function fullAtFor(threshold: BN, decimals: number, symbol: string): string {
  return `${formatMoney(threshold, decimals)} ${symbol}`;
}

function solNote(text: string, usdPerSol: number): string {
  const amount = Number(text);
  if (!(usdPerSol > 0) || !(amount > 0)) return "";
  return ` (about ${formatDollars(amount * usdPerSol)})`;
}

type AssetStamp = {
  pool: string;
  creator: string;
  title: string;
  name: string;
  kind: string;
  symbol: string;
  image: string;
  coin: "attached" | "none";
  standing: AssetStanding;
  status: string;
  titleHref: string;
};

function realPool(pool: string): boolean {
  return Boolean(pool) && pool !== "none";
}

function ListingCard({
  card,
  cluster,
  solUsd,
  assets,
  onLocked,
}: {
  card: CardListing;
  cluster: ClusterName;
  solUsd: number;
  assets: AssetStamp[];
  onLocked?: () => void;
}) {
  const sharePath = poolPath(card.pool, cluster);
  const ready = card.stage === "lock";
  return (
    <article className={ready ? "card ready-call" : "card"}>
      <ObjectPicture src={card.image} alt={card.name} framed />
      <Link href={sharePath} className="card-link">
        <h3>
          {card.name} {card.symbol ? <span>{card.symbol}</span> : null}
        </h3>
      </Link>
      <p className="rule">
        {card.supply ? `${Number(card.supply).toLocaleString("en-US")} supply. ` : ""}
        {card.opens
          ? card.quoteSymbol === "SOL"
            ? `par ${card.opens} SOL${solNote(card.opens, solUsd)}, pool locks at ${card.ends} SOL${solNote(card.ends, solUsd)}, `
            : `par $${card.opens}, pool locks at $${card.ends}, `
          : ""}
        full at {card.fullAt}
        {card.quoteSymbol === "SOL" ? solNote(String(parseFloat(card.fullAt)), solUsd) : ""}
      </p>
      {assets?.map((asset) => (
        <p key={asset.titleHref}>
          <Link href={asset.titleHref}>
            {tokenPairing(asset.name, asset.kind || "")} {titleSentence(asset.status)}
          </Link>
        </p>
      ))}
      <p className="note">
        {card.stage === "lock"
          ? "The curve is full. Trading is stopped. Any wallet can lock the creator supply and pay the rent."
          : card.stage === "pool"
            ? cluster === "devnet"
              ? "The creator supply is locked. Open this token to sign the trading pool. The practice network has no keepers."
              : "The creator supply is locked. Meteora's keepers can open the trading pool. Open this token to sign it now."
            : card.stage === "filling"
              ? "Still on the curve. Open this token to buy or sell on this site. The Meteora pool is not open yet."
              : cluster === "devnet"
                ? "The trading pool is open. Open this token to buy or sell on this site. Meteora practice pool opens the practice site."
                : "The trading pool is open. Open this token to buy or sell on this site. Meteora pool opens Meteora on the real network."}
      </p>
      {ready ? <LockReady pool={card.pool} symbol={card.symbol} fullAt={card.fullAt} framed={false} compact onDone={onLocked} /> : null}
      <ListingActions
        name={card.name}
        mint={card.mint}
        fullAt={card.fullAt}
        viewHref={sharePath}
        sharePath={sharePath}
        quoteMint={card.quoteMint}
        opensAt={card.opens}
        endsAt={card.ends}
        cluster={cluster}
        meteoraHref={card.dammPool ? meteoraPoolUrl(card.dammPool, cluster) : undefined}
      />
    </article>
  );
}

export function PoolBoard({
  watch = "",
  limit = 200,
  showAssets = false,
  mine = false,
}: {
  watch?: string;
  limit?: number;
  showAssets?: boolean;
  /** The front page. Only the connected wallet's launches. */
  mine?: boolean;
}) {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() || "";
  const [cards, setCards] = useState<CardListing[]>([]);
  const [assets, setAssets] = useState<AssetStamp[] | null>(null);
  const [assetNote, setAssetNote] = useState("Reading the records.");
  const [solUsd, setSolUsd] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function loadSolPrice() {
      const response = await fetch("/api/sol-price");
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { usd?: number };
      if (typeof body.usd === "number" && body.usd > 0 && !cancelled) setSolUsd(body.usd);
    }
    void loadSolPrice().catch(() => undefined);
    const timer = setInterval(() => void loadSolPrice().catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadAssets() {
      try {
        const response = await fetch(`/api/asset?cluster=${cluster}`, { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) {
          setAssetNote("The records could not be read.");
          return;
        }
        const body = (await response.json()) as { assets?: AssetStamp[]; error?: string };
        if (cancelled) return;
        const next = body.assets || [];
        setAssets(next);
        setAssetNote(body.error && next.length === 0 ? body.error : "");
      } catch {
        if (!cancelled) setAssetNote("The records could not be read.");
      }
    }
    void loadAssets();
    const timer = setInterval(() => void loadAssets(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cluster]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const seeds = new Map<string, { name: string; symbol: string; mint: string; creator: string }>();
      for (const item of readRemembered(cluster)) {
        seeds.set(item.pool, { name: item.name, symbol: item.symbol, mint: item.mint || "", creator: item.creator || "" });
      }
      const listed = await fetch(`/api/listings?cluster=${cluster}`)
        .then(async (response) => {
          if (!response.ok) return [] as { pool: string; creator: string; name: string; symbol: string; mint: string }[];
          const body = (await response.json()) as {
            pools?: { pool?: string; creator?: string | null; name?: string | null; symbol?: string | null; mint?: string | null }[];
          };
          return (body.pools || []).flatMap((item) =>
            item.pool && !HIDDEN_POOLS.has(item.pool)
              ? [{ pool: item.pool, creator: item.creator || "", name: item.name || "", symbol: item.symbol || "", mint: item.mint || "" }]
              : [],
          );
        })
        .catch(() => [] as { pool: string; creator: string; name: string; symbol: string; mint: string }[]);
      for (const item of listed) {
        const current = seeds.get(item.pool);
        seeds.set(item.pool, {
          name: current?.name && current.name !== "Listing" ? current.name : item.name || current?.name || "Listing",
          symbol: current?.symbol || item.symbol,
          mint: current?.mint || item.mint,
          creator: item.creator || current?.creator || "",
        });
      }
      const loaded = await Promise.all(
        [...seeds.entries()].slice(0, limit).map(async ([pool, seed]) => {
          try {
            const snapshot = await loadPool(connection, pool);
            return {
              pool,
              creator: snapshot.creator || seed.creator,
              name: snapshot.name || seed.name,
              symbol: snapshot.symbol || seed.symbol,
              mint: snapshot.baseMint,
              image: snapshot.image,
              stage: snapshot.needsLocker ? "lock" : snapshot.canMigrate ? "pool" : snapshot.isMigrated ? "trading" : "filling",
              percent: snapshot.percent,
              fullAt: fullAtFor(snapshot.threshold, snapshot.quoteDecimals, snapshot.quoteSymbol),
              supply: snapshot.supply,
              opens: snapshot.startPrice,
              ends: snapshot.endPrice,
              dammPool: snapshot.dammPool,
              quoteMint: snapshot.quoteMint,
              quoteSymbol: snapshot.quoteSymbol,
            } satisfies CardListing;
          } catch {
            return {
              pool,
              creator: seed.creator,
              name: seed.name,
              symbol: seed.symbol,
              mint: seed.mint,
              image: "",
              stage: "filling",
              percent: 0,
              fullAt: "",
              supply: "",
              opens: "",
              ends: "",
              dammPool: null,
              quoteMint: "",
              quoteSymbol: "USDC",
            } satisfies CardListing;
          }
        }),
      );
      if (!cancelled) setCards(loaded);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [cluster, connection, watch, limit, reload]);

  const shownCards = mine ? cards.filter((card) => wallet && card.creator === wallet) : cards;
  const shownAssets = (assets || []).filter((item) => (mine ? wallet && item.creator === wallet : true));
  const ready = shownCards.filter((card) => card.stage === "lock");
  const waiting = shownCards.filter((card) => card.stage === "pool");
  const filling = shownCards.filter((card) => card.stage === "filling");
  const trading = shownCards.filter((card) => card.stage === "trading");
  const listAssets = showAssets || mine;

  return (
    <section className="rows">
      {mine && !wallet ? (
        <p className="note">Connect a wallet. The tokens and real-world assets that wallet created show here. Every launch on this platform is on the Pools page.</p>
      ) : null}
      {mine && !wallet ? null : (
      <>
      {ready.length > 0 ? (
        <div>
          <h2>Ready to lock</h2>
          <div className="card-grid">
            {ready.map((card) => (
              <ListingCard
                key={card.pool}
                card={card}
                cluster={cluster}
                solUsd={solUsd}
                assets={shownAssets.filter((item) => realPool(item.pool) && item.pool === card.pool)}
                onLocked={() => setReload((value) => value + 1)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {waiting.length > 0 ? (
        <div>
          <h2>Waiting on the trading pool</h2>
          <div className="card-grid">
            {waiting.map((card) => (
              <ListingCard
                key={card.pool}
                card={card}
                cluster={cluster}
                solUsd={solUsd}
                assets={shownAssets.filter((item) => realPool(item.pool) && item.pool === card.pool)}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div>
        <h2>Filling</h2>
        {filling.length === 0 ? (
          <p className="note">{mine ? "You have no token filling." : "No curve is filling."}</p>
        ) : null}
        <div className="card-grid">
          {filling.map((card) => (
            <ListingCard
              key={card.pool}
              card={card}
              cluster={cluster}
              solUsd={solUsd}
              assets={shownAssets.filter((item) => realPool(item.pool) && item.pool === card.pool)}
            />
          ))}
        </div>
      </div>
      <div>
        <h2>Trading</h2>
        {trading.length === 0 ? (
          <p className="note">{mine ? "You have no token trading." : "No trading pool is open yet."}</p>
        ) : null}
        <div className="card-grid">
          {trading.map((card) => (
            <ListingCard
              key={card.pool}
              card={card}
              cluster={cluster}
              solUsd={solUsd}
              assets={shownAssets.filter((item) => realPool(item.pool) && item.pool === card.pool)}
            />
          ))}
        </div>
      </div>
      </>
      )}
      {listAssets && !(mine && !wallet) ? (
        <div>
          <h2>Real-world assets</h2>
          {assetNote ? <p className="note">{assetNote}</p> : null}
          {assets && shownAssets.length === 0 && !assetNote ? (
            <p className="note">{mine ? "You have no real-world asset." : "No real-world asset is on this network yet."}</p>
          ) : null}
          <div className="card-grid">
            {shownAssets.map((asset) => (
              <article key={asset.title} className="card">
                <ObjectPicture src={asset.image} alt={asset.name} framed />
                <Link href={asset.titleHref} className="card-link">
                  <h3>{asset.name}</h3>
                </Link>
                <p>{objectPairing(asset.kind || "", asset.symbol, asset.coin)}</p>
                <p className="object-status">{titleSentence(asset.status)}</p>
                <p>
                  {asset.standing === "sold" && realPool(asset.pool) ? "The token can still be traded. " : null}
                  <Link href={asset.titleHref}>Open the sales page</Link>
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
