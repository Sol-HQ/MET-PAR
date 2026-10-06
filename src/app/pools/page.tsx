"use client";

import Link from "next/link";
import { PoolBoard } from "@/components/PoolBoard";

export default function PoolsPage() {
  return (
    <div className="desk">
      <section className="lede">
        <p className="eyebrow">Marketplace</p>
        <h1>Pools</h1>
        <p className="tagline">Every launch on this platform.</p>
        <p>
          Coins and real-world assets are both here. A coin is filling or trading. A real-world asset says whether it has a coin, and where the title is. Once the title is purchased, the card says claimed, still awaiting handoff. The handoff is the promise on the sheet. A coin on that asset can still be live. Open a real-world asset to go to its sale page. Open a coin to buy or sell it on this site.
        </p>
        <div className="asset-nav">
          <Link href="/" className="asset-link">
            PAR
          </Link>
          <Link href="/asset" className="asset-link">
            Real-world asset
          </Link>
        </div>
      </section>
      <PoolBoard showAssets />
    </div>
  );
}
