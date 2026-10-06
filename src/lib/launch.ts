import {
  buildCurve,
  buildCurveWithCustomSqrtPrices,
  buildCurveWithMarketCap,
  buildCurveWithTwoSegments,
  feeNumeratorToBps,
  getBaseFeeNumeratorByPeriod,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  validateConfigParameters,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { BASE_DECIMALS, feeDecayLabel, quoteLabel, type QuoteKind } from "./constants";
import { formatTokenPrice, plainDecimal } from "./format";
import { curveBase, type CurveShape } from "./curve";
import { NO_RESERVE, reserveToParams, storyFromRaw, type CreatorReserve } from "./vesting";

export const BILLION_SUPPLY = 1_000_000_000;
/** The shelf ends 10% above par. Buyers there pay at most that much over the stated price. */
const SHELF_LIFT = 1.1;
/** PAR finishes at most double the opening price. A wider gap uses the climb. */
const PAR_MAX_LIFT = 2;
/** Weight on the shelf against a weight of 1 on the walk. */
const SHELF_WEIGHT = 100;
/** At least this percent of the supply migrates into the pool. On a billion tokens that is 200,000,000. */
const MIGRATION_SUPPLY_PERCENT = 20;
/**
 * Whole percents the PAR shelf can lock. 35% is the low end, with the pool almost
 * double par. 48% is the high end, just above the 10% shelf. The lifts were measured
 * on a billion-token shelf: each one is the pool price divided by par.
 */
export const SHARE_PRESETS = [35, 40, 45, 48] as const;
export const SHARE_PERCENT_LOW = 35;
export const SHARE_PERCENT_HIGH = 48;
const SHARE_LIFT: Record<number, number> = {
  35: 1.98293,
  36: 1.901671875,
  37: 1.8103671875,
  38: 1.733109375,
  39: 1.6558515625,
  40: 1.58332,
  41: 1.52240625,
  42: 1.4591953125,
  43: 1.395984375,
  44: 1.339796875,
  45: 1.2818,
  46: 1.2344453125,
  47: 1.18528125,
  48: 1.13416,
};
const shareLiftCache = new Map<number, number>();
function migrationWarning(percent: number): string {
  if (percent >= MIGRATION_SUPPLY_PERCENT) return "";
  const shown = percent.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `Check your settings. ${shown}% of the supply would migrate into the pool after graduation. That is under 20%.`;
}
/**
 * Par fixed. One billion tokens, par $0.00005, pool $0.00006.
 * About 466,589,438 tokens and $27,995 lock. A $1 par on a $10,000 lock shrinks the supply
 * to about 18,000 tokens, so this preset keeps the billion and the small price.
 */
const PAR_FIXED = { supply: BILLION_SUPPLY, par: 0.00005, pool: 0.00006 } as const;
/**
 * Tokens the curve math cannot sell or lock, per billion of supply.
 * They are sent to the platform wallet. Checked as the smallest round amount that
 * still validates the $750 curve and the larger ones.
 */
const CURVE_DUST = 100;

const CLIMB_RAISES = [10_000, 25_000, 50_000] as const;
export const THIN_RAISE = 750;
const RAISE_CHOICES = [...CLIMB_RAISES, THIN_RAISE] as const;
const SOL_CLIMB_RAISES = [10, 25, 50] as const;
export const SOL_THIN_RAISE = 1;
const SOL_RAISE_CHOICES = [...SOL_CLIMB_RAISES, SOL_THIN_RAISE] as const;
export type RaiseChoice = (typeof RAISE_CHOICES)[number] | (typeof SOL_RAISE_CHOICES)[number];

/** The meme climb stays one shape. The slider only moves how much quote locks. */
export const MEME_LOCK = {
  usdc: { min: 10_000, max: 50_000, step: 500, start: 25_000 },
  sol: { min: 10, max: 50, step: 1, start: 25 },
} as const;

export function memeLockBounds(kind: QuoteKind): { min: number; max: number; step: number; start: number } {
  return kind === "sol" ? MEME_LOCK.sol : MEME_LOCK.usdc;
}

export function clampMemeLock(kind: QuoteKind, value: number): number {
  const bounds = memeLockBounds(kind);
  if (!Number.isFinite(value)) return bounds.start;
  const stepped = Math.round(value / bounds.step) * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, stepped));
}

export const CLIMB_PRESETS: { raise: (typeof CLIMB_RAISES)[number]; name: string; detail: string }[] = [
  {
    raise: 10_000,
    name: "Starter",
    detail: "One billion tokens. The price climbs from the open to the pool and locks about $10,000.",
  },
  {
    raise: 25_000,
    name: "Solid",
    detail: "One billion tokens. The same climb, with about $25,000 locked.",
  },
  {
    raise: 50_000,
    name: "Deep",
    detail: "One billion tokens. The same climb, with about $50,000 locked.",
  },
];

export const SOL_CLIMB_PRESETS: { raise: (typeof SOL_CLIMB_RAISES)[number]; name: string; detail: string }[] = [
  {
    raise: 10,
    name: "Starter",
    detail: "One billion tokens. The price climbs from the open to the pool and locks 10 SOL. That is the size Meteora opens by itself on the real network.",
  },
  {
    raise: 25,
    name: "Solid",
    detail: "One billion tokens. The same climb, with 25 SOL locked.",
  },
  {
    raise: 50,
    name: "Deep",
    detail: "One billion tokens. The same climb, with 50 SOL locked.",
  },
];

export type LaunchChoice =
  | { kind: "climb"; raise: number }
  | { kind: "par"; raise: RaiseChoice; parPrice: number; poolPrice: number; migratePercent?: number }
  | { kind: "fixed" }
  | { kind: "custom"; supply: number; openPrice: number; endPrice: number; migratePercent?: number }
  | { kind: "custom-par"; supply: number; parPrice: number; poolPrice: number; migratePercent?: number };

export type LaunchPicture = {
  ok: boolean;
  fair: boolean;
  error: string;
  supply: number;
  parPrice: string;
  shelfPrice: string;
  poolPrice: string;
  parMarketCap: string;
  poolMarketCap: string;
  saleAtPar: string;
  walk: string;
  locked: string;
  dust: string;
  raise: string;
  raiseRaw: string;
  tenDollarShare: string;
  keeper: string;
  /** Whole tokens that migrate. 0 until the curve is valid. */
  migratedTokens: number;
  /** Percent of the supply that migrates. 0 until the curve is valid. */
  migratedPercent: number;
  /** Set when a custom curve would migrate under 20% of the supply. */
  migrationWarning: string;
  /** Plain schedule for a creator supply. Empty when none is reserved. */
  creator: string;
};

const EMPTY: LaunchPicture = {
  ok: false,
  fair: false,
  error: "",
  supply: 0,
  parPrice: "",
  shelfPrice: "",
  poolPrice: "",
  parMarketCap: "",
  poolMarketCap: "",
  saleAtPar: "",
  walk: "",
  locked: "",
  dust: "",
  raise: "",
  raiseRaw: "",
  tenDollarShare: "",
  keeper: "",
  migratedTokens: 0,
  migratedPercent: 0,
  migrationWarning: "",
  creator: "",
};

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "unavailable";
  if (amount >= 100) return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (amount >= 1) return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (amount >= 0.01) return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${amount.toPrecision(4)}`;
}

function dollars(value: { toNumber: () => number; toSignificantDigits: (digits: number) => { toString: () => string } }): string {
  const amount = value.toNumber();
  if (!Number.isFinite(amount)) return `$${value.toSignificantDigits(6).toString()}`;
  return formatUsd(amount);
}

export type QuoteExtra = { decimals: number; unit: string };

function dec(kind: QuoteKind, extra?: QuoteExtra): number {
  return extra?.decimals ?? (kind === "sol" ? 9 : 6);
}

function unitOf(kind: QuoteKind, extra?: QuoteExtra): string {
  return extra?.unit || quoteLabel(kind);
}

function tokenPrice(value: Parameters<typeof formatTokenPrice>[0], kind: QuoteKind = "usdc", extra?: QuoteExtra): string {
  const text = formatTokenPrice(value);
  if (kind === "usdc" && !extra) return `$${text}`;
  return `${text} ${unitOf(kind, extra)}`;
}

function formatQuote(amount: number, kind: QuoteKind, extra?: QuoteExtra): string {
  if (kind === "usdc" && !extra) return formatUsd(amount);
  if (!Number.isFinite(amount)) return "unavailable";
  const text =
    amount >= 100
      ? amount.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : amount >= 1
        ? amount.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : amount >= 0.01
          ? amount.toLocaleString("en-US", { maximumFractionDigits: 4 })
          : amount.toPrecision(4);
  return `${text} ${unitOf(kind, extra)}`;
}

function quoteMoney(
  value: { toNumber: () => number; toSignificantDigits: (digits: number) => { toString: () => string } },
  kind: QuoteKind,
  extra?: QuoteExtra,
): string {
  if (kind === "usdc" && !extra) return dollars(value);
  const amount = value.toNumber();
  if (!Number.isFinite(amount)) return `${value.toSignificantDigits(6).toString()} ${unitOf(kind, extra)}`;
  return formatQuote(amount, kind, extra);
}

function uiRaise(raw: { toString(): string }, kind: QuoteKind, extra?: QuoteExtra): number {
  return Number(raw.toString()) / 10 ** dec(kind, extra);
}

function sampleBuy(kind: QuoteKind): number {
  return kind === "sol" ? 0.1 : 10;
}

function groupedWhole(raw: BN): string {
  const whole = raw.div(new BN(10).pow(new BN(BASE_DECIMALS)));
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dustFor(supply: number): number {
  return Math.max(1, Math.round((supply * CURVE_DUST) / BILLION_SUPPLY));
}

function reservedRaw(config: ConfigParameters): BN {
  const vest = config.lockedVesting;
  return new BN(vest.cliffUnlockAmount.toString()).add(
    new BN(vest.amountPerPeriod.toString()).mul(new BN(vest.numberOfPeriod.toString())),
  );
}

function creatorLine(config: ConfigParameters, supply: number): string {
  const vest = config.lockedVesting;
  return storyFromRaw(
    new BN(vest.cliffUnlockAmount.toString()),
    new BN(vest.amountPerPeriod.toString()),
    Number(vest.numberOfPeriod.toString()),
    Number(vest.frequency.toString()),
    Number(vest.cliffDurationFromMigrationTime.toString()),
    supply,
  );
}

class FairLaunchError extends Error {
  readonly par: boolean;
  readonly pool: boolean;
  readonly sale: boolean;

  constructor(message: string, fields: { par?: boolean; pool?: boolean; sale?: boolean }) {
    super(message);
    this.par = fields.par === true;
    this.pool = fields.pool === true;
    this.sale = fields.sale === true;
  }
}

function baseDelta(lower: BN, upper: BN, liquidity: BN): BN {
  return liquidity.mul(upper.sub(lower)).div(lower.mul(upper));
}

type CurveRead = {
  par: ReturnType<typeof getPriceFromSqrtPrice>;
  shelf: ReturnType<typeof getPriceFromSqrtPrice>;
  pool: ReturnType<typeof getPriceFromSqrtPrice>;
  sold: BN;
  shelfTokens: BN;
  leftover: number;
};

function soldOnCurve(config: ConfigParameters): BN {
  const start = new BN(config.sqrtStartPrice.toString());
  let cursor = start;
  let sold = new BN(0);
  for (const point of config.curve) {
    const next = new BN(point.sqrtPrice.toString());
    const liquidity = new BN(point.liquidity.toString());
    if (liquidity.isZero() || !next.gt(cursor)) continue;
    sold = sold.add(baseDelta(cursor, next, liquidity));
    cursor = next;
  }
  return sold;
}

function readCurve(config: ConfigParameters, leftover: number, kind: QuoteKind = "usdc", extra?: QuoteExtra): CurveRead {
  const start = new BN(config.sqrtStartPrice.toString());
  const active = config.curve.filter((point) => !new BN(point.liquidity.toString()).isZero());
  if (active.length < 2) {
    throw new FairLaunchError("That shelf is a climb. The opening price does not stay flat.", { par: true, pool: true });
  }
  let cursor = start;
  let sold = new BN(0);
  let shelfTokens = new BN(0);
  active.forEach((point, index) => {
    const next = new BN(point.sqrtPrice.toString());
    const liquidity = new BN(point.liquidity.toString());
    if (next.lte(cursor)) return;
    const tokens = baseDelta(cursor, next, liquidity);
    sold = sold.add(tokens);
    if (index === 0) shelfTokens = tokens;
    cursor = next;
  });
  if (sold.isZero()) {
    throw new FairLaunchError("That shelf is a climb. The opening price does not stay flat.", { par: true, pool: true });
  }
  return {
    par: getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, dec(kind, extra)),
    shelf: getPriceFromSqrtPrice(active[0].sqrtPrice, BASE_DECIMALS, dec(kind, extra)),
    pool: getPriceFromSqrtPrice(active[active.length - 1].sqrtPrice, BASE_DECIMALS, dec(kind, extra)),
    sold,
    shelfTokens,
    leftover,
  };
}

function buildOnce(
  supply: number,
  par: number,
  pool: number,
  weight: number,
  leftover: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): ConfigParameters {
  const sqrtPrices = [par, par * SHELF_LIFT, pool].map((price) =>
    getSqrtPriceFromPrice(String(price), BASE_DECIMALS, dec(kind, extra)),
  );
  const config = buildCurveWithCustomSqrtPrices({
    ...curveBase(supply, leftover, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, dec(kind, extra), reserveToParams(reserve), shape),
    sqrtPrices,
    liquidityWeights: [weight, 1],
  });
  validateConfigParameters({
    ...config,
    leftoverReceiver: Keypair.generate().publicKey,
  });
  return config;
}

function assertParBand(par: number, pool: number) {
  if (!(par > 0) || !(pool > par)) {
    throw new FairLaunchError("The pool price has to be above par. PAR opens at one price and locks a little higher.", { pool: true });
  }
  if (pool <= par * SHELF_LIFT) {
    throw new FairLaunchError(
      "The pool price is still on the shelf. The opening stays within 10% of par, so the pool price has to sit above that.",
      { pool: true },
    );
  }
  if (pool > par * PAR_MAX_LIFT * 1.0000001) {
    throw new FairLaunchError(
      "That finish is more than double par. PAR keeps the pool price at or under twice the opening. Turn PAR off for a wider gap.",
      { pool: true },
    );
  }
}

function buildFair(
  supply: number,
  par: number,
  pool: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): { config: ConfigParameters; read: CurveRead } {
  assertParBand(par, pool);
  const weight = SHELF_WEIGHT;
  let leftover = dustFor(supply);
  let config: ConfigParameters | null = null;
  let last = "That curve is not valid.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (leftover > supply * 0.01) break;
    try {
      config = buildOnce(supply, par, pool, weight, leftover, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
      break;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : last;
      if (!/leftOverDelta/i.test(last)) throw cause;
      leftover *= 10;
    }
  }
  if (!config) {
    throw new FairLaunchError("These prices do not fit a flat shelf. Move par and the pool price closer.", { par: true, pool: true });
  }
  const read = readCurve(config, leftover, kind, extra);
  const lift = read.shelf.div(read.par).toNumber();
  if (!(lift > 1) || lift > SHELF_LIFT + 0.005) {
    throw new FairLaunchError("That shelf is a climb. The opening price does not stay flat.", { par: true, pool: true });
  }
  const share = read.shelfTokens.muln(10_000).div(read.sold).toNumber() / 100;
  if (share < 50) {
    throw new FairLaunchError("Under half the tokens buyers receive would sit on the opening price. PAR keeps at least half of that sale inside the 10% band.", {
      sale: true,
    });
  }
  return { config, read };
}

const SPLIT_FIT_ERROR =
  "These prices and that share do not fit together. Clear the share and the prices set it, or try another whole number from 1 to 49.";

function pricedSplit(choice: LaunchChoice): { supply: number; open: number; pool: number; percent: number } | null {
  if (choice.kind === "custom" && choice.migratePercent) {
    return { supply: choice.supply, open: choice.openPrice, pool: choice.endPrice, percent: choice.migratePercent };
  }
  if (choice.kind === "custom-par" && choice.migratePercent) {
    return { supply: choice.supply, open: choice.parPrice, pool: choice.poolPrice, percent: choice.migratePercent };
  }
  if (choice.kind === "par" && choice.migratePercent) {
    return { supply: BILLION_SUPPLY, open: choice.parPrice, pool: choice.poolPrice, percent: choice.migratePercent };
  }
  return null;
}

function buildSplit(
  supply: number,
  open: number,
  pool: number,
  percent: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): { config: ConfigParameters; leftover: number } {
  let leftover = 0;
  let last = SPLIT_FIT_ERROR;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (leftover > supply * 0.01) break;
    try {
      const config = buildCurveWithTwoSegments({
        ...curveBase(supply, leftover, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, dec(kind, extra), reserveToParams(reserve), shape),
        initialMarketCap: open * supply,
        migrationMarketCap: pool * supply,
        percentageSupplyOnMigration: percent,
      });
      const active = config.curve.some((point) => !new BN(point.liquidity.toString()).isZero());
      if (!active) throw new Error("Curve is empty");
      validateConfigParameters({
        ...config,
        leftoverReceiver: Keypair.generate().publicKey,
      });
      return { config, leftover };
    } catch (cause) {
      last = cause instanceof Error ? cause.message : last;
      if (!/leftOverDelta/i.test(last)) break;
      leftover = leftover === 0 ? dustFor(supply) : leftover * 10;
    }
  }
  throw new FairLaunchError(/curve is empty|leftOverDelta/i.test(last) ? SPLIT_FIT_ERROR : last, { sale: true });
}

function pictureFromSplit(config: ConfigParameters, supply: number, leftover: number, kind: QuoteKind = "usdc", extra?: QuoteExtra): LaunchPicture {
  const decimals = dec(kind, extra);
  const start = getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, decimals);
  const active = config.curve.filter((point) => !new BN(point.liquidity.toString()).isZero());
  const mid = active[0] ? getPriceFromSqrtPrice(active[0].sqrtPrice, BASE_DECIMALS, decimals) : start;
  const end = active.length > 0 ? getPriceFromSqrtPrice(active[active.length - 1].sqrtPrice, BASE_DECIMALS, decimals) : start;
  const sold = soldOnCurve(config);
  const raise = uiRaise(config.migrationQuoteThreshold, kind, extra);
  const shareOfCurve = raise > 0 ? (sampleBuy(kind) / raise) * 100 : 0;
  const unit = new BN(10).pow(new BN(BASE_DECIMALS));
  const lockedRaw = new BN(supply).mul(unit).sub(new BN(leftover).mul(unit)).sub(reservedRaw(config)).sub(sold);
  const migratedPercent = lockedRaw.muln(10_000).div(new BN(supply).mul(unit)).toNumber() / 100;
  return {
    ...EMPTY,
    ok: true,
    supply,
    parPrice: tokenPrice(start, kind, extra),
    shelfPrice: tokenPrice(mid, kind, extra),
    poolPrice: tokenPrice(end, kind, extra),
    parMarketCap: quoteMoney(start.mul(supply), kind, extra),
    poolMarketCap: quoteMoney(end.mul(supply), kind, extra),
    locked: `${groupedWhole(sold)} tokens are sold. ${groupedWhole(lockedRaw)} tokens migrate into the pool with ${formatQuote(raise, kind, extra)}. That is ${migratedPercent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the supply. The price steps from ${tokenPrice(start, kind, extra)} to ${tokenPrice(mid, kind, extra)}, then to ${tokenPrice(end, kind, extra)}. Trading opens at ${tokenPrice(end, kind, extra)}. Later buys can move the price higher, and later sells can move it lower.`,
    dust:
      leftover > 0
        ? `${leftover.toLocaleString("en-US")} tokens are dust. The curve math cannot sell them or put them in the pool, so they go to the platform wallet.`
        : "",
    raise: formatQuote(raise, kind, extra),
    raiseRaw: config.migrationQuoteThreshold.toString(),
    tenDollarShare:
      shareOfCurve >= 100
        ? "more than the whole curve"
        : shareOfCurve < 0.1
          ? "a speck of the curve"
          : `${shareOfCurve.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the curve`,
    keeper: keeperNote(raise, kind, extra),
    migratedTokens: Number(lockedRaw.div(unit).toString()),
    migratedPercent,
    migrationWarning: migrationWarning(migratedPercent),
    creator: creatorLine(config, supply),
  };
}

function keeperNote(raise: number, kind: QuoteKind = "usdc", extra?: QuoteExtra): string {
  if (kind === "other") {
    const unit = unitOf(kind, extra);
    return `The raise is counted in ${unit}. On the real network, Meteora opens a stock quote by itself once the quote collected is worth at least $750. A standard token quote is opened by itself only when that token is on Meteora's list, or Jupiter has verified it with an organic score above 50 and the raise is worth more than $750. Otherwise someone signs once on the token page. The practice network always needs that signature.`;
  }
  if (kind === "sol") {
    if (Math.abs(raise - 10) < 0.001) {
      return "On the real network, 10 SOL is the size Meteora opens by itself. This one is that size, so Meteora opens the trading pool when the curve fills.";
    }
    if (raise > 10) {
      return "On the real network, Meteora opens a SOL curve by itself once it has collected at least 10 SOL. This one is above that, so Meteora opens the trading pool when the buys are in.";
    }
    return "This finishes under 10 SOL. That is below the amount Meteora opens by itself on the real network, so someone signs once on the token page. The practice network always needs that signature.";
  }
  if (Math.abs(raise - 750) < 0.5) {
    return "On the real network, $750 is the smallest USDC curve Meteora opens by itself. This one is that size, so Meteora opens the trading pool when the curve fills. The pool only holds that $750, so a small buy can move the price a lot.";
  }
  if (raise > 750) {
    return "On the real network, Meteora opens a USDC curve by itself once it has collected at least $750. This one is above that, so Meteora opens the trading pool when the buys are in.";
  }
  return "This finishes under $750. That is below the amount Meteora opens by itself on the real network, so someone signs once on the token page. The practice network always needs that signature.";
}

function finishPicture(config: ConfigParameters, read: CurveRead, supply: number, kind: QuoteKind = "usdc", extra?: QuoteExtra): LaunchPicture {
  const share = read.shelfTokens.muln(10_000).div(read.sold).toNumber() / 100;
  const walk = Math.max(0, 100 - share);
  const shareText = share.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const walkText = walk.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const raise = uiRaise(config.migrationQuoteThreshold, kind, extra);
  const shareOfCurve = raise > 0 ? (sampleBuy(kind) / raise) * 100 : 0;
  const unit = new BN(10).pow(new BN(BASE_DECIMALS));
  const lockedRaw = new BN(supply).mul(unit).sub(new BN(read.leftover).mul(unit)).sub(reservedRaw(config)).sub(read.sold);
  const migratedPercent = lockedRaw.muln(10_000).div(new BN(supply).mul(unit)).toNumber() / 100;
  return {
    ok: true,
    fair: true,
    error: "",
    supply,
    parPrice: tokenPrice(read.par, kind, extra),
    shelfPrice: tokenPrice(read.shelf, kind, extra),
    poolPrice: tokenPrice(read.pool, kind, extra),
    parMarketCap: quoteMoney(read.par.mul(supply), kind, extra),
    poolMarketCap: quoteMoney(read.pool.mul(supply), kind, extra),
    saleAtPar: `${shareText}% of the ${groupedWhole(read.sold)} tokens sold to buyers pay between ${tokenPrice(read.par, kind, extra)} and ${tokenPrice(read.shelf, kind, extra)}. The shelf is 10% wide. The other ${walkText}% of that sale walks the price to ${tokenPrice(read.pool, kind, extra)}.`,
    walk: `${groupedWhole(read.sold.sub(read.shelfTokens))} tokens move the price from ${tokenPrice(read.shelf, kind, extra)} to ${tokenPrice(read.pool, kind, extra)}. That pool price is on this card before the first buy.`,
    locked: `${groupedWhole(lockedRaw)} tokens migrate into the pool with ${formatQuote(raise, kind, extra)}. That is ${migratedPercent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the supply. They cannot be withdrawn. Buyers keep what they bought. Trading opens at ${tokenPrice(read.pool, kind, extra)}. Later buys can move the price higher, and later sells can move it lower.`,
    migrationWarning: migrationWarning(migratedPercent),
    dust:
      read.leftover > 0
        ? `${read.leftover.toLocaleString("en-US")} tokens are dust. The curve math cannot sell them or put them in the pool, so they go to the platform wallet.`
        : "",
    raise: formatQuote(raise, kind, extra),
    raiseRaw: config.migrationQuoteThreshold.toString(),
    tenDollarShare:
      shareOfCurve >= 100
        ? "more than the whole curve"
        : shareOfCurve < 0.1
          ? "a speck of the curve"
          : `${shareOfCurve.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the curve`,
    keeper: keeperNote(raise, kind, extra),
    migratedTokens: Number(lockedRaw.div(unit).toString()),
    migratedPercent,
    creator: creatorLine(config, supply),
  };
}

/** Pool price that locks this percent of the supply on the PAR shelf. Par stays put. */
export function poolForMigratingShare(par: number, percent: number): number | null {
  if (!(par > 0) || percent < SHARE_PERCENT_LOW || percent > SHARE_PERCENT_HIGH) return null;
  const key = Math.round(percent * 100);
  const known = SHARE_LIFT[percent];
  const cached = known ?? shareLiftCache.get(key);
  if (cached) return par * cached;
  let low = 1.101;
  let high = 2;
  let best = (low + high) / 2;
  for (let step = 0; step < 16; step += 1) {
    const mid = (low + high) / 2;
    let found: number;
    try {
      const built = buildFair(BILLION_SUPPLY, 1, mid, 2500, 100, 20, 43_200, 25);
      found = finishPicture(built.config, built.read, BILLION_SUPPLY).migratedPercent;
    } catch {
      return null;
    }
    best = mid;
    if (Math.abs(found - percent) < 0.05) break;
    if (found > percent) low = mid;
    else high = mid;
  }
  shareLiftCache.set(key, best);
  return par * best;
}

/** Par and pool price for a preset card. The quote that locks stays `raise`. The share picks the shape. */
export function parForLockedRaise(
  raise: number,
  percent: number,
  kind: QuoteKind = "usdc",
  extra?: QuoteExtra,
  reserve: CreatorReserve = NO_RESERVE,
): { par: number; pool: number } | null {
  if (!(raise > 0)) return null;
  const poolAtOne = poolForMigratingShare(1, percent);
  if (!poolAtOne) return null;
  try {
    const built = buildFair(BILLION_SUPPLY, 1, poolAtOne, 2500, 100, 20, 43_200, 25, kind, reserve, extra);
    const locked = uiRaise(built.config.migrationQuoteThreshold, kind, extra);
    if (!(locked > 0)) return null;
    const par = raise / locked;
    return { par, pool: par * poolAtOne };
  } catch {
    return null;
  }
}

export function priceField(amount: number): string {
  return plainDecimal(amount, 9);
}

function buildClimb(
  raise: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): ConfigParameters {
  const config = buildCurve({
    ...curveBase(BILLION_SUPPLY, 0, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, dec(kind, extra), reserveToParams(reserve), shape),
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: raise,
  });
  validateConfigParameters({
    ...config,
    leftoverReceiver: Keypair.generate().publicKey,
  });
  return config;
}

function pictureFromClimb(config: ConfigParameters, raise: number, kind: QuoteKind = "usdc", extra?: QuoteExtra): LaunchPicture {
  const decimals = dec(kind, extra);
  const start = getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, decimals);
  const endSqrt = config.curve.find((point) => !new BN(point.liquidity.toString()).isZero())?.sqrtPrice;
  const end = endSqrt ? getPriceFromSqrtPrice(endSqrt, BASE_DECIMALS, decimals) : start;
  const locked = uiRaise(config.migrationQuoteThreshold, kind, extra);
  const shareOfCurve = locked > 0 ? (sampleBuy(kind) / locked) * 100 : 0;
  const reserved = reservedRaw(config);
  const unit = new BN(10).pow(new BN(BASE_DECIMALS));
  const tail = new BN(MAX_SQRT_PRICE.toString());
  let cursor = new BN(config.sqrtStartPrice.toString());
  let sold = new BN(0);
  for (const point of config.curve) {
    const next = new BN(point.sqrtPrice.toString());
    if (next.eq(tail) || !next.gt(cursor)) break;
    sold = sold.add(baseDelta(cursor, next, new BN(point.liquidity.toString())));
    cursor = next;
  }
  const migrated = new BN(BILLION_SUPPLY).mul(unit).sub(reserved).sub(sold);
  const creator = creatorLine(config, BILLION_SUPPLY);
  const lockedText = reserved.isZero()
    ? `800,000,000 tokens are sold while the price climbs. 200,000,000 tokens and ${formatQuote(locked, kind, extra)} lock together. They cannot be withdrawn. Trading opens at the pool price. Later buys can move it higher, and later sells can move it lower.`
    : `${groupedWhole(sold)} tokens are sold while the price climbs. ${groupedWhole(migrated)} tokens and ${formatQuote(locked, kind, extra)} lock together. They cannot be withdrawn. Trading opens at the pool price. Later buys can move it higher, and later sells can move it lower.`;
  return {
    ...EMPTY,
    ok: true,
    fair: false,
    supply: BILLION_SUPPLY,
    parPrice: tokenPrice(start, kind, extra),
    poolPrice: tokenPrice(end, kind, extra),
    parMarketCap: quoteMoney(start.mul(BILLION_SUPPLY), kind, extra),
    poolMarketCap: quoteMoney(end.mul(BILLION_SUPPLY), kind, extra),
    locked: lockedText,
    raise: formatQuote(locked, kind, extra),
    raiseRaw: config.migrationQuoteThreshold.toString(),
    tenDollarShare:
      shareOfCurve >= 100
        ? "more than the whole curve"
        : shareOfCurve < 0.1
          ? "a speck of the curve"
          : `${shareOfCurve.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the curve`,
    keeper: reserved.isZero()
      ? keeperNote(raise, kind, extra)
      : "A creator bag is reserved. After the curve fills, you sign Lock the creator supply. The trading pool opens after that signature.",
    migratedTokens: reserved.isZero() ? 200_000_000 : Number(migrated.div(unit).toString()),
    migratedPercent: reserved.isZero() ? 20 : migrated.muln(10_000).div(new BN(BILLION_SUPPLY).mul(unit)).toNumber() / 100,
    creator,
  };
}

export function buildLaunchConfig(
  choice: LaunchChoice,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): ConfigParameters {
  const split = pricedSplit(choice);
  if (split) {
    return buildSplit(
      split.supply,
      split.open,
      split.pool,
      split.percent,
      openingFeeBps,
      endingFeeBps,
      platformFeePercent,
      feeDurationSeconds,
      migrationFeeBps,
      kind,
      reserve,
      extra,
      shape,
    ).config;
  }
  if (choice.kind === "climb") return buildClimb(choice.raise, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
  if (choice.kind === "custom") {
    const config = buildCurveWithMarketCap({
      ...curveBase(choice.supply, 0, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, dec(kind, extra), reserveToParams(reserve), shape),
      initialMarketCap: choice.openPrice * choice.supply,
      migrationMarketCap: choice.endPrice * choice.supply,
    });
    validateConfigParameters({ ...config, leftoverReceiver: Keypair.generate().publicKey });
    return config;
  }
  const par = choice.kind === "fixed" ? PAR_FIXED.par : choice.parPrice;
  const pool = choice.kind === "fixed" ? PAR_FIXED.pool : choice.poolPrice;
  const supply =
    choice.kind === "custom-par" ? choice.supply : choice.kind === "fixed" ? PAR_FIXED.supply : BILLION_SUPPLY;
  return buildFair(supply, par, pool, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape).config;
}

function describeFair(
  supply: number,
  par: number,
  pool: number,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): LaunchPicture {
  const built = buildFair(supply, par, pool, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
  return finishPicture(built.config, built.read, supply, kind, extra);
}

export type LaunchChart = {
  prices: number[];
  openLabel: string;
  endLabel: string;
  /** Percent of tokens sold where a shelf ends. Empty when the price climbs the whole way. */
  shelfAt: number | null;
  line: string;
  feePercents: number[];
  feeLine: string;
};

function tokensBetween(lower: BN, upper: BN, liquidity: BN): BN {
  if (liquidity.isZero() || !upper.gt(lower)) return new BN(0);
  return liquidity.mul(upper.sub(lower)).div(lower.mul(upper));
}

function sqrtAfterTokens(lower: BN, liquidity: BN, tokens: BN): BN {
  const denom = liquidity.sub(tokens.mul(lower));
  if (!denom.gt(new BN(0))) return lower;
  return liquidity.mul(lower).div(denom);
}

function feePercentText(percent: number): string {
  const rounded = Math.round(percent * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Price and fee points from the config this card would sign. */
export function sampleLaunchChart(
  choice: LaunchChoice,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): LaunchChart | null {
  try {
    const config = buildLaunchConfig(
      choice,
      openingFeeBps,
      endingFeeBps,
      platformFeePercent,
      feeDurationSeconds,
      migrationFeeBps,
      kind,
      reserve,
      extra,
      shape,
    );
    const decimals = dec(kind, extra);
    const start = new BN(config.sqrtStartPrice.toString());
    const tail = new BN(MAX_SQRT_PRICE.toString());
    let cursor = start;
    const spans: { lo: BN; hi: BN; liquidity: BN; tokens: BN }[] = [];
    for (const point of config.curve) {
      const next = new BN(point.sqrtPrice.toString());
      const liquidity = new BN(point.liquidity.toString());
      if (liquidity.isZero() || next.eq(tail) || !next.gt(cursor)) continue;
      spans.push({ lo: cursor, hi: next, liquidity, tokens: tokensBetween(cursor, next, liquidity) });
      cursor = next;
    }
    if (spans.length === 0) return null;
    let sold = new BN(0);
    for (const span of spans) sold = sold.add(span.tokens);
    if (sold.isZero()) return null;
    const steps = 21;
    const prices: number[] = [];
    for (let step = 0; step < steps; step += 1) {
      let left = sold.muln(step).divn(steps - 1);
      let sqrt = start;
      for (const span of spans) {
        if (left.lte(new BN(0))) break;
        if (left.gte(span.tokens)) {
          left = left.sub(span.tokens);
          sqrt = span.hi;
          continue;
        }
        sqrt = sqrtAfterTokens(span.lo, span.liquidity, left);
        left = new BN(0);
      }
      const price = getPriceFromSqrtPrice(sqrt, BASE_DECIMALS, decimals).toNumber();
      if (!Number.isFinite(price) || price <= 0) return null;
      prices.push(price);
    }
    const open = getPriceFromSqrtPrice(start, BASE_DECIMALS, decimals);
    const end = getPriceFromSqrtPrice(spans[spans.length - 1].hi, BASE_DECIMALS, decimals);
    const openLabel = tokenPrice(open, kind, extra);
    const endLabel = tokenPrice(end, kind, extra);
    const shelfPrice = getPriceFromSqrtPrice(spans[0].hi, BASE_DECIMALS, decimals).toNumber();
    const openNumber = open.toNumber();
    const shelfLift = openNumber > 0 ? shelfPrice / openNumber : 0;
    const shelfShare = spans[0].tokens.muln(10_000).div(sold).toNumber() / 100;
    const shelfAt = spans.length > 1 && shelfLift > 1.05 && shelfLift < 1.16 ? Math.round(shelfShare * 10) / 10 : null;
    const line =
      shelfAt === null
        ? `The price rises from ${openLabel} to ${endLabel} as the tokens are bought.`
        : `${shelfAt}% of the tokens buyers receive stay within 10% of ${openLabel}. The last slice finishes at ${endLabel}.`;
    const fee = config.poolFees.baseFee;
    const periods = Number(fee.firstFactor);
    const cliff = new BN(fee.cliffFeeNumerator.toString());
    const reduction = new BN(fee.thirdFactor.toString());
    const feePercents: number[] = [];
    if (periods <= 0) {
      const flat = Math.round((feeNumeratorToBps(cliff) / 100) * 100) / 100;
      for (let step = 0; step < steps; step += 1) feePercents.push(flat);
    } else {
      for (let step = 0; step < steps; step += 1) {
        const period = Math.round((periods * step) / (steps - 1));
        const numerator = getBaseFeeNumeratorByPeriod(cliff, periods, new BN(period), reduction, fee.baseFeeMode);
        feePercents.push(Math.round((feeNumeratorToBps(numerator) / 100) * 100) / 100);
      }
    }
    const firstFee = feePercentText(feePercents[0]);
    const lastFee = feePercentText(feePercents[feePercents.length - 1]);
    const feeLine =
      periods <= 0 || firstFee === lastFee
        ? `The fee stays at ${firstFee}% for the whole sale.`
        : shape?.straightFall
          ? `The fee steps from ${firstFee}% to ${lastFee}% over ${feeDecayLabel(feeDurationSeconds)}.`
          : `The fee falls on a curve from ${firstFee}% to ${lastFee}% over ${feeDecayLabel(feeDurationSeconds)}.`;
    return { prices, openLabel, endLabel, shelfAt, line, feePercents, feeLine };
  } catch {
    return null;
  }
}

export function describeLaunch(
  choice: LaunchChoice,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): LaunchPicture {
  try {
    const split = pricedSplit(choice);
    if (split) {
      if (!Number.isInteger(split.supply) || split.supply < 2 || split.supply > 1_000_000_000_000) {
        return { ...EMPTY, error: "Supply has to be a whole number from 2 to 1,000,000,000,000." };
      }
      if (!(split.open > 0) || !(split.pool > split.open)) {
        return { ...EMPTY, error: "The pool price has to be above the opening price." };
      }
      const built = buildSplit(
        split.supply,
        split.open,
        split.pool,
        split.percent,
        openingFeeBps,
        endingFeeBps,
        platformFeePercent,
        feeDurationSeconds,
        migrationFeeBps,
        kind,
        reserve,
        extra,
        shape,
      );
      return pictureFromSplit(built.config, split.supply, built.leftover, kind, extra);
    }
    if (choice.kind === "climb") {
      return pictureFromClimb(
        buildClimb(choice.raise, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape),
        choice.raise,
        kind,
        extra,
      );
    }
    if (choice.kind === "custom") {
      if (!Number.isInteger(choice.supply) || choice.supply < 2 || choice.supply > 1_000_000_000_000) {
        return { ...EMPTY, error: "Supply has to be a whole number from 2 to 1,000,000,000,000." };
      }
      if (!(choice.openPrice > 0) || !(choice.endPrice > choice.openPrice)) {
        return { ...EMPTY, error: "The graduation price has to be above the opening price." };
      }
      const config = buildLaunchConfig(choice, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
      const sold = soldOnCurve(config);
      const decimals = dec(kind, extra);
      const start = getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, decimals);
      const endSqrt = config.curve.find((point) => !new BN(point.liquidity.toString()).isZero())?.sqrtPrice;
      const end = endSqrt ? getPriceFromSqrtPrice(endSqrt, BASE_DECIMALS, decimals) : start;
      const locked = uiRaise(config.migrationQuoteThreshold, kind, extra);
      const shareOfCurve = locked > 0 ? (sampleBuy(kind) / locked) * 100 : 0;
      const unit = new BN(10).pow(new BN(BASE_DECIMALS));
      const lockedRaw = new BN(choice.supply).mul(unit).sub(reservedRaw(config)).sub(sold);
      return {
        ...EMPTY,
        ok: true,
        supply: choice.supply,
        parPrice: tokenPrice(start, kind, extra),
        poolPrice: tokenPrice(end, kind, extra),
        parMarketCap: quoteMoney(start.mul(choice.supply), kind, extra),
        poolMarketCap: quoteMoney(end.mul(choice.supply), kind, extra),
        locked: `${groupedWhole(sold)} tokens are sold. ${groupedWhole(lockedRaw)} tokens migrate into the pool with ${formatQuote(locked, kind, extra)}. That is ${(lockedRaw.muln(10_000).div(new BN(choice.supply).mul(unit)).toNumber() / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the supply. They cannot be withdrawn. Trading opens at the pool price. Later buys can move it higher, and later sells can move it lower.`,
        raise: formatQuote(locked, kind, extra),
        raiseRaw: config.migrationQuoteThreshold.toString(),
        tenDollarShare:
          shareOfCurve >= 100
            ? "more than the whole curve"
            : shareOfCurve < 0.1
              ? "a speck of the curve"
              : `${shareOfCurve.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of the curve`,
        keeper: keeperNote(locked, kind, extra),
        migratedTokens: Number(lockedRaw.div(unit).toString()),
        migratedPercent: lockedRaw.muln(10_000).div(new BN(choice.supply).mul(unit)).toNumber() / 100,
        migrationWarning: migrationWarning(lockedRaw.muln(10_000).div(new BN(choice.supply).mul(unit)).toNumber() / 100),
        creator: creatorLine(config, choice.supply),
      };
    }
    if (choice.kind === "fixed") {
      return describeFair(PAR_FIXED.supply, PAR_FIXED.par, PAR_FIXED.pool, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
    }
    if (choice.kind === "custom-par") {
      if (!Number.isInteger(choice.supply) || choice.supply < 2 || choice.supply > 1_000_000_000_000) {
        return { ...EMPTY, fair: true, error: "Supply has to be a whole number from 2 to 1,000,000,000,000." };
      }
      return describeFair(choice.supply, choice.parPrice, choice.poolPrice, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
    }
    const picture = describeFair(BILLION_SUPPLY, choice.parPrice, choice.poolPrice, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
    if (!picture.ok) return picture;
    const locked = uiRaise(new BN(picture.raiseRaw), kind, extra);
    const target = choice.raise;
    const tolerance = Math.max(target * 0.02, kind === "sol" ? 0.05 : 50);
    if (Math.abs(locked - target) > tolerance) {
      return {
        ...EMPTY,
        fair: true,
        error: `These prices lock ${formatQuote(locked, kind, extra)}. This card locks ${formatQuote(target, kind, extra)}. The prices on a preset follow the migrating share, and the lock stays the amount on the card.`,
      };
    }
    return picture;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "That curve is not valid.";
    const tooLarge =
      reserve.tokens > 0 && /swap base amount|migration base amount|leftOverDelta|not enough liquidity/i.test(message);
    return {
      ...EMPTY,
      fair: choice.kind !== "climb" && choice.kind !== "custom",
      error: tooLarge ? "That creator supply leaves too little for the sale and the pool. Lower the percent." : message,
    };
  }
}

export type CustomMarks = {
  supply: string;
  open: string;
  end: string;
  par: string;
  pool: string;
  share: string;
  picture: LaunchPicture;
};

export function shareMarkFor(migrateText: string): { percent?: number; mark: string } {
  const trimmed = migrateText.trim();
  if (!trimmed) return { mark: "" };
  if (!/^\d+$/.test(trimmed)) return { mark: "Enter the migrating share as a whole number, or leave it blank." };
  const percent = Number(trimmed);
  if (percent < 1) {
    return { mark: "Enter the migrating share as a whole number from 1 to 49, or leave it blank." };
  }
  if (percent > 49) {
    return { mark: "A rising curve cannot lock half the supply and also finish at a higher price. Use 49 or less, or leave the field blank." };
  }
  return { percent, mark: "" };
}

function decimalAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function supplyMarkFor(supplyText: string): { supply: number; mark: string } {
  const trimmed = supplyText.trim();
  const supply = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!/^\d+$/.test(trimmed)) return { supply, mark: "Enter the supply as a whole number." };
  if (supply < 2) return { supply, mark: "Supply has to be at least 2." };
  if (supply > 1_000_000_000_000) return { supply, mark: "Supply cannot pass 1,000,000,000,000." };
  return { supply, mark: "" };
}

function blankMarks(picture: LaunchPicture): CustomMarks {
  return { supply: "", open: "", end: "", par: "", pool: "", share: "", picture };
}

function friendlyCurveError(message: string, fair: boolean): { open: string; end: string; par: string; pool: string; text: string } {
  const both = fair ? { open: "", end: "", par: message, pool: message } : { open: message, end: message, par: "", pool: "" };
  if (/invalid pool fees|base fee must be/i.test(message)) {
    return { open: "", end: "", par: "", pool: "", text: "Curve fee must be from 0.25% to 99%." };
  }
  if (/not enough liquidity/i.test(message)) {
    const text = fair
      ? "The pool price is too far above par for this supply. Move the two prices closer."
      : "The graduation price is too far above the opening price for this supply. Move the two prices closer.";
    return { ...both, text };
  }
  if (/sqrt start price/i.test(message)) {
    const text = fair ? "Par is outside the range a 6-decimal token can use." : "The opening price is outside the range a 6-decimal token can use.";
    return { open: fair ? "" : text, end: "", par: fair ? text : "", pool: "", text };
  }
  if (/migration sqrt price|exceeds maximum/i.test(message)) {
    const text = fair ? "The pool price is too high for this supply." : "The graduation price is too high for this supply.";
    return { open: "", end: fair ? "" : text, par: "", pool: fair ? text : "", text };
  }
  if (/creator supply|vesting|leftOverDelta|swap base amount must|migration base amount must/i.test(message)) {
    const text = "That creator supply leaves too little for the sale and the pool. Lower the percent.";
    return { ...both, text };
  }
  if (/overflow|curve is empty/i.test(message)) {
    const text = fair
      ? "These prices do not stay inside the PAR band. Move the pool price closer to par."
      : "This supply and these prices do not fit on the curve.";
    return { ...both, text };
  }
  return { ...both, text: message };
}

/** Field marks for a custom climb. Rejected numbers stay red and Review create stays closed. */
export function checkClimbCustom(
  supplyText: string,
  openText: string,
  endText: string,
  migrateText: string,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): CustomMarks {
  const unit = kind === "sol" ? "SOL" : kind === "other" ? unitOf(kind, extra) : "USDC";
  const { supply, mark } = supplyMarkFor(supplyText);
  const share = shareMarkFor(migrateText);
  const open = decimalAmount(openText);
  const end = decimalAmount(endText);
  let openMark = open === null ? `Enter the opening price in ${unit} per token.` : "";
  let endMark = end === null ? `Enter the graduation price in ${unit} per token.` : "";
  if (!openMark && !endMark && open !== null && end !== null) {
    if (end < open) endMark = "Graduation price is below the opening price. The curve only moves up.";
    else if (end === open) endMark = "Graduation price has to be above the opening price.";
  }
  if (mark || openMark || endMark || share.mark) {
    return {
      ...blankMarks({ ...EMPTY, error: mark || openMark || endMark || share.mark }),
      supply: mark,
      open: openMark,
      end: endMark,
      share: share.mark,
    };
  }
  const picture = describeLaunch(
    {
      kind: "custom",
      supply,
      openPrice: open as number,
      endPrice: end as number,
      ...(share.percent ? { migratePercent: share.percent } : {}),
    },
    openingFeeBps,
    endingFeeBps,
    platformFeePercent,
    feeDurationSeconds,
    migrationFeeBps,
    kind,
    reserve,
    extra,
    shape,
  );
  if (picture.ok) return blankMarks(picture);
  if (/do not fit together|Under 20%/i.test(picture.error)) {
    return { ...blankMarks(picture), share: picture.error };
  }
  const mapped = friendlyCurveError(picture.error, false);
  return { ...blankMarks({ ...picture, error: mapped.text }), open: mapped.open, end: mapped.end };
}

/** Field marks for PAR. Preset PAR keeps one billion tokens. A typed supply is used for custom. */
export function checkParPrices(
  parText: string,
  poolText: string,
  supplyText: string | null,
  raise: RaiseChoice | null,
  migrateText: string,
  openingFeeBps: number,
  endingFeeBps: number,
  platformFeePercent: number,
  feeDurationSeconds: number,
  migrationFeeBps = 25,
  kind: QuoteKind = "usdc",
  reserve: CreatorReserve = NO_RESERVE,
  extra?: QuoteExtra,
  shape?: CurveShape,
): CustomMarks {
  const unit = kind === "sol" ? "SOL" : kind === "other" ? unitOf(kind, extra) : "USDC";
  const par = decimalAmount(parText);
  const pool = decimalAmount(poolText);
  const share = shareMarkFor(migrateText);
  const supplied = supplyText === null ? { supply: 0, mark: "" } : supplyMarkFor(supplyText);
  let parMark = par === null ? `Enter par in ${unit} per token. This is the price the first buyers pay.` : "";
  let poolMark =
    pool === null
      ? kind === "sol"
        ? "Enter the pool price in SOL per token. 1 can lock at 1.20. A small price such as 0.00005 can lock at 0.00006."
        : kind === "other"
          ? `Enter the pool price in ${unit} per token. The opening stays within 10% of par, so the pool price has to sit above that.`
          : "Enter the pool price in USDC per token. $1 can lock at $1.20. $0.20 can lock at $0.25, $0.30, or $0.40."
      : "";
  if (!parMark && !poolMark && par !== null && pool !== null) {
    if (pool < par) poolMark = "The pool price is below par. The curve only moves up, and the lock has to be the higher price.";
    else if (pool === par) poolMark = "The pool price has to be above par.";
    else if (pool <= par * SHELF_LIFT) {
      poolMark = "The pool price is still on the shelf. The opening stays within 10% of par, so the pool price has to sit above that.";
    } else if (pool > par * PAR_MAX_LIFT * 1.0000001) {
      poolMark = "That finish is more than double par. PAR keeps the pool price at or under twice the opening. Turn PAR off for a wider gap.";
    }
  }
  if (supplied.mark || parMark || poolMark || share.mark) {
    return {
      ...blankMarks({ ...EMPTY, fair: true, error: supplied.mark || parMark || poolMark || share.mark }),
      supply: supplied.mark,
      par: parMark,
      pool: poolMark,
      share: share.mark,
    };
  }
  const migratePercent = share.percent ? { migratePercent: share.percent } : {};
  const choice: LaunchChoice =
    supplyText === null
      ? { kind: "par", raise: raise as RaiseChoice, parPrice: par as number, poolPrice: pool as number, ...migratePercent }
      : { kind: "custom-par", supply: supplied.supply, parPrice: par as number, poolPrice: pool as number, ...migratePercent };
  const picture = describeLaunch(choice, openingFeeBps, endingFeeBps, platformFeePercent, feeDurationSeconds, migrationFeeBps, kind, reserve, extra, shape);
  if (picture.ok) return blankMarks(picture);
  if (/do not fit together|Under 20%/i.test(picture.error)) {
    return { ...blankMarks(picture), share: picture.error };
  }
  if (/double par|still on the shelf|below par|has to be above par/i.test(picture.error)) {
    return { ...blankMarks(picture), pool: picture.error };
  }
  const mapped = friendlyCurveError(picture.error, true);
  return { ...blankMarks({ ...picture, error: mapped.text }), par: mapped.par, pool: mapped.pool };
}
