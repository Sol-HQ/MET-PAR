"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CLAIMED_STATUS, type AssetStanding } from "@/lib/asset-on-pool";
import type { ClusterName } from "@/lib/constants";

type AssetCard = {
  title: string;
  name: string;
  symbol: string;
  image: string;
  standing: AssetStanding;
  status: string;
  story: string[];
  titleHref: string;
};

export function ObjectPicture({ src, alt, quiet = false }: { src: string; alt: string; quiet?: boolean }) {
  const [state, setState] = useState<"pending" | "shown" | "missing">(src ? "pending" : "missing");
  if (!src || state === "missing") return quiet ? null : <p className="note">No picture is stored for this object.</p>;
  return (
    <img
      className="object-shot"
      src={src}
      alt={alt}
      style={{ display: state === "shown" ? "block" : "none" }}
      onLoad={(event) => {
        const img = event.currentTarget;
        setState(img.naturalWidth >= 32 && img.naturalHeight >= 32 ? "shown" : "missing");
      }}
      onError={() => setState("missing")}
    />
  );
}

function blurbOf(lines: string[]): string {
  const line = lines.find((item) => item.trim()) || "";
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
        const blurb = blurbOf(asset.story);
        return (
          <article key={asset.title} className="card object-card">
            <p className="eyebrow">Attached real-world asset{asset.symbol ? ` · ${asset.symbol}` : ""}</p>
            <h2>{asset.name}</h2>
            <p>Has a coin. This token is the coin on this real-world asset.</p>
            <ObjectPicture src={asset.image} alt={asset.name} quiet />
            {blurb ? <p>{blurb}</p> : null}
            <p className="object-status">
              {asset.standing === "sold" ? `${CLAIMED_STATUS} The token can still be live.` : asset.status}
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
