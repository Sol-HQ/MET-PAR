import { PublicKey } from "@solana/web3.js";
import published from "../../configs/published.json";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_FEE_25_BPS = "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd";

export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const QUOTE_DECIMALS = 6;
export const BASE_DECIMALS = 6;
export const START_PRICE_USDC = "0.999669023512";
export const END_PRICE_USDC = "1.149619377038";
export const END_PRICE_MULTIPLE = 1.15;
export const OPENS_AT = "$1";
export const ENDS_AT = "$1.15";

export const FEE_SCHEDULER = {
  startingFeeBps: 5000,
  endingFeeBps: 100,
  numberOfPeriod: 60,
  totalDuration: 3600,
} as const;

export type ClusterName = "devnet" | "mainnet-beta";
export type PresetId = "par" | "demo";

export type PresetSpec = {
  id: PresetId;
  label: string;
  summary: string;
  migrationQuoteThreshold: string;
  thresholdLabel: string;
  cardFull: string;
  totalTokenSupply: number;
  leftover: number;
  devnetOnly: boolean;
};

export const PRESETS: Record<PresetId, PresetSpec> = {
  par: {
    id: "par",
    label: "Par",
    summary: "Opens at $1, ends at $1.15, and Meteora graduates it at 750 USDC.",
    migrationQuoteThreshold: "750000000",
    thresholdLabel: "750 USDC",
    cardFull: "$750",
    totalTokenSupply: 1_352,
    leftover: 0,
    devnetOnly: false,
  },
  demo: {
    id: "demo",
    label: "Demo",
    summary: "The same $1 to $1.15 curve with a 1.109466 USDC graduation threshold. Devnet only.",
    migrationQuoteThreshold: "1109466",
    thresholdLabel: "1.109466 USDC",
    cardFull: "1.109466 USDC",
    totalTokenSupply: 2,
    leftover: 0,
    devnetOnly: true,
  },
};

export function clusterKey(cluster: ClusterName): "devnet" | "mainnet" {
  return cluster === "devnet" ? "devnet" : "mainnet";
}

export function rpcUrl(cluster: ClusterName): string {
  if (cluster === "devnet") {
    return process.env.NEXT_PUBLIC_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  }
  return process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
}

export function quoteMintAddress(cluster: ClusterName): PublicKey {
  return new PublicKey(cluster === "devnet" ? USDC_DEVNET : USDC_MAINNET);
}

export function publishedConfigAddress(cluster: ClusterName, preset: PresetId): string {
  const fromEnv =
    cluster === "devnet"
      ? preset === "par"
        ? process.env.NEXT_PUBLIC_DEVNET_PAR_CONFIG
        : process.env.NEXT_PUBLIC_DEVNET_DEMO_CONFIG
      : preset === "par"
        ? process.env.NEXT_PUBLIC_MAINNET_PAR_CONFIG
        : "";
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const file = published[clusterKey(cluster)];
  if (preset === "demo") {
    return "demo" in file ? file.demo : "";
  }
  return file.par;
}

export function configPublicKey(cluster: ClusterName, preset: PresetId): PublicKey | null {
  const address = publishedConfigAddress(cluster, preset);
  if (!address) return null;
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}

export function explorerAccount(address: string, cluster: ClusterName): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

export function explorerTx(signature: string, cluster: ClusterName): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
