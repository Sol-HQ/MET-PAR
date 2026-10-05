"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import Link from "next/link";
import type { AssetStanding } from "@/lib/asset-on-pool";
import { useEffect, useState } from "react";
import { ListingActions } from "@/components/ListingActions";
import { useCluster } from "@/lib/cluster";
import { HIDDEN_POOLS, meteoraPoolUrl, type ClusterName } from "@/lib/constants";
import { formatDollars, formatMoney } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";

const STORAGE_KEY = "par.listings.v1";

type Remembered = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  cluster: ClusterName;
};

export type CardListing = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  image: string;
  filling: boolean;
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
  title: string;
  name: string;
  standing: AssetStanding;
  status: string;
  titleHref: string;
};

function stampLine(items: AssetStamp[]): string {
  const labels = items.map((item) => {
    const word =
      item.standing === "sold"
        ? "Sold"
        : item.standing === "for-sale"
          ? "For sale"
          : item.standing === "waiting"
            ? "Waiting on the sale"
            : "Not sold";
    return `${item.name} (${word})`;
  });
  return `Real-world asset. ${labels.join(". ")}.`;
}

function ListingCard({
  card,
  cluster,
  solUsd,
  assets,
}: {
  card: CardListing;
  cluster: ClusterName;
  solUsd: number;
  assets: AssetStamp[];
}) {
  const sharePath = `/pool/${card.pool}`;
  return (
    <article className="card">
      {card.image ? <img className="token-preview" src={card.image} alt="" /> : null}
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
      {assets?.length ? <p className="rule">{stampLine(assets)}</p> : null}
      <p className="note">
        {card.filling
          ? "Still on the curve. Open this token to buy or sell on this site. The Meteora pool is not open yet."
          : cluster === "devnet"
            ? "The curve is full. Open this token to buy or sell on this site. Meteora practice pool opens the practice site."
            : "The curve is full. Open this token to buy or sell on this site. Meteora pool opens Meteora on the real network."}
      </p>
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

export function PoolBoard({ watch = "", limit = 200, showAssets = false }: { watch?: string; limit?: number; showAssets?: boolean }) {
  const { cluster } = useCluster();
  const { connection } = useConnection();
  const [cards, setCards] = useState<CardListing[]>([]);
  const [assets, setAssets] = useState<AssetStamp[] | null>(null);
  const [solUsd, setSolUsd] = useState(0);

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
      const response = await fetch(`/api/asset?cluster=${cluster}`, { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { assets?: AssetStamp[] };
      if (!cancelled) setAssets(body.assets || []);
    }
    void loadAssets().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cluster]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const seeds = new Map<string, { name: string; symbol: string; mint: string }>();
      for (const item of readRemembered(cluster)) {
        seeds.set(item.pool, { name: item.name, symbol: item.symbol, mint: item.mint || "" });
      }
      const listed = await fetch(`/api/listings?cluster=${cluster}`)
        .then(async (response) => {
          if (!response.ok) return [] as string[];
          const body = (await response.json()) as { pools?: { pool?: string }[] };
          return (body.pools || []).map((item) => item.pool).filter((pool): pool is string => typeof pool === "string" && !HIDDEN_POOLS.has(pool));
        })
        .catch(() => [] as string[]);
      for (const pool of listed) {
        if (!seeds.has(pool)) seeds.set(pool, { name: "Listing", symbol: "", mint: "" });
      }
      const loaded = await Promise.all(
        [...seeds.entries()].slice(0, limit).map(async ([pool, seed]) => {
          try {
            const snapshot = await loadPool(connection, pool);
            return {
              pool,
              name: snapshot.name || seed.name,
              symbol: snapshot.symbol || seed.symbol,
              mint: snapshot.baseMint,
              image: snapshot.image,
              filling: !snapshot.isMigrated,
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
              name: seed.name,
              symbol: seed.symbol,
              mint: seed.mint,
              image: "",
              filling: true,
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
  }, [cluster, connection, watch, limit]);

  const filling = cards.filter((card) => card.filling);
  const trading = cards.filter((card) => !card.filling);

  return (
    <section className="rows">
      <div>
        <h2>Filling</h2>
        {filling.length === 0 ? <p className="note">No curve is filling.</p> : null}
        <div className="card-grid">
          {filling.map((card) => (
            <ListingCard key={card.pool} card={card} cluster={cluster} solUsd={solUsd} assets={(assets || []).filter((item) => item.pool === card.pool)} />
          ))}
        </div>
      </div>
      <div>
        <h2>Trading</h2>
        {trading.length === 0 ? <p className="note">No trading pool is open yet.</p> : null}
        <div className="card-grid">
          {trading.map((card) => (
            <ListingCard key={card.pool} card={card} cluster={cluster} solUsd={solUsd} assets={(assets || []).filter((item) => item.pool === card.pool)} />
          ))}
        </div>
      </div>
      {showAssets ? (
        <div>
          <h2>Real-world assets</h2>
          {assets && assets.length === 0 ? <p className="note">No titled object is on this network yet.</p> : null}
          <div className="card-grid">
            {(assets || []).map((asset) => (
              <article key={asset.title} className="card">
                <Link href={`/pool/${asset.pool}`} className="card-link">
                  <h3>{asset.name}</h3>
                </Link>
                <p className="rule">{stampLine([asset])}</p>
                <p>{asset.status}</p>
                <p>
                  <Link href={`/pool/${asset.pool}`}>Open the coin</Link>
                  {" · "}
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
