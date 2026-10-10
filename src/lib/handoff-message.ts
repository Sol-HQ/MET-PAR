export type HandoffPlace = "none" | "wallet" | "listed" | "escrow" | "held";

export type HandoffPublic = {
  indexed: boolean;
  place: HandoffPlace;
  handoffDays: number | null;
  heldAt: string | null;
  daysLeft: number | null;
};

export type HandoffSide = "sale" | "purchase";

export const HANDOFF_DAY_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 120) return null;
  return email;
}

/** `subscribe` plus the address, or the exact word `stop`. The wallet signs that text. */
export function parseSubscribe(text: string): { email: string } | "stop" | null {
  if (text === "stop") return "stop";
  const split = text.split("\n");
  if (split.length !== 2 || split[0] !== "subscribe") return null;
  const email = cleanEmail(split[1] ?? "");
  return email ? { email } : null;
}

export type BuyerCard = { name: string; address: string; email: string };

export type BuyerLeave = BuyerCard & { message: string; subscribe: boolean };

/** One signed payload: name, mailing address, email, an optional message, and whether PAR may write. */
export function parseBuyerLeave(text: string): BuyerLeave | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || typeof row.address !== "string" || typeof row.email !== "string") return null;
  if (typeof row.message !== "string" || typeof row.subscribe !== "boolean") return null;
  const email = cleanEmail(row.email);
  if (!email) return null;
  return { name: row.name, address: row.address, email, message: row.message, subscribe: row.subscribe };
}

export function buyerCardText(card: BuyerCard): string {
  const lines: string[] = [];
  if (card.name) lines.push(`Name: ${card.name}`);
  if (card.address) lines.push(`Mailing address: ${card.address}`);
  lines.push(`Email: ${card.email}`);
  return lines.join("\n");
}

/** Reads a buyer card the seller is allowed to see. Other handoff lines stay plain text. */
export function readBuyerCard(body: string): BuyerCard | null {
  if (!body.startsWith("Name: ") && !body.startsWith("Mailing address: ") && !body.startsWith("Email: ")) return null;
  let name = "";
  let address = "";
  let email = "";
  let mode: "name" | "address" | "email" | "" = "";
  for (const line of body.split("\n")) {
    if (line.startsWith("Name: ")) {
      mode = "name";
      name = line.slice("Name: ".length);
      continue;
    }
    if (line.startsWith("Mailing address: ")) {
      mode = "address";
      address = line.slice("Mailing address: ".length);
      continue;
    }
    if (line.startsWith("Email: ")) {
      mode = "email";
      email = line.slice("Email: ".length);
      continue;
    }
    if (mode === "address") address = `${address}\n${line}`;
    else return null;
  }
  const clean = cleanEmail(email);
  if (!clean) return null;
  return { name: name.trim(), address: address.trim(), email: clean };
}

/** The wallet signs these exact lines. The server rejects anything else. */
export function handoffMessage(input: {
  kind: "mail" | "reach" | "read" | "note" | "buyer";
  cluster: string;
  title: string;
  wallet: string;
  text: string;
  issuedAt: number;
}): string {
  return ["PAR handoff", input.kind, input.cluster, input.title, input.wallet, input.text, String(input.issuedAt)].join("\n");
}

export function parFrom(raw: string): string | null {
  const trimmed = raw.trim();
  const inner = /<([^<>\s]+)>/.exec(trimmed)?.[1] ?? trimmed;
  if (!EMAIL.test(inner) || inner.length > 120) return null;
  return `PAR platform <${inner}>`;
}

export function parAddress(raw: string): string | null {
  const from = parFrom(raw);
  return from ? (/<([^>]+)>/.exec(from)?.[1] ?? null) : null;
}

export function parSubject(side: HandoffSide, name: string, what: string): string {
  const about = side === "sale" ? "Your sale" : "Your purchase";
  const cleanName = name.replace(/\s+/g, " ").trim().slice(0, 80) || "this object";
  const cleanWhat = what.replace(/\s+/g, " ").trim().slice(0, 80);
  return `PAR platform · ${about} of ${cleanName} · ${cleanWhat}`;
}

/** Header lines name PAR and say sale or purchase. Every handoff email uses this. */
export function parLetter(side: HandoffSide, name: string, detail: string[], includeStop = true): string[] {
  const about = side === "sale" ? "your sale" : "your purchase";
  const cleanName = name.replace(/\s+/g, " ").trim().slice(0, 80) || "this object";
  const lines = ["This message is from the PAR platform.", `It is about ${about} of ${cleanName}.`, "", ...detail, ""];
  if (includeStop) lines.push("To stop these messages, open the sale page, sign in, and clear the subscription.");
  lines.push("PAR is software. It does not hold the object. The person named on the sheet owes the handoff.");
  return lines;
}

export function handoffEndsAt(heldAt: string, days: number): number | null {
  const start = Date.parse(heldAt);
  if (!Number.isFinite(start) || !Number.isInteger(days) || days < 1) return null;
  return start + days * HANDOFF_DAY_MS;
}

/** Last 3 days, or sooner when the sheet itself is a short window. */
export function handoffCloseMs(days: number): number {
  if (days <= 1) return 12 * 60 * 60 * 1000;
  if (days <= 3) return HANDOFF_DAY_MS;
  return 3 * HANDOFF_DAY_MS;
}

export function reminderDue(heldAt: string | null, days: number | null, now = Date.now()): boolean {
  if (!heldAt || !days) return false;
  const end = handoffEndsAt(heldAt, days);
  if (end === null) return false;
  return end - now <= handoffCloseMs(days);
}
