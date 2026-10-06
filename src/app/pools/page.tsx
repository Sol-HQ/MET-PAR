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
          Tokens and real-world assets are both here. A token is filling or trading. A real-world asset names the token it is paired with, and where the title is. Once the title is purchased, the card says the title is claimed and the handoff is still ahead. The handoff is the promise on the sheet. The token can still be traded. Open a real-world asset to go to its sale page. Open a token to buy or sell it on this site.
        </p>
        <div className="asset-nav">
          <Link href="/" className="asset-link">
            PAR
          </Link>
          <Link href="/asset" className="asset-link">
            Real-world asset
          </Link>
          <Link href="/faqs" className="asset-link">
            FAQs
          </Link>
        </div>
      </section>
      <PoolBoard showAssets />
    </div>
  );
}
