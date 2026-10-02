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

export function formatUsdc(raw: BN): string {
  return rawToUi(raw, QUOTE_DECIMALS, 6);
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
