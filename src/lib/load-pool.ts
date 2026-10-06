import { getAccount, getMint, getTokenMetadata } from "@solana/spl-token";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  calculateFeeSchedulerEndingBaseFeeBps,
  deriveDammV2PoolAddress,
  feeNumeratorToBps,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getPriceFromSqrtPrice as dammPriceFromSqrt, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { DBC_PROGRAM_ID, MIGRATION_FEE_BPS_BY_OPTION, USDC_DEVNET, USDC_MAINNET, WSOL } from "./constants";
import { formatTokenPrice, rawToUi } from "./format";
import { PUBLIC_ORIGIN } from "./record";

export type PoolSnapshot = {
  address: string;
  baseMint: string;
  quoteMint: string;
  config: string;
  name: string;
  symbol: string;
  /** The frozen token link. */
  uri: string;
  image: string;
  description: string;
  price: string;
  raised: BN;
  threshold: BN;
  percent: number;
  migrationProgress: number;
  isMigrated: boolean;
  trading: boolean;
  canMigrate: boolean;
  quoteSymbol: string;
  quoteDecimals: number;
  baseDecimals: number;
  dammPool: string | null;
  baseVault: string;
  quoteVault: string;
  startPrice: string;
  endPrice: string;
  shelfPrice: string | null;
  supply: string;
  creator: string;
  feeClaimer: string;
  /** Unused base tokens left on the curve after graduation. */
  leftoverBase: BN;
  leftoverReceiver: string;
  leftoverWithdrawn: boolean;
  /** Meteora's 0.2% migration fee, still sitting on the curve. Their program wallet claims it. */
  protocolMigrationBase: BN;
  protocolMigrationQuote: BN;
  partnerBaseFee: BN;
  partnerQuoteFee: BN;
  creatorBaseFee: BN;
  creatorQuoteFee: BN;
  /** Meteora's unclaimed share of the curve trading fee. Their program keeps it. */
  protocolBaseFee: BN;
  protocolQuoteFee: BN;
  /** Tokens still sitting in the curve vault. */
  baseReserve: BN;
  /** Creator's percent of the fee left after Meteora's 20%. 75 means 60% of the whole fee. */
  creatorTradingFeePercentage: number;
  partnerLockedLiquidity: number;
  creatorLockedLiquidity: number;
  partnerVestingLiquidity: number;
  creatorVestingLiquidity: number;
  /** Seconds the opening fee takes to settle. 0 means the curve fee is flat. */
  feeDecaySeconds: number;
  /** Opening trading fee in basis points, read from the template. */
  openingFeeBps: number;
  /** Settled trading fee in basis points, read from the template. */
  endingFeeBps: number;
  /** Pool fee after migration, in basis points. */
  migrationFeeBps: number;
  /** Share of the pool fee put back into the pool. 0 means compounding is off. */
  compoundingFeeBps: number;
  /** The Meteora DAMM v2 config this curve graduates into. */
  dammConfig: string | null;
  /** True after the curve fills and before the creator supply is locked. */
  needsLocker: boolean;
  vestingCliffUnlock: BN;
  vestingPerPeriod: BN;
  vestingPeriods: number;
  vestingFrequency: number;
  vestingCliffSeconds: number;
};

export type DammMarket = {
  spot: string;
  base: BN;
  quote: BN;
  baseVault: string;
  quoteVault: string;
};

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function accountNumber(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === "object" && "toString" in value ? String(value) : String(value);
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readBorshString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset, true);
  const start = offset + 4;
  const slice = bytes.subarray(start, start + length);
  return {
    value: new TextDecoder().decode(slice).replaceAll("\0", "").trim(),
    next: start + length,
  };
}

export async function readTokenName(
  connection: Connection,
  mint: PublicKey,
): Promise<{ name: string; symbol: string; uri: string }> {
  const [metadata] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  );
  const account = await connection.getAccountInfo(metadata);
  if (!account) return { name: "Listing", symbol: "TOKEN", uri: "" };
  try {
    const name = readBorshString(account.data, 65);
    const symbol = readBorshString(account.data, name.next);
    const uri = readBorshString(account.data, symbol.next);
    return {
      name: name.value || "Listing",
      symbol: symbol.value || "TOKEN",
      uri: uri.value,
    };
  } catch {
    return { name: "Listing", symbol: "TOKEN", uri: "" };
  }
}

async function readOffChain(uri: string): Promise<{ image: string; description: string }> {
  if (!uri.startsWith("http")) return { image: "", description: "" };
  const sameSite = typeof window !== "undefined" && uri.startsWith(`${PUBLIC_ORIGIN}/r/`);
  try {
    const response = await fetch(sameSite ? uri.slice(PUBLIC_ORIGIN.length) : uri);
    if (!response.ok) return { image: "", description: "" };
    const body = (await response.json()) as { image?: string; description?: string };
    return {
      image: typeof body.image === "string" ? body.image : "",
      description: typeof body.description === "string" ? body.description.trim() : "",
    };
  } catch {
    return { image: "", description: "" };
  }
}

export async function loadPool(connection: Connection, address: string): Promise<PoolSnapshot> {
  const poolKey = new PublicKey(address);
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const pool = await client.state.getPool(poolKey).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "";
    if (/discriminator/i.test(message)) return null;
    throw cause;
  });
  if (!pool) throw new Error("No DBC pool at that address.");
  const config = await client.state.getPoolConfig(pool.poolState.config);
  if (!config) throw new Error("The pool config account is missing.");

  const quoteMint = new PublicKey(config.quoteMint);
  const quoteMintInfo = await getMint(connection, quoteMint);
  const baseDecimals = config.tokenDecimal;
  const quoteDecimals = quoteMintInfo.decimals;
  const raised = new BN(pool.poolState.quoteReserve.toString());
  const threshold = new BN(config.migrationQuoteThreshold.toString());
  const percent = threshold.isZero()
    ? 0
    : Math.min(100, raised.mul(new BN(10_000)).div(threshold).toNumber() / 100);
  const migrationProgress = Number(pool.poolState.migrationProgress);
  const isMigrated = Number(pool.poolState.isMigrated) === 1 || migrationProgress === 3;
  const price = getPriceFromSqrtPrice(pool.poolState.sqrtPrice, baseDecimals, quoteDecimals);
  const startPrice = getPriceFromSqrtPrice(config.sqrtStartPrice, baseDecimals, quoteDecimals);
  const active = config.curve.filter((point) => !new BN(point.liquidity.toString()).isZero());
  const migrationSqrt = config.migrationSqrtPrice;
  const endPrice = migrationSqrt
    ? getPriceFromSqrtPrice(migrationSqrt, baseDecimals, quoteDecimals)
    : startPrice;
  const firstPrice = active.length >= 2 ? getPriceFromSqrtPrice(active[0].sqrtPrice, baseDecimals, quoteDecimals) : null;
  const lift = firstPrice ? firstPrice.div(startPrice) : null;
  const shelfPrice =
    firstPrice && lift && lift.gt(1) && lift.lte(1.12) && firstPrice.lt(endPrice)
      ? formatTokenPrice(firstPrice)
      : null;
  const names = await readTokenName(connection, pool.poolState.baseMint);
  const offChain = await readOffChain(names.uri);
  const knownQuote = quoteMint.toBase58() === WSOL ? "SOL" : [USDC_DEVNET, USDC_MAINNET].includes(quoteMint.toBase58()) ? "USDC" : "";
  const quoteMeta = knownQuote ? null : await readTokenName(connection, quoteMint);
  let quoteSymbol = knownQuote || (quoteMeta && quoteMeta.symbol !== "TOKEN" ? quoteMeta.symbol : "");
  if (!quoteSymbol) {
    try {
      const metadata = await getTokenMetadata(connection, quoteMint, "confirmed");
      quoteSymbol = metadata?.symbol?.replaceAll("\0", "").trim() || "quote";
    } catch {
      quoteSymbol = "quote";
    }
  }
  const periods = Number(config.poolFees.baseFee.firstFactor);
  const frequency = Number(config.poolFees.baseFee.secondFactor.toString());
  const feeDecaySeconds = periods > 0 && frequency > 0 ? periods * frequency : 0;
  const openingFeeBps = feeNumeratorToBps(config.poolFees.baseFee.cliffFeeNumerator);
  const endingFeeBps = Math.round(
    calculateFeeSchedulerEndingBaseFeeBps(
      Number(config.poolFees.baseFee.cliffFeeNumerator.toString()),
      periods,
      frequency,
      Number(config.poolFees.baseFee.thirdFactor.toString()),
      config.poolFees.baseFee.baseFeeMode,
    ),
  );
  let vaultBase = new BN(0);
  try {
    const vault = await getAccount(connection, pool.poolState.baseVault);
    vaultBase = new BN(vault.amount.toString());
  } catch {
    // A missing vault means there is nothing left to withdraw.
  }
  const reservedBase = new BN(pool.poolState.protocolBaseFee.toString())
    .add(new BN(pool.poolState.partnerBaseFee.toString()))
    .add(new BN(pool.poolState.creatorBaseFee.toString()))
    .add(new BN(pool.poolState.protocolMigrationBaseFeeAmount.toString()));
  const leftoverBase = vaultBase.gt(reservedBase) ? vaultBase.sub(reservedBase) : new BN(0);
  const feeOption = Number(config.migrationFeeOption);
  const fixedFeeBps = MIGRATION_FEE_BPS_BY_OPTION[feeOption];
  const migrationFeeBps = fixedFeeBps ?? accountNumber(config.migratedPoolFeeBps);
  const compoundingFeeBps = fixedFeeBps ? 0 : accountNumber(config.migratedCompoundingFeeBps);
  const dammConfigAccount = DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption];
  const dammConfig = dammConfigAccount ? dammConfigAccount.toBase58() : null;
  const dammPool =
    isMigrated && dammConfigAccount
      ? deriveDammV2PoolAddress(dammConfigAccount, pool.poolState.baseMint, quoteMint).toBase58()
      : null;

  return {
    address: poolKey.toBase58(),
    baseMint: pool.poolState.baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    config: pool.poolState.config.toBase58(),
    name: names.name,
    symbol: names.symbol,
    uri: names.uri,
    image: offChain.image,
    description: offChain.description,
    price: formatTokenPrice(price),
    raised,
    threshold,
    percent,
    migrationProgress,
    isMigrated,
    trading: migrationProgress === 0 && !isMigrated,
    canMigrate: migrationProgress === 2 && !isMigrated,
    quoteSymbol,
    quoteDecimals,
    baseDecimals,
    dammPool,
    baseVault: pool.poolState.baseVault.toBase58(),
    quoteVault: pool.poolState.quoteVault.toBase58(),
    startPrice: formatTokenPrice(startPrice),
    endPrice: formatTokenPrice(endPrice),
    shelfPrice,
    supply: rawToUi(new BN(config.preMigrationTokenSupply.toString()), baseDecimals),
    creator: pool.poolState.creator.toBase58(),
    feeClaimer: config.feeClaimer.toBase58(),
    leftoverBase,
    leftoverReceiver: config.leftoverReceiver.toBase58(),
    leftoverWithdrawn: Number(pool.poolState.isWithdrawLeftover) === 1,
    protocolMigrationBase: new BN(pool.poolState.protocolMigrationBaseFeeAmount.toString()),
    protocolMigrationQuote: new BN(pool.poolState.protocolMigrationQuoteFeeAmount.toString()),
    partnerBaseFee: new BN(pool.poolState.partnerBaseFee.toString()),
    partnerQuoteFee: new BN(pool.poolState.partnerQuoteFee.toString()),
    creatorBaseFee: new BN(pool.poolState.creatorBaseFee.toString()),
    creatorQuoteFee: new BN(pool.poolState.creatorQuoteFee.toString()),
    protocolBaseFee: new BN(pool.poolState.protocolBaseFee.toString()),
    protocolQuoteFee: new BN(pool.poolState.protocolQuoteFee.toString()),
    baseReserve: new BN(pool.poolState.baseReserve.toString()),
    creatorTradingFeePercentage: Number(config.creatorTradingFeePercentage),
    partnerLockedLiquidity: Number(config.partnerPermanentLockedLiquidityPercentage),
    creatorLockedLiquidity: Number(config.creatorPermanentLockedLiquidityPercentage),
    partnerVestingLiquidity: Number(config.partnerLiquidityPercentage),
    creatorVestingLiquidity: Number(config.creatorLiquidityPercentage),
    feeDecaySeconds,
    openingFeeBps,
    endingFeeBps,
    migrationFeeBps,
    compoundingFeeBps,
    dammConfig,
    needsLocker: migrationProgress === 1,
    vestingCliffUnlock: new BN(config.lockedVestingConfig.cliffUnlockAmount.toString()),
    vestingPerPeriod: new BN(config.lockedVestingConfig.amountPerPeriod.toString()),
    vestingPeriods: Number(config.lockedVestingConfig.numberOfPeriod.toString()),
    vestingFrequency: Number(config.lockedVestingConfig.frequency.toString()),
    vestingCliffSeconds: Number(config.lockedVestingConfig.cliffDurationFromMigrationTime.toString()),
  };
}

export async function loadDammMarket(connection: Connection, snapshot: PoolSnapshot): Promise<DammMarket | null> {
  if (!snapshot.dammPool) return null;
  const cpAmm = new CpAmm(connection);
  const state = await cpAmm.fetchPoolState(new PublicKey(snapshot.dammPool));
  const baseMint = new PublicKey(snapshot.baseMint);
  const aIsBase = state.tokenAMint.equals(baseMint);
  const aDecimals = aIsBase ? snapshot.baseDecimals : snapshot.quoteDecimals;
  const bDecimals = aIsBase ? snapshot.quoteDecimals : snapshot.baseDecimals;
  const quoted = dammPriceFromSqrt(state.sqrtPrice, aDecimals, bDecimals);
  const spot = aIsBase ? quoted : quoted.pow(-1);
  const [vaultA, vaultB] = await Promise.all([
    getAccount(connection, state.tokenAVault, "confirmed", getTokenProgram(state.tokenAFlag)),
    getAccount(connection, state.tokenBVault, "confirmed", getTokenProgram(state.tokenBFlag)),
  ]);
  const base = new BN((aIsBase ? vaultA.amount : vaultB.amount).toString());
  const quote = new BN((aIsBase ? vaultB.amount : vaultA.amount).toString());
  return {
    spot: formatTokenPrice(spot),
    base,
    quote,
    baseVault: (aIsBase ? state.tokenAVault : state.tokenBVault).toBase58(),
    quoteVault: (aIsBase ? state.tokenBVault : state.tokenAVault).toBase58(),
  };
}

const POOL_MIGRATED_AT = 305;
const POOL_FINISHED_AT = 344;

/** Whether this curve has graduated, and the second it did. The sale clock starts there. */
export async function curveSale(connection: Connection, pool: string): Promise<{ graduated: boolean; finishedAt: number } | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(pool), "confirmed");
    if (!info || info.owner.toBase58() !== DBC_PROGRAM_ID || info.data.length < POOL_FINISHED_AT + 8) return null;
    return { graduated: info.data[POOL_MIGRATED_AT] === 1, finishedAt: Number(info.data.readBigUInt64LE(POOL_FINISHED_AT)) };
  } catch {
    return null;
  }
}
