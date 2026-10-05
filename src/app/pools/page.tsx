"use client";

import Link from "next/link";
import { PoolBoard } from "@/components/PoolBoard";

export default function PoolsPage() {
  return (
    <div className="desk">
      <section className="lede">
        <p className="eyebrow">Marketplace</p>
        <h1>Pools</h1>
        <p className="tagline">Buy or sell a PAR token.</p>
        <p>
          Every token on this network is here. Devnet lists the practice tokens. Mainnet lists the real-network tokens.
          Open a token to buy or sell it on this site.
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
      <PoolBoard />
    </div>
  );
}
