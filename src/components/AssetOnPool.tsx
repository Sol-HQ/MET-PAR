"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { objectPairing, titleSentence, type AssetStanding } from "@/lib/asset-on-pool";
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
            <p className="eyebrow">Real-world asset</p>
            <h2>{asset.name}</h2>
            <p>{objectPairing(asset.kind || "", asset.symbol, asset.coin || "attached", true)}</p>
            <ObjectPicture src={asset.image} alt={asset.name} quiet />
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
