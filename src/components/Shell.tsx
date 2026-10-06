"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { ReactNode } from "react";
import { isAdminWallet } from "@/lib/admins";
import { DBC_PROGRAM_ID } from "@/lib/constants";
import { useCluster } from "@/lib/cluster";

export function Shell({ children }: { children: ReactNode }) {
  const { cluster, setCluster } = useCluster();
  const { publicKey } = useWallet();
  const admin = isAdminWallet(publicKey?.toBase58());

  return (
    <div className="page">
      <header className="top">
        <Link href="/" className="brand">
          <span className="mark">PAR</span>
          <span className="brand-line">Fair launch on Meteora</span>
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
          <Link href="/pools" className="admin-link">
            Pools
          </Link>
          <Link href="/faqs" className="admin-link">
            FAQs
          </Link>
          {admin ? (
            <Link href="/admin" className="admin-link">
              Admin
            </Link>
          ) : null}
          <WalletMultiButton />
        </div>
      </header>
      <p className="note sec-line">
        PAR uses its best means to be SEC compliant. Do not promise that a price will go up, or promise a return.
      </p>
      {cluster === "mainnet-beta" ? (
        <p className="banner">
          Mainnet spends real SOL and USDC. PAR shows the exact amounts and waits for a second
          confirmation before the wallet opens.
        </p>
      ) : null}
      <main>{children}</main>
      <footer>
        <span>DBC program {DBC_PROGRAM_ID}</span>
        <a href="https://app.meteora.ag">Meteora</a>
      </footer>
    </div>
  );
}
