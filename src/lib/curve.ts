import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  type BuildCurveBaseParams,
  type LockedVestingParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { FEE_DECAY_CHOICES, FEE_SCHEDULER, QUOTE_DECIMALS } from "./constants";
import { creatorTradingFeePercentage, lockedLiquiditySplit } from "./platform";

function migrationFeeOption(bps: number): MigrationFeeOption {
  switch (bps) {
    case 25:
      return MigrationFeeOption.FixedBps25;
    case 30:
      return MigrationFeeOption.FixedBps30;
    case 100:
      return MigrationFeeOption.FixedBps100;
    case 200:
      return MigrationFeeOption.FixedBps200;
    case 400:
      return MigrationFeeOption.FixedBps400;
    case 600:
      return MigrationFeeOption.FixedBps600;
    default:
      throw new Error("That pool fee after migration is not one of the choices.");
  }
}

/** How the fee falls, and whether pool fees after the lock go back into the pool. */
export type CurveShape = {
  straightFall?: boolean;
  dynamicFee?: boolean;
  compound?: { poolFeeBps: number; compoundingBps: number } | null;
};

export function readCurveShape(input: {
  straightFall: boolean;
  dynamicFee: boolean;
  compoundOn: boolean;
  poolFeePercent: string;
  compoundPercent: string;
}): { shape: CurveShape; error: string } {
  const shape: CurveShape = {
    straightFall: input.straightFall,
    dynamicFee: input.dynamicFee,
    compound: null,
  };
  if (!input.compoundOn) return { shape, error: "" };
  const pool = Number(input.poolFeePercent);
  const share = Number(input.compoundPercent);
  if (!Number.isFinite(pool) || pool < 0.1 || pool > 10) {
    return { shape, error: "The pool fee, when fees go back into the pool, is from 0.1% to 10%." };
  }
  if (!Number.isFinite(share) || share < 1 || share > 100) {
    return { shape, error: "The share put back into the pool is from 1% to 100%." };
  }
  shape.compound = { poolFeeBps: Math.round(pool * 100), compoundingBps: Math.round(share * 100) };
  return { shape, error: "" };
}

export function curveBase(
  totalTokenSupply: number,
  leftover: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  quoteDecimals = QUOTE_DECIMALS,
  lockedVesting: LockedVestingParams = {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  shape?: CurveShape,
): BuildCurveBaseParams {
  const flat = openingFeeBps === endingFeeBps;
  if (!flat && !FEE_DECAY_CHOICES.some((choice) => choice.seconds === feeDurationSeconds)) {
    throw new Error("That fee timing is not one of the allowed choices.");
  }
  const locked = lockedLiquiditySplit(platformFeePercent);
  const compound = shape?.compound ?? null;
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteDecimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply,
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: flat || shape?.straightFall ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: openingFeeBps,
          endingFeeBps,
          numberOfPeriod: flat ? 0 : FEE_SCHEDULER.numberOfPeriod,
          totalDuration: flat ? 0 : feeDurationSeconds,
        },
      },
      dynamicFeeEnabled: shape?.dynamicFee === true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorTradingFeePercentage(platformFeePercent),
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: compound ? MigrationFeeOption.Customizable : migrationFeeOption(migrationFeeBps),
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      ...(compound
        ? {
            migratedPoolFee: {
              collectFeeMode: MigratedCollectFeeMode.Compounding,
              dynamicFee: DammV2DynamicFeeMode.Disabled,
              poolFeeBps: compound.poolFeeBps,
              compoundingFeeBps: compound.compoundingBps,
            },
          }
        : {}),
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: locked.partner,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: locked.creator,
    },
    lockedVesting,
    activationType: ActivationType.Timestamp,
  };
}
