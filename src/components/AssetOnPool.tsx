"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { titleSentence, tokenPairing, type AssetStanding } from "@/lib/asset-on-pool";
import type { ClusterName } from "@/lib/constants";

type AssetCard = {
  title: string;
  name: string;
  kind: string;
  symbol: string;
  coin: "attached" | "none";
  image: string;
  standing: AssetStanding;
  status: string;
  story: string[];
  titleHref: string;
};

export function ObjectPicture({
  src,
  alt,
  quiet = false,
  framed = false,
  wide = false,
}: {
  src: string;
  alt: string;
  quiet?: boolean;
  framed?: boolean;
  wide?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [missing, setMissing] = useState(!src);
  useEffect(() => {
    setMissing(!src);
    setAttempt(0);
  }, [src]);
  if (!src || missing) {
    if (framed) return <div className="card-shot" />;
    return quiet ? null : <p className="note">No picture is stored for this object.</p>;
  }
  const shown = attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}try=${attempt}` : src;
  return (
    <img
      className={framed ? "card-shot" : wide ? "sheet-picture" : "object-shot"}
      src={shown}
      alt={alt}
      referrerPolicy="no-referrer"
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth >= 32 && img.naturalHeight >= 32) return;
        if (framed && attempt < 4) setAttempt((value) => value + 1);
        else setMissing(true);
      }}
      onError={() => {
        if (framed && attempt < 4) {
          window.setTimeout(() => setAttempt((value) => value + 1), 1200);
          return;
        }
        setMissing(true);
      }}
    />
  );
}

function blurbOf(name: string, lines: string[]): string {
  const lead = `${name.trim()}.`;
  const line =
    lines.find((item) => {
      const text = item.trim();
      if (!text || text.startsWith(lead)) return false;
      if (text.startsWith("Claim:") || text.startsWith("Declared value:")) return false;
      if (text.includes("Token address ") && text.includes("pays for this title")) return false;
      return true;
    }) || "";
  if (line.length <= 220) return line;
  return `${line.slice(0, 217).trimEnd()}…`;
}

export function AssetOnPool({ pool, cluster }: { pool: string; cluster: ClusterName }) {
  const [assets, setAssets] = useState<AssetCard[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/asset?cluster=${cluster}&pool=${pool}`, { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { assets?: AssetCard[] };
      if (!cancelled) setAssets(body.assets || []);
    }
    void load().catch(() => undefined);
    const timer = setInterval(() => void load().catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pool, cluster]);

  if (!assets?.length) return null;

  return (
    <section className="object-board" aria-label="Real-world asset">
      {assets.map((asset) => {
        const blurb = blurbOf(asset.name, asset.story);
        return (
          <article key={asset.title} className="card object-card">
            <p>{tokenPairing(asset.name, asset.kind || "")}</p>
            <p className="eyebrow">Real-world asset</p>
            <h2>{asset.name}</h2>
            <ObjectPicture src={asset.image} alt={asset.name} framed />
            {blurb ? <p>{blurb}</p> : null}
            <p className="object-status">
              {titleSentence(asset.status)}
              {asset.standing === "sold" ? " The token can still be traded." : ""}
            </p>
            <p>
              <Link href={asset.titleHref}>Open the sales page</Link>
            </p>
          </article>
        );
      })}
    </section>
  );
}
