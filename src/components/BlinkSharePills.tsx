"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClusterName } from "@/lib/constants";

export function BlinkSharePills({ title, cluster, shareUrl }: { title: string; cluster: ClusterName; shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  const blinkPage = `/blink/${encodeURIComponent(title)}${cluster === "devnet" ? "?c=devnet" : ""}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="blink-share-pills" aria-label="Blink links">
      <Link className="blink-pill blink-pill-primary" href={blinkPage}>
        Open Blink
      </Link>
      <button className="blink-pill" type="button" onClick={() => void copy()}>
        {copied ? "Link copied" : "Copy share link"}
      </button>
    </div>
  );
}
