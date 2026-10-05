import {
  deriveBaseKeyForLocker,
  deriveEscrow,
  getLockedVestingParams,
  TokenDecimal,
  type LockedVestingParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LockClient } from "@meteora-ag/met-lock-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** The program measures the schedule in seconds. One day is 86,400. */
export const DAY_SECONDS = 86_400;
/** Two years. The locker rejects a longer wait plus release. */
export const MAX_VESTING_DAYS = 730;

export type CreatorReserve = {
  /** Whole tokens reserved for the creator. 0 means none. */
  tokens: number;
  /** Seconds from the lock to claim 1. */
  cliffSeconds: number;
  /** Seconds from one claim to the next. 0 means there is only claim 1. */
  releaseSeconds: number;
  /** How many claims. 0 or 1 means one handover. */
  periods: number;
};

export const NO_RESERVE: CreatorReserve = {
  tokens: 0,
  cliffSeconds: 0,
  releaseSeconds: 0,
  periods: 0,
};

export const RESERVE_PERCENTS = [5, 10, 20] as const;

export type ReserveWhen = "open" | "d30" | "d90" | "m6" | "y1";

export function reserveFromWhen(tokens: number, when: ReserveWhen): CreatorReserve {
  if (when === "d30") return { tokens, cliffSeconds: 30 * DAY_SECONDS, releaseSeconds: 0, periods: 0 };
  if (when === "d90") return { tokens, cliffSeconds: 90 * DAY_SECONDS, releaseSeconds: 0, periods: 0 };
  if (when === "m6") return { tokens, cliffSeconds: 30 * DAY_SECONDS, releaseSeconds: 30 * DAY_SECONDS, periods: 6 };
  if (when === "y1") return { tokens, cliffSeconds: 30 * DAY_SECONDS, releaseSeconds: 30 * DAY_SECONDS, periods: 12 };
  return { tokens, cliffSeconds: 0, releaseSeconds: 0, periods: 0 };
}

export function tokensForPercent(supply: number, percent: number): number {
  if (!Number.isInteger(supply) || supply < 2) return 0;
  return Math.floor((supply * percent) / 100);
}

export function reserveToParams(reserve: CreatorReserve): LockedVestingParams {
  if (reserve.tokens <= 0) {
    return {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    };
  }
  const claims = reserve.releaseSeconds > 0 && reserve.periods > 1 ? reserve.periods : 1;
  if (claims === 1) {
    return {
      totalLockedVestingAmount: reserve.tokens,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: reserve.tokens,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: reserve.cliffSeconds,
    };
  }
  const each = Math.floor(reserve.tokens / claims);
  const first = reserve.tokens - each * (claims - 1);
  return {
    totalLockedVestingAmount: reserve.tokens,
    numberOfVestingPeriod: claims - 1,
    cliffUnlockAmount: first,
    totalVestingDuration: reserve.releaseSeconds * (claims - 1),
    cliffDurationFromMigrationTime: reserve.cliffSeconds,
  };
}

export function reserveProblem(reserve: CreatorReserve, supply: number): string {
  if (reserve.tokens === 0) return "";
  if (!Number.isInteger(reserve.tokens) || reserve.tokens < 1) {
    return "Creator supply has to be a whole number of tokens.";
  }
  if (Number.isInteger(supply) && supply > 1 && reserve.tokens >= supply) {
    return "Creator supply has to be smaller than the whole supply. The sale and the pool still need tokens.";
  }
  const cliffDays = reserve.cliffSeconds / DAY_SECONDS;
  const releaseDays = reserve.releaseSeconds / DAY_SECONDS;
  if (!Number.isInteger(cliffDays) || cliffDays < 0 || cliffDays > MAX_VESTING_DAYS) {
    return "The wait has to be a whole number of days from 0 to 730.";
  }
  if (reserve.releaseSeconds <= 0 && reserve.periods <= 1) return "";
  if (!Number.isInteger(reserve.periods) || reserve.periods < 1 || reserve.periods > 365) {
    return "The number of claims has to be a whole number from 1 to 365.";
  }
  if (reserve.periods <= 1) return "";
  if (!Number.isInteger(releaseDays) || releaseDays < 1 || releaseDays > MAX_VESTING_DAYS) {
    return "Days between claims has to be a whole number from 1 to 730.";
  }
  const lastDay = cliffDays + (reserve.periods - 1) * releaseDays;
  if (lastDay > MAX_VESTING_DAYS) {
    return "The last claim has to land within 730 days of the lock. That is the two-year limit.";
  }
  if (reserve.tokens < reserve.periods) {
    return "Each claim has to be at least 1 whole token.";
  }
  return "";
}

const RAW_TOKEN = new BN(1_000_000);

function groupedRaw(raw: BN): string {
  const whole = raw.div(RAW_TOKEN);
  const frac = raw.mod(RAW_TOKEN);
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac.isZero()) return wholeText;
  const fracText = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${wholeText}.${fracText}`;
}

function tokenWord(raw: BN): string {
  return raw.eq(RAW_TOKEN) ? "token" : "tokens";
}

function dayMark(seconds: number): string {
  if (seconds <= 0) return "when the supply is locked";
  if (seconds === 1) return "1 second after the lock";
  const days = seconds / DAY_SECONDS;
  if (Number.isInteger(days) && days >= 1) return days === 1 ? "1 day after the lock" : `${days} days after the lock`;
  return `${seconds.toLocaleString("en-US")} seconds after the lock`;
}

type Beat = { raw: BN; at: number };

function beats(cliffUnlock: BN, perPeriod: BN, periods: number, frequency: number, cliffSeconds: number): Beat[] {
  const rows: Beat[] = [];
  if (!cliffUnlock.isZero()) rows.push({ raw: cliffUnlock, at: cliffSeconds });
  for (let index = 1; index <= periods; index += 1) {
    rows.push({ raw: perPeriod, at: cliffSeconds + frequency * index });
  }
  return rows;
}

function claimLines(rows: Beat[]): string {
  return rows
    .map((row, index) => `Claim ${index + 1} is ${groupedRaw(row.raw)} ${tokenWord(row.raw)} ${dayMark(row.at)}.`)
    .join(" ");
}

const CLOCK =
  "The clock starts when the creator supply is locked. That signature comes after the curve fills and before the trading pool opens. It does not start when the token is created, and it does not start when the trading pool opens.";

function heldBack(cliffUnlock: BN, perPeriod: BN, periods: number, frequency: number, cliffSeconds: number): string {
  if (perPeriod.eq(RAW_TOKEN) && periods === 1 && frequency === 1) {
    return "The 1-token holdback applies. The program stores one handover as the reserved amount minus 1 token, then that 1 token one second later.";
  }
  const rows = beats(cliffUnlock, perPeriod, periods, frequency, cliffSeconds);
  if (rows.length >= 2 && rows[0].raw.gt(rows[1].raw)) {
    const extra = rows[0].raw.sub(rows[1].raw);
    const sameRest = rows.slice(1).every((row) => row.raw.eq(rows[1].raw));
    if (sameRest) {
      return `${groupedRaw(extra)} extra ${tokenWord(extra)} sit on claim 1 because the reserved amount does not divide into equal whole tokens. The 1-token holdback does not apply.`;
    }
  }
  return "The 1-token holdback does not apply. That holdback is only for a single handover.";
}

/** Sentence for the schedule the program will actually store. */
export function storyFromRaw(
  cliffUnlock: BN,
  perPeriod: BN,
  periods: number,
  frequency: number,
  cliffSeconds: number,
  supply: number,
): string {
  const total = cliffUnlock.add(perPeriod.mul(new BN(periods)));
  if (total.isZero()) return "";
  const tokens = Number(total.toString()) / 1_000_000;
  const percent = supply > 0 ? (tokens / supply) * 100 : 0;
  const percentText = percent.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const head = `${groupedRaw(total)} tokens are reserved for the creator. That is ${percentText}% of the supply. Buyers cannot buy them, and they do not go into the pool.`;
  const oneToken = perPeriod.eq(RAW_TOKEN) && periods === 1 && frequency === 1;
  const claims = oneToken
    ? `This is one handover ${dayMark(cliffSeconds)}. ${groupedRaw(cliffUnlock)} ${tokenWord(cliffUnlock)} unlock then, and 1 token unlocks one second later.`
    : claimLines(beats(cliffUnlock, perPeriod, periods, frequency, cliffSeconds));
  return [head, claims, heldBack(cliffUnlock, perPeriod, periods, frequency, cliffSeconds), CLOCK].join(" ");
}

/** On-chain schedule, as facts a buyer can read. */
export function publicSchedule(
  cliffUnlock: BN,
  perPeriod: BN,
  periods: number,
  frequency: number,
  cliffSeconds: number,
  supply: number,
): string[] {
  const total = cliffUnlock.add(perPeriod.mul(new BN(periods)));
  if (total.isZero()) return [];
  const tokens = Number(total.toString()) / 1_000_000;
  const percent = supply > 0 ? (tokens / supply) * 100 : 0;
  const percentText = percent.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const oneToken = perPeriod.eq(RAW_TOKEN) && periods === 1 && frequency === 1;
  const lines = [
    `${groupedRaw(total)} tokens, ${percentText}% of the supply, are reserved for the creator. They are not for sale and they are not in the pool.`,
    oneToken
      ? `One handover ${dayMark(cliffSeconds)}. ${groupedRaw(cliffUnlock)} ${tokenWord(cliffUnlock)} unlock then, and 1 token unlocks one second later.`
      : claimLines(beats(cliffUnlock, perPeriod, periods, frequency, cliffSeconds)),
    heldBack(cliffUnlock, perPeriod, periods, frequency, cliffSeconds),
  ];
  return lines;
}

/** Next unlock time in unix seconds. Null when the schedule is finished or has not been locked. */
export function nextUnlockSeconds(
  nowSeconds: number,
  cliffTime: number,
  frequency: number,
  periods: number,
  claimed: BN,
  total: BN,
): number | null {
  if (claimed.gte(total)) return null;
  if (nowSeconds < cliffTime) return cliffTime;
  if (frequency <= 0 || periods <= 0) return null;
  const done = Math.min(periods, Math.floor((nowSeconds - cliffTime) / frequency));
  if (done >= periods) return null;
  return cliffTime + (done + 1) * frequency;
}

export function reserveStory(reserve: CreatorReserve, supply: number): string {
  if (reserveProblem(reserve, supply) || reserve.tokens <= 0) return "";
  const draft = reserveToParams(reserve);
  const params = getLockedVestingParams(
    draft.totalLockedVestingAmount,
    draft.numberOfVestingPeriod,
    draft.cliffUnlockAmount,
    draft.totalVestingDuration,
    draft.cliffDurationFromMigrationTime,
    TokenDecimal.SIX,
  );
  return storyFromRaw(
    params.cliffUnlockAmount,
    params.amountPerPeriod,
    Number(params.numberOfPeriod.toString()),
    Number(params.frequency.toString()),
    Number(params.cliffDurationFromMigrationTime.toString()),
    supply,
  );
}

/** Tokens the creator can claim at `now`, in raw units. */
export function claimableRaw(
  nowSeconds: number,
  cliffTime: number,
  frequency: number,
  cliffUnlock: BN,
  perPeriod: BN,
  periods: number,
  claimed: BN,
): BN {
  if (nowSeconds < cliffTime) return new BN(0);
  const done = frequency <= 0 ? periods : Math.min(periods, Math.floor((nowSeconds - cliffTime) / frequency));
  const unlocked = cliffUnlock.add(perPeriod.mul(new BN(done)));
  return unlocked.gt(claimed) ? unlocked.sub(claimed) : new BN(0);
}

export type CreatorClaim = {
  escrow: string;
  recipient: string;
  claimable: BN;
  claimed: BN;
  total: BN;
  cliffTime: number;
  frequency: number;
  periods: number;
  cliffUnlock: BN;
  perPeriod: BN;
};

export async function loadCreatorClaim(connection: Connection, pool: PublicKey): Promise<CreatorClaim | null> {
  const escrowKey = deriveEscrow(deriveBaseKeyForLocker(pool));
  try {
    const escrow = await new LockClient(connection, "confirmed").getEscrow(escrowKey);
    const cliffUnlock = new BN(escrow.cliffUnlockAmount.toString());
    const perPeriod = new BN(escrow.amountPerPeriod.toString());
    const periods = Number(escrow.numberOfPeriod.toString());
    const claimed = new BN(escrow.totalClaimedAmount.toString());
    const now = Math.floor(Date.now() / 1000);
    return {
      escrow: escrowKey.toBase58(),
      recipient: escrow.recipient.toBase58(),
      claimed,
      total: cliffUnlock.add(perPeriod.mul(new BN(periods))),
      cliffTime: Number(escrow.cliffTime.toString()),
      frequency: Number(escrow.frequency.toString()),
      periods,
      cliffUnlock,
      perPeriod,
      claimable: claimableRaw(
        now,
        Number(escrow.cliffTime.toString()),
        Number(escrow.frequency.toString()),
        cliffUnlock,
        perPeriod,
        periods,
        claimed,
      ),
    };
  } catch {
    return null;
  }
}
