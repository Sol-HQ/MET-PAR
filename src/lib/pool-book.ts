import { getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import BN from "bn.js";
import { rawToUi } from "./format";
import type { PoolSnapshot } from "./load-pool";

export type HolderRow = {
  owner: string;
  amount: string;
};

export type TradeRow = {
  signature: string;
  time: number;
  side: "buy" | "sell";
  wallet: string;
  base: string;
  quote: string;
};

const PAGE = 25;
const ZERO = BigInt(0);

async function tokenOwner(connection: Connection, address: PublicKey): Promise<PublicKey | null> {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const account = await getAccount(connection, address, "confirmed", program);
      return account.owner;
    } catch {
      // This account is not on that token program.
    }
  }
  return null;
}

/** Wallets that hold the mint. Pool vaults are left out. The chain returns at most 20. */
export async function loadHolders(
  connection: Connection,
  mint: string,
  decimals: number,
  skip: string[],
): Promise<{ rows: HolderRow[]; capped: boolean }> {
  const hidden = new Set(skip);
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
  const rows = largest.value.filter((row) => row.amount !== "0" && !hidden.has(row.address.toBase58()));
  const owners = await Promise.all(rows.map((row) => tokenOwner(connection, row.address)));
  const ownerKeys = owners.filter((owner): owner is PublicKey => owner !== null);
  const infos = await connection.getMultipleAccountsInfo(ownerKeys);
  const wallet = new Set(
    ownerKeys.filter((owner, index) => infos[index]?.owner.equals(SystemProgram.programId)).map((owner) => owner.toBase58()),
  );
  return {
    capped: largest.value.length >= 20,
    rows: rows.flatMap((row, index) => {
      const owner = owners[index];
      if (!owner || !wallet.has(owner.toBase58())) return [];
      return [{ owner: owner.toBase58(), amount: rawToUi(new BN(row.amount), decimals) }];
    }),
  };
}

type SideDeltas = { base: bigint; quote: bigint };

function collect(tx: ParsedTransactionWithMeta, baseMint: string, quoteMint: string): Map<string, SideDeltas> {
  const byOwner = new Map<string, SideDeltas>();
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const indexes = new Set([...pre.map((row) => row.accountIndex), ...post.map((row) => row.accountIndex)]);
  for (const index of indexes) {
    const before = pre.find((row) => row.accountIndex === index);
    const after = post.find((row) => row.accountIndex === index);
    const sample = after ?? before;
    if (!sample?.owner) continue;
    if (sample.mint !== baseMint && sample.mint !== quoteMint) continue;
    const delta = BigInt(after?.uiTokenAmount.amount || "0") - BigInt(before?.uiTokenAmount.amount || "0");
    if (delta === ZERO) continue;
    const current = byOwner.get(sample.owner) ?? { base: ZERO, quote: ZERO };
    if (sample.mint === baseMint) current.base += delta;
    else current.quote += delta;
    byOwner.set(sample.owner, current);
  }
  return byOwner;
}

function tradeFrom(tx: ParsedTransactionWithMeta, snapshot: PoolSnapshot): TradeRow | null {
  if (tx.meta?.err) return null;
  const byOwner = collect(tx, snapshot.baseMint, snapshot.quoteMint);
  let poolOwner = "";
  let pool: SideDeltas | null = null;
  for (const [owner, delta] of byOwner) {
    const opposite =
      (delta.base > ZERO && delta.quote < ZERO) || (delta.base < ZERO && delta.quote > ZERO);
    if (!opposite) continue;
    if (!pool || abs(delta.base) > abs(pool.base)) {
      pool = delta;
      poolOwner = owner;
    }
  }
  if (!pool) return null;
  let wallet = "";
  let walletBase = ZERO;
  for (const [owner, delta] of byOwner) {
    if (owner === poolOwner || delta.base === ZERO) continue;
    if (abs(delta.base) > abs(walletBase)) {
      wallet = owner;
      walletBase = delta.base;
    }
  }
  const signature = tx.transaction.signatures[0];
  if (!signature) return null;
  return {
    signature,
    time: tx.blockTime ?? 0,
    side: pool.base < ZERO ? "buy" : "sell",
    wallet,
    base: rawToUi(new BN(abs(pool.base).toString()), snapshot.baseDecimals),
    quote: rawToUi(new BN(abs(pool.quote).toString()), snapshot.quoteDecimals),
  };
}

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

/** Buys and sells on the curve and, after it fills, on the trading pool. */
export async function loadTrades(connection: Connection, snapshot: PoolSnapshot): Promise<TradeRow[]> {
  const addresses = [snapshot.address, snapshot.dammPool].filter((address): address is string => Boolean(address));
  const groups = await Promise.all(
    addresses.map((address) => connection.getSignaturesForAddress(new PublicKey(address), { limit: PAGE })),
  );
  const seen = new Set<string>();
  const signatures = groups
    .flat()
    .filter((row) => !row.err && seen.has(row.signature) === false && seen.add(row.signature))
    .slice(0, PAGE)
    .map((row) => row.signature);
  if (signatures.length === 0) return [];
  const parsed = await connection.getParsedTransactions(signatures, { maxSupportedTransactionVersion: 0 });
  const trades: TradeRow[] = [];
  for (const tx of parsed) {
    if (!tx) continue;
    const trade = tradeFrom(tx, snapshot);
    if (trade) trades.push(trade);
  }
  trades.sort((a, b) => b.time - a.time);
  return trades;
}
