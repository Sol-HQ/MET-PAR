import { getMint } from "@solana/spl-token";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { USDC_DEVNET, USDC_MAINNET } from "./constants";

export type PoolSnapshot = {
  address: string;
  baseMint: string;
  quoteMint: string;
  config: string;
  name: string;
  symbol: string;
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
  startPrice: string;
  endPrice: string;
};

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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

async function readTokenName(connection: Connection, mint: PublicKey): Promise<{ name: string; symbol: string }> {
  const [metadata] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  );
  const account = await connection.getAccountInfo(metadata);
  if (!account) return { name: "Listing", symbol: "TOKEN" };
  try {
    const name = readBorshString(account.data, 65);
    const symbol = readBorshString(account.data, name.next);
    return {
      name: name.value || "Listing",
      symbol: symbol.value || "TOKEN",
    };
  } catch {
    return { name: "Listing", symbol: "TOKEN" };
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
  const endSqrt = config.curve.find((point) => !new BN(point.liquidity.toString()).isZero())?.sqrtPrice;
  const endPrice = endSqrt
    ? getPriceFromSqrtPrice(endSqrt, baseDecimals, quoteDecimals)
    : startPrice;
  const names = await readTokenName(connection, pool.poolState.baseMint);
  const quoteSymbol = [USDC_DEVNET, USDC_MAINNET].includes(quoteMint.toBase58()) ? "USDC" : "quote";
  const feeOption = Number(config.migrationFeeOption);
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption];
  const dammPool =
    isMigrated && dammConfig
      ? deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, quoteMint).toBase58()
      : null;

  return {
    address: poolKey.toBase58(),
    baseMint: pool.poolState.baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    config: pool.poolState.config.toBase58(),
    name: names.name,
    symbol: names.symbol,
    price: price.toSignificantDigits(8).toString(),
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
    startPrice: startPrice.toSignificantDigits(8).toString(),
    endPrice: endPrice.toSignificantDigits(8).toString(),
  };
}
