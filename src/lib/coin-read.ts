import { getMint, getTokenMetadata, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { DBC_PROGRAM_ID } from "./constants";
import { loadPool } from "./load-pool";
import { METEORA_TRADING_FEE_PERCENT } from "./platform";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A coin that already exists. Every field is read from that coin. */
export type CoinFacts = {
  mint: string;
  pool: string;
  config: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  quoteMint: string;
  quoteSymbol: string;
  startPrice: string;
  endPrice: string;
  /** Opening price times the whole supply, as a display number. */
  wholeAtPar: string;
  openingFeeBps: number;
  endingFeeBps: number;
  migrationFeeBps: number;
  compoundingFeeBps: number;
  feeDecaySeconds: number;
  /** Creator's percent of the fee left after Meteora's 20%. Read from the coin's config. */
  creatorTradingFeePercentage: number;
  /** PAR's percent of the whole trading fee, derived from the coin's config. */
  platformFeePercent: number;
  /** Creator's percent of the whole trading fee, derived from the coin's config. */
  creatorFeePercent: number;
  isMigrated: boolean;
  uri: string;
};

/** The token a no-coin title is priced in. */
export type PayFacts = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
};

/** Whole-fee split from the coin's stored creator percentage. */
export function feeShares(creatorOfRemainder: number): { platform: number; creator: number } {
  const creator = (creatorOfRemainder * (100 - METEORA_TRADING_FEE_PERCENT)) / 100;
  return { creator, platform: 100 - METEORA_TRADING_FEE_PERCENT - creator };
}

function wholeAtPar(startPrice: string, supply: string): string {
  const start = Number(startPrice);
  const tokens = Number(supply.replace(/,/g, ""));
  if (!Number.isFinite(start) || !Number.isFinite(tokens) || start <= 0 || tokens <= 0) return "";
  return (start * tokens).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** The PAR coin for this token address. Fails when this network has no curve for it. */
export async function readCoin(connection: Connection, mint: string): Promise<CoinFacts> {
  const trimmed = mint.trim();
  if (!ADDRESS.test(trimmed)) throw new Error("Paste the token address.");
  const key = new PublicKey(trimmed);
  const found = await connection.getProgramAccounts(new PublicKey(DBC_PROGRAM_ID), {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: 424 },
      { memcmp: { offset: 136, bytes: key.toBase58() } },
    ],
  });
  if (!found.length) {
    throw new Error("No PAR coin on this network uses that token address. Create the coin on the home page, then paste its token address here.");
  }
  const snapshot = await loadPool(connection, found[0].pubkey.toBase58());
  if (snapshot.baseMint !== key.toBase58()) throw new Error("That pool is not this token.");
  const shares = feeShares(snapshot.creatorTradingFeePercentage);
  return {
    mint: snapshot.baseMint,
    pool: snapshot.address,
    config: snapshot.config,
    name: snapshot.name,
    symbol: snapshot.symbol,
    decimals: snapshot.baseDecimals,
    supply: snapshot.supply,
    quoteMint: snapshot.quoteMint,
    quoteSymbol: snapshot.quoteSymbol,
    startPrice: snapshot.startPrice,
    endPrice: snapshot.endPrice,
    wholeAtPar: wholeAtPar(snapshot.startPrice, snapshot.supply),
    openingFeeBps: snapshot.openingFeeBps,
    endingFeeBps: snapshot.endingFeeBps,
    migrationFeeBps: snapshot.migrationFeeBps,
    compoundingFeeBps: snapshot.compoundingFeeBps,
    feeDecaySeconds: snapshot.feeDecaySeconds,
    creatorTradingFeePercentage: snapshot.creatorTradingFeePercentage,
    platformFeePercent: shares.platform,
    creatorFeePercent: shares.creator,
    isMigrated: snapshot.isMigrated,
    uri: snapshot.uri,
  };
}

/** An ordinary SPL token the escrow can settle. Token-2022 is refused before a sale can be opened. */
export async function readClassicMint(connection: Connection, mint: string): Promise<PayFacts> {
  const trimmed = mint.trim();
  if (!ADDRESS.test(trimmed)) throw new Error("Paste the token address.");
  const key = new PublicKey(trimmed);
  const info = await connection.getAccountInfo(key, "confirmed");
  if (!info) throw new Error("That address is not a token on this network.");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("That token is Token-2022. The escrow cannot settle it. Use USDC, SOL, or an ordinary SPL token.");
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("That address is not an ordinary SPL token.");
  return readPayToken(connection, trimmed);
}

/** Any token the buyer can pay with. Tensor pays in this mint. */
export async function readPayToken(connection: Connection, mint: string): Promise<PayFacts> {
  const trimmed = mint.trim();
  if (!ADDRESS.test(trimmed)) throw new Error("Paste the token address.");
  const key = new PublicKey(trimmed);
  const account = await getMint(connection, key).catch(() => null);
  if (!account) throw new Error("That address is not a token on this network.");
  let name = "Token";
  let symbol = "TOKEN";
  try {
    const metadata = await getTokenMetadata(connection, key, "confirmed");
    name = metadata?.name?.replaceAll("\0", "").trim() || name;
    symbol = metadata?.symbol?.replaceAll("\0", "").trim() || symbol;
  } catch {
    // A token with no metadata still has a mint and decimals.
  }
  return { mint: key.toBase58(), name, symbol, decimals: account.decimals };
}
