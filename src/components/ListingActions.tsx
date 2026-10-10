"use client";

import { useEffect, useState } from "react";
import { WSOL, type ClusterName } from "@/lib/constants";

function jupiterTokenUrl(mint: string): string {
  return `https://jup.ag/tokens/${mint}`;
}

function priced(amount: string, sol: boolean): string {
  return sol ? `${amount} SOL` : `$${amount}`;
}

function xShareUrl(name: string, fullAt: string, pageUrl: string, sol: boolean, opensAt?: string, endsAt?: string): string {
  const prices = opensAt && endsAt ? ` opens at ${priced(opensAt, sol)}, pool locks at ${priced(endsAt, sol)},` : "";
  const text = `${name}${prices} full at ${fullAt}.`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
}

export function ListingActions({
  name,
  mint,
  fullAt,
  viewHref,
  sharePath,
  quoteMint,
  opensAt,
  endsAt,
  meteoraHref,
  cluster,
}: {
  name: string;
  mint: string;
  fullAt: string;
  viewHref: string;
  sharePath: string;
  quoteMint: string;
  opensAt?: string;
  endsAt?: string;
  meteoraHref?: string;
  cluster: ClusterName;
}) {
  const [copied, setCopied] = useState(false);
  const [pageUrl, setPageUrl] = useState(sharePath);

  useEffect(() => {
    setPageUrl(new URL(sharePath, window.location.origin).toString());
  }, [sharePath]);

  async function copyMint() {
    if (!mint) return;
    await navigator.clipboard.writeText(mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="card-actions">
      <button type="button" onClick={() => void copyMint()} disabled={!mint}>
        {copied ? "Copied" : "Copy mint"}
      </button>
      {mint ? (
        <a href={jupiterTokenUrl(mint)} target="_blank" rel="noreferrer" title="Opens this token on Jupiter.">
          {cluster === "devnet" ? "Jupiter, real network" : "Trade on Jupiter"}
        </a>
      ) : (
        <button type="button" disabled>
          Trade on Jupiter
        </button>
      )}
      <a href={viewHref}>View PAR pool</a>
      {meteoraHref ? (
        <a href={meteoraHref} target="_blank" rel="noreferrer" title={meteoraHref}>
          {cluster === "devnet" ? "Meteora practice pool" : "Meteora pool"}
        </a>
      ) : null}
      <a href={xShareUrl(name, fullAt, pageUrl, quoteMint === WSOL, opensAt, endsAt)} target="_blank" rel="noreferrer" title="Opens X with a link back to this token on PAR.">
        Share on X
      </a>
    </div>
  );
}
