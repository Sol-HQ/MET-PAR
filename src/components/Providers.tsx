"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { rpcUrl, type ClusterName } from "@/lib/constants";
import { ClusterContext } from "@/lib/cluster";

import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  const [cluster, setClusterState] = useState<ClusterName>("devnet");
  const setCluster = useCallback((next: ClusterName) => {
    setClusterState(next);
    try {
      localStorage.setItem("par-cluster", next);
    } catch {
      // A private browser can refuse storage. The toggle still works for this visit.
    }
  }, []);
  useEffect(() => {
    try {
      const named = new URLSearchParams(window.location.search).get("c");
      if (named === "mainnet") {
        setClusterState("mainnet-beta");
        return;
      }
      if (named === "devnet") {
        setClusterState("devnet");
        return;
      }
      const saved = localStorage.getItem("par-cluster");
      if (saved === "mainnet-beta" || saved === "devnet") setClusterState(saved);
    } catch {
      // The default stays the practice network.
    }
  }, []);
  const endpoint = rpcUrl(cluster);
  const network = cluster === "devnet" ? WalletAdapterNetwork.Devnet : WalletAdapterNetwork.Mainnet;
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })],
    [network],
  );

  return (
    <ClusterContext.Provider value={{ cluster, setCluster }}>
      <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ClusterContext.Provider>
  );
}
