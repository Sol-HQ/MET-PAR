import { PLATFORM_FEE_CLAIMER } from "./admins";
import { FEE_SCHEDULER } from "./constants";

/** Meteora's program keeps this percent of every bonding-curve trading fee. It is not editable. */
export const METEORA_TRADING_FEE_PERCENT = 20;

/** Platform percent of the whole trading fee. The token creator receives the rest after Meteora's 20%. */
export const DEFAULT_PLATFORM_FEE_PERCENT = 20;

export type PlatformSettings = {
  openingFeeBps: number;
  platformFeeBps: number;
  /** Percent of the whole trading fee the platform keeps. 20 leaves 60 for the token creator. */
  platformFeePercent: number;
  feeClaimer: string;
  updatedAt: string;
  updatedBy: string;
};

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  openingFeeBps: FEE_SCHEDULER.startingFeeBps,
  platformFeeBps: FEE_SCHEDULER.endingFeeBps,
  platformFeePercent: DEFAULT_PLATFORM_FEE_PERCENT,
  feeClaimer: PLATFORM_FEE_CLAIMER,
  updatedAt: "",
  updatedBy: "",
};

export function settingsMessage(input: {
  openingFeeBps: number;
  platformFeeBps: number;
  platformFeePercent: number;
  issuedAt: number;
}): string {
  return [
    "PAR platform settings",
    `openingFeeBps=${input.openingFeeBps}`,
    `platformFeeBps=${input.platformFeeBps}`,
    `platformFeePercent=${input.platformFeePercent}`,
    `issuedAt=${input.issuedAt}`,
  ].join("\n");
}

export function creatorSharePercent(platformFeePercent: number): number {
  return 100 - METEORA_TRADING_FEE_PERCENT - platformFeePercent;
}

/** Creator's percent of the non-protocol 80%. A 20% platform fee is 75 here, which is 60% of the whole fee. */
export function creatorTradingFeePercentage(platformFeePercent: number): number {
  return (creatorSharePercent(platformFeePercent) * 100) / (100 - METEORA_TRADING_FEE_PERCENT);
}

/**
 * Percents of the permanently locked graduated liquidity. They sum to 100.
 * A 20% platform fee is 25% of the locked position, which is 20% of the pool fee.
 */
export function lockedLiquiditySplit(platformFeePercent: number): { partner: number; creator: number } {
  const partner = (platformFeePercent * 100) / (100 - METEORA_TRADING_FEE_PERCENT);
  return { partner, creator: 100 - partner };
}

export function parseFeePercent(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("Enter a fee like 0.5 or 25.");
  }
  const bps = Math.round(Number(trimmed) * 100);
  if (!Number.isFinite(bps)) throw new Error("Enter a fee like 0.5 or 25.");
  return bps;
}

export function assertPlatformFeePercent(platformFeePercent: number) {
  const creatorPercentage = creatorTradingFeePercentage(platformFeePercent);
  if (
    !Number.isInteger(platformFeePercent) ||
    platformFeePercent < 0 ||
    platformFeePercent > 100 - METEORA_TRADING_FEE_PERCENT ||
    !Number.isInteger(creatorPercentage)
  ) {
    throw new Error("Platform fee must be a whole number from 0 to 80, in steps of 4. 20 is the current law.");
  }
}

export function assertCurveFee(curveFeeBps: number) {
  if (curveFeeBps < 25 || curveFeeBps > 9900) {
    throw new Error("Curve fee must be from 0.25% to 99%.");
  }
}
