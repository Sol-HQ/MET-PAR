import { PublicKey } from "@solana/web3.js";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_FEE_25_BPS = "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd";

/** Meteora's fixed DAMM v2 configs. The index matches MigrationFeeOption. */
const DAMM_V2_FEE_CONFIG_BY_BPS: Record<number, string> = {
  25: DAMM_V2_FEE_25_BPS,
  30: "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
  100: "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  200: "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
  400: "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD",
  600: "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
};

/** The DAMM v2 config for the fee written into this curve. */
export function dammV2FeeConfig(bps: number): string | null {
  return DAMM_V2_FEE_CONFIG_BY_BPS[bps] ?? null;
}

export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** Wrapped SOL. The same mint on the practice network and the real network. */
export const WSOL = "So11111111111111111111111111111111111111112";

export const QUOTE_DECIMALS = 6;
export const SOL_DECIMALS = 9;

export type QuoteKind = "usdc" | "sol" | "other";
export const BASE_DECIMALS = 6;

/** Sixty steps. The clock is the creator's choice; each step is that choice divided by 60. */
export const FEE_DECAY_PERIODS = 60;

export const FEE_DECAY_CHOICES = [
  { seconds: 1 * 60 * 60, label: "1 hour" },
  { seconds: 6 * 60 * 60, label: "6 hours" },
  { seconds: 12 * 60 * 60, label: "12 hours" },
  { seconds: 24 * 60 * 60, label: "24 hours" },
  { seconds: 48 * 60 * 60, label: "48 hours" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" },
] as const;

export const DEFAULT_FEE_DECAY_SECONDS = 12 * 60 * 60;

/** Pool fee after migration. The order matches Meteora's fixed DAMM v2 choices. */
export const MIGRATION_FEE_CHOICES = [
  { bps: 25, label: "0.25%" },
  { bps: 30, label: "0.30%" },
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
  { bps: 400, label: "4%" },
  { bps: 600, label: "6%" },
] as const;

export const DEFAULT_MIGRATION_FEE_BPS = 25;

export function migrationFeeLabel(bps: number): string {
  return MIGRATION_FEE_CHOICES.find((choice) => choice.bps === bps)?.label ?? "0.25%";
}

/** Index is Meteora's MigrationFeeOption. Customizable has no fixed percent. */
export const MIGRATION_FEE_BPS_BY_OPTION = [25, 30, 100, 200, 400, 600] as const;

/** Exponential decay from the opening fee to the settled fee. */
export const FEE_SCHEDULER = {
  startingFeeBps: 5000,
  endingFeeBps: 100,
  numberOfPeriod: FEE_DECAY_PERIODS,
  totalDuration: DEFAULT_FEE_DECAY_SECONDS,
} as const;

export function feeDecayLabel(seconds: number): string {
  const match = FEE_DECAY_CHOICES.find((choice) => choice.seconds === seconds);
  if (match) return match.label;
  if (seconds === 60 * 60) return "1 hour";
  const hours = seconds / 3600;
  if (Number.isInteger(hours) && hours > 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${seconds.toLocaleString("en-US")} seconds`;
}

export type ClusterName = "devnet" | "mainnet-beta";

export function rpcUrl(cluster: ClusterName): string {
  if (cluster === "devnet") {
    return process.env.NEXT_PUBLIC_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  }
  return process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
}

export function quoteDecimalsFor(kind: QuoteKind): number {
  if (kind === "sol") return SOL_DECIMALS;
  return QUOTE_DECIMALS;
}

export function quoteLabel(kind: QuoteKind): string {
  if (kind === "sol") return "SOL";
  if (kind === "other") return "quote";
  return "USDC";
}

export function quoteMintAddress(cluster: ClusterName, kind: QuoteKind = "usdc"): PublicKey {
  if (kind === "sol") return new PublicKey(WSOL);
  return new PublicKey(cluster === "devnet" ? USDC_DEVNET : USDC_MAINNET);
}

export function acceptedQuoteMints(cluster: ClusterName): string[] {
  return [quoteMintAddress(cluster, "usdc").toBase58(), quoteMintAddress(cluster, "sol").toBase58()];
}

/** The trading pool on Meteora. It exists only after the curve has filled and the pool has opened. */
export function meteoraPoolUrl(address: string, cluster: ClusterName): string {
  const host = cluster === "devnet" ? "https://devnet.meteora.ag" : "https://app.meteora.ag";
  return `${host}/dammv2/${address}`;
}

export function explorerAccount(address: string, cluster: ClusterName): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

/** Practice curves taken off the desk. The accounts stay on the practice network. */
export const HIDDEN_POOLS = new Set([
  "Dze24rViH4WjUHwmvBAc7pUf4thm418L3ZLLq9Tq8ktC",
  "BNrT6yHV8CQfJVc4gLERpH2RQiykVyq4vNampeBz7rFz",
]);

export function explorerTx(signature: string, cluster: ClusterName): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
