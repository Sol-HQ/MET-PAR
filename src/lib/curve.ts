import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
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
): BuildCurveBaseParams {
  const flat = openingFeeBps === endingFeeBps;
  if (!flat && !FEE_DECAY_CHOICES.some((choice) => choice.seconds === feeDurationSeconds)) {
    throw new Error("That fee timing is not one of the allowed choices.");
  }
  const locked = lockedLiquiditySplit(platformFeePercent);
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
        baseFeeMode: flat ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: openingFeeBps,
          endingFeeBps,
          numberOfPeriod: flat ? 0 : FEE_SCHEDULER.numberOfPeriod,
          totalDuration: flat ? 0 : feeDurationSeconds,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorTradingFeePercentage(platformFeePercent),
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: migrationFeeOption(migrationFeeBps),
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
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
