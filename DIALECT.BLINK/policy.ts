export type SaleGateInput = {
  noCoin: boolean;
  saleOpens: string;
  graduated: boolean | null;
  finishedAt: number;
  nowSeconds: number;
};

/**
 * Mirrors PAR's creator/Tensor sale gate. No-coin titles may sell once listed;
 * attached-coin titles must have graduated and completed their signed delay.
 * Unknown or malformed terms fail closed.
 */
export function isBlinkSaleOpen(input: SaleGateInput): boolean {
  if (input.noCoin) return input.saleOpens === "when the creator lists it";
  const match = /^(\d{1,3}) days after graduation$/.exec(input.saleOpens);
  if (!match || input.graduated !== true || !Number.isSafeInteger(input.finishedAt) || input.finishedAt <= 0) {
    return false;
  }
  const days = Number(match[1]);
  if (days < 1 || days > 365) return false;
  return input.nowSeconds >= input.finishedAt + days * 86_400;
}

export function textForBlink(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}