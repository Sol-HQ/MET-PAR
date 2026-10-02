"use client";

import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { ReactNode } from "react";
import { DBC_PROGRAM_ID } from "@/lib/constants";
import { useCluster } from "@/lib/cluster";

export function Shell({ children }: { children: ReactNode }) {
  const { cluster, setCluster } = useCluster();

  return (
    <div className="page">
      <header className="top">
        <Link href="/" className="brand">
          <span className="mark">PAR</span>
          <span>Listing desk</span>
        </Link>
        <div className="top-actions">
          <div className="segmented" role="group" aria-label="Network">
            <button
              type="button"
              aria-pressed={cluster === "devnet"}
              onClick={() => setCluster("devnet")}
            >
              Devnet
            </button>
            <button
              type="button"
              aria-pressed={cluster === "mainnet-beta"}
              onClick={() => setCluster("mainnet-beta")}
            >
              Mainnet
            </button>
          </div>
          <WalletMultiButton />
        </div>
      </header>
      {cluster === "mainnet-beta" ? (
        <p className="banner">
          Mainnet spends real SOL and USDC. PAR shows the exact amounts and waits for a second
          confirmation before the wallet opens.
        </p>
      ) : null}
      <main>{children}</main>
      <footer>
        <span>DBC program {DBC_PROGRAM_ID}</span>
        <a href="https://superteam.fun/earn/listing/meteora-dbc/">Superteam listing</a>
      </footer>
    </div>
  );
}
