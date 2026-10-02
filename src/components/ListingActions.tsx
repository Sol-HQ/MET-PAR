"use client";

import { useEffect, useState } from "react";
import { ENDS_AT, OPENS_AT } from "@/lib/constants";

export function jupiterTradeUrl(quoteMint: string, baseMint: string): string {
  return `https://jup.ag/swap/${quoteMint}-${baseMint}`;
}

export function xShareUrl(name: string, fullAt: string, pageUrl: string): string {
  const text = `${name} opens at ${OPENS_AT}, ends at ${ENDS_AT}, full at ${fullAt}.`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
}

export function ListingActions({
  name,
  mint,
  fullAt,
  viewHref,
  sharePath,
  quoteMint,
}: {
  name: string;
  mint: string;
  fullAt: string;
  viewHref: string;
  sharePath: string;
  quoteMint: string;
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
        <a href={jupiterTradeUrl(quoteMint, mint)} target="_blank" rel="noreferrer">
          Trade on Jupiter
        </a>
      ) : (
        <button type="button" disabled>
          Trade on Jupiter
        </button>
      )}
      <a href={viewHref}>View pool</a>
      <a href={xShareUrl(name, fullAt, pageUrl)} target="_blank" rel="noreferrer">
        Share
      </a>
    </div>
  );
}
