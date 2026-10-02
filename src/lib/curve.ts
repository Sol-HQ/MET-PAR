import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  validateConfigParameters,
  type BuildCurveBaseParams,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair } from "@solana/web3.js";
import {
  BASE_DECIMALS,
  DAMM_V2_FEE_25_BPS,
  END_PRICE_MULTIPLE,
  END_PRICE_USDC,
  FEE_SCHEDULER,
  PRESETS,
  QUOTE_DECIMALS,
  START_PRICE_USDC,
  type PresetId,
} from "./constants";

function sharedCurveInputs(preset: PresetId): BuildCurveBaseParams {
  const spec = PRESETS[preset];
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: QUOTE_DECIMALS,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: spec.totalTokenSupply,
      leftover: spec.leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: FEE_SCHEDULER.startingFeeBps,
          endingFeeBps: FEE_SCHEDULER.endingFeeBps,
          numberOfPeriod: FEE_SCHEDULER.numberOfPeriod,
          totalDuration: FEE_SCHEDULER.totalDuration,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
  };
}

export function buildPresetConfig(preset: PresetId): ConfigParameters {
  const sqrtPrices = [
    getSqrtPriceFromPrice(START_PRICE_USDC, TokenDecimal.SIX, QUOTE_DECIMALS),
    getSqrtPriceFromPrice(END_PRICE_USDC, TokenDecimal.SIX, QUOTE_DECIMALS),
  ];
  return buildCurveWithCustomSqrtPrices({
    ...sharedCurveInputs(preset),
    sqrtPrices,
    liquidityWeights: [1],
  });
}

export type CurveCheck = {
  preset: PresetId;
  points: number;
  startPrice: string;
  endPrice: string;
  ratio: string;
  migrationQuoteThreshold: string;
  migrationFeeOption: number;
  baseFeeMode: number;
  dammConfig: string;
};

export function inspectPreset(preset: PresetId): CurveCheck {
  const config = buildPresetConfig(preset);
  validateConfigParameters({
    ...config,
    leftoverReceiver: Keypair.generate().publicKey,
  });
  const start = getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, QUOTE_DECIMALS);
  const end = getPriceFromSqrtPrice(config.curve[0].sqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS);
  const activePoints = config.curve.filter((point) => !point.liquidity.isZero());
  return {
    preset,
    points: activePoints.length,
    startPrice: start.toSignificantDigits(8).toString(),
    endPrice: end.toSignificantDigits(8).toString(),
    ratio: end.div(start).toSignificantDigits(8).toString(),
    migrationQuoteThreshold: config.migrationQuoteThreshold.toString(),
    migrationFeeOption: config.migrationFeeOption,
    baseFeeMode: config.poolFees.baseFee.baseFeeMode,
    dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps25].toBase58(),
  };
}

export function assertPreset(preset: PresetId): CurveCheck {
  const check = inspectPreset(preset);
  const spec = PRESETS[preset];
  const expectedThreshold = spec.migrationQuoteThreshold;
  const ratio = Number(check.ratio);
  if (check.points !== 1) {
    throw new Error(`${preset} curve has ${check.points} segments`);
  }
  if (check.migrationQuoteThreshold !== expectedThreshold) {
    throw new Error(
      `${preset} threshold is ${check.migrationQuoteThreshold}, expected ${expectedThreshold}`,
    );
  }
  if (Math.abs(ratio - END_PRICE_MULTIPLE) > 0.000001) {
    throw new Error(`${preset} price ratio is ${check.ratio}`);
  }
  if (check.baseFeeMode !== BaseFeeMode.FeeSchedulerExponential) {
    throw new Error(`${preset} base fee mode is ${check.baseFeeMode}`);
  }
  if (check.migrationFeeOption !== MigrationFeeOption.FixedBps25) {
    throw new Error(`${preset} migration fee option is ${check.migrationFeeOption}`);
  }
  if (check.dammConfig !== DAMM_V2_FEE_25_BPS) {
    throw new Error(`${preset} DAMM v2 config is ${check.dammConfig}`);
  }
  return check;
}
