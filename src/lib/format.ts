import BN from "bn.js";
import { QUOTE_DECIMALS } from "./constants";

export function uiToRaw(amount: string, decimals: number): BN {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a positive amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`Use at most ${decimals} decimal places`);
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = new BN(whole).mul(new BN(10).pow(new BN(decimals))).add(new BN(padded || "0"));
  if (raw.isZero()) throw new Error("Enter a positive amount");
  return raw;
}

export function rawToUi(raw: BN, decimals: number, maxFraction = decimals): string {
  const negative = raw.isNeg();
  const value = negative ? raw.abs() : raw;
  const base = new BN(10).pow(new BN(decimals));
  const whole = value.div(base).toString();
  let frac = value.mod(base).toString().padStart(decimals, "0");
  frac = frac.slice(0, maxFraction).replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${text}` : text;
}

/** A positive number as a plain decimal. 0.0002 stays 0.0002. It does not become 2e-4. */
export function plainDecimal(amount: number, maxFraction = 9): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const fixed = amount.toFixed(maxFraction);
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatDollars(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return "";
  if (amount >= 1) return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (amount >= 0.01) return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  const text = plainDecimal(amount, 6);
  return text ? `$${text}` : "$0";
}

/** Dollars of SOL at the live price. The pool still spends SOL. */
export function dollarsToSol(dollars: number, usdPerSol: number): string {
  if (!(dollars > 0) || !(usdPerSol > 0)) return "";
  return plainDecimal(dollars / usdPerSol, 9);
}

export function formatMoney(raw: BN, decimals = QUOTE_DECIMALS): string {
  const precise = rawToUi(raw, decimals, Math.min(9, decimals));
  if (!precise.includes(".")) return `${precise}.00`;
  const [whole, frac] = precise.split(".");
  if (frac.length < 2) return `${whole}.${frac.padEnd(2, "0")}`;
  return precise;
}

export function pricePerToken(
  usdcRaw: BN,
  tokenRaw: BN,
  usdcDecimals: number,
  tokenDecimals: number,
): string {
  if (tokenRaw.isZero()) return "0.00";
  const scale = 8;
  const scaled = usdcRaw
    .mul(new BN(10).pow(new BN(tokenDecimals + scale)))
    .div(tokenRaw.mul(new BN(10).pow(new BN(usdcDecimals))));
  return formatMoney(scaled, scale);
}

export function formatTokenPrice(value: {
  toNumber: () => number;
  toFixed: (digits: number) => string;
  gte: (n: number) => boolean;
  toSignificantDigits: (digits: number) => { toString: () => string };
}): string {
  const compact = value.toSignificantDigits(value.gte(1) ? 6 : 6).toString();
  if (!/[eE]/.test(compact)) return compact;
  const amount = value.toNumber();
  if (!Number.isFinite(amount) || amount <= 0) return compact;
  return value.toFixed(12).replace(/0+$/, "");
}

export function formatLamports(lamports: number): string {
  const raw = new BN(lamports);
  return `${rawToUi(raw, 9, 9)} SOL (${lamports.toLocaleString("en-US")} lamports)`;
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
