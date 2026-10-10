import { timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import { Connection, PublicKey } from "@solana/web3.js";
import { serverRpcUrl, type ClusterName } from "./constants";
import {
  HANDOFF_DAY_MS,
  parAddress,
  parFrom,
  parLetter,
  parSubject,
  buyerCardText,
  parseBuyerLeave,
  parseSubscribe,
  readBuyerCard,
  reminderDue,
  type HandoffPlace,
  type HandoffPublic,
  type HandoffSide,
} from "./handoff-message";
import { PUBLIC_ORIGIN } from "./record";
import {
  deleteHandoffHold,
  deleteHandoffMail,
  hasIndex,
  insertHandoffHold,
  insertHandoffNote,
  latestHandoffNote,
  listHandoffHolds,
  listNudgeTitles,
  listTitleAddresses,
  markHandoffIntro,
  markHandoffMail,
  markHandoffNote,
  markHandoffNudge,
  readAnyOtherHold,
  readHandoffHold,
  readHandoffMail,
  readHandoffNoteBySignature,
  readHandoffReach,
  writeHandoffReach,
  readHeliusHook,
  readItemByTitle,
  readItemsByTitles,
  readOpenHandoffNotes,
  type HoldRow,
  type IndexedTitle,
  writeHandoffMail,
  writeHeliusHook,
} from "./store";
import { ESCROW_PROGRAM, listingAddress, readTitle, saleUrl, tensorListAddress } from "./title";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HOOK_REFRESH_MS = 10 * 60 * 1000;

export type { HandoffPlace, HandoffPublic };
export { cleanEmail, parseSubscribe } from "./handoff-message";

export function cleanReach(value: string): string {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code >= 32) text += char;
  }
  return text.replace(/[^\S\n]+/g, " ").trim().slice(0, 500);
}

export function verifyHandoffSignature(message: string, signatureB64: string, wallet: string): boolean {
  if (!ADDRESS.test(wallet)) return false;
  let signature: Uint8Array;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), signature, new PublicKey(wallet).toBytes());
  } catch {
    return false;
  }
}

export function webhookAuthorized(header: string | null): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function heliusKey(cluster: ClusterName): string | null {
  try {
    const url = new URL(serverRpcUrl(cluster));
    if (!url.hostname.includes("helius")) return null;
    return url.searchParams.get("api-key");
  } catch {
    return null;
  }
}

function handoffDaysOf(sheet: string): number | null {
  try {
    const parsed = JSON.parse(sheet) as { record?: { redemption?: { handoffDays?: string | number } } };
    const days = Number(parsed.record?.redemption?.handoffDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return null;
    return days;
  } catch {
    return null;
  }
}

function daysLeft(heldAt: string | null, days: number | null): number | null {
  if (!heldAt || !days) return null;
  const start = Date.parse(heldAt);
  if (!Number.isFinite(start)) return null;
  const end = start + days * HANDOFF_DAY_MS;
  return Math.ceil((end - Date.now()) / HANDOFF_DAY_MS);
}

function placeOf(owner: string, creator: string, title: string, cluster: ClusterName): HandoffPlace {
  if (!owner) return "none";
  const tensor = tensorListAddress(new PublicKey(title)).toBase58();
  if (owner === tensor) return "listed";
  const program = ESCROW_PROGRAM[cluster];
  if (program && owner === listingAddress(new PublicKey(title), new PublicKey(program)).toBase58()) return "escrow";
  if (creator && owner === creator) return "wallet";
  return "held";
}

async function latestChange(cluster: ClusterName, title: string): Promise<{ signature: string; at: string | null }> {
  try {
    const connection = new Connection(serverRpcUrl(cluster), "confirmed");
    const rows = await connection.getSignaturesForAddress(new PublicKey(title), { limit: 1 });
    const row = rows[0];
    if (!row) return { signature: "", at: null };
    return { signature: row.signature, at: row.blockTime ? new Date(row.blockTime * 1000).toISOString() : null };
  } catch {
    return { signature: "", at: null };
  }
}

function objectName(name: string): string {
  const line = name.replace(/\s+/g, " ").trim().slice(0, 80);
  return line || "your title";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Sale mail goes only to the seller. Purchase mail goes only to the buyer. */
async function sendAbout(email: string, side: HandoffSide, name: string, what: string, detail: string[]): Promise<"sent" | "idle" | "retry"> {
  const key = process.env.RESEND_API_KEY;
  const fromRaw = process.env.HANDOFF_FROM;
  if (!key || !fromRaw) return "idle";
  const from = parFrom(fromRaw);
  const reply = parAddress(fromRaw);
  const subject = parSubject(side, name, what);
  if (!from || !reply || !subject.startsWith("PAR platform · ")) return "idle";
  const lines = parLetter(side, name, detail, what !== "Email stopped");
  const html = [`<p><strong>PAR platform</strong></p>`, ...lines.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`)].join("");
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        reply_to: reply,
        subject,
        text: lines.join("\n"),
        html,
        headers: { "X-PAR-Platform": "PAR platform", "X-PAR-About": side },
      }),
    });
    if (response.ok) return "sent";
    if (response.status >= 500) return "retry";
    return "idle";
  } catch {
    return "retry";
  }
}

async function tryMail(cluster: ClusterName, item: IndexedTitle, owner: string, kind: "held" | "home"): Promise<"sent" | "idle" | "retry"> {
  const email = await readHandoffMail(cluster, item.creator);
  if (!email) {
    await markHandoffMail(cluster, item.title, owner, "wait");
    return "idle";
  }
  const page = saleUrl(item.title, cluster);
  const name = objectName(item.name);
  const days = handoffDaysOf(item.sheet);
  const detail =
    kind === "home"
      ? ["The title is back in your wallet.", `Sale page: ${page}`]
      : [
          "A buyer now holds the title.",
          `Sale page: ${page}`,
          days
            ? `The sheet gives ${days} ${days === 1 ? "day" : "days"} for the handoff. The clock on that page counts them down.`
            : "The sheet names the handoff. The clock on the sale page follows it.",
          "Your promise is to hand the object to the holder of the title.",
          "Write on the sale page when you are ready. PAR sends each note only to the buyer.",
        ];
  const result = await sendAbout(email, "sale", name, kind === "home" ? "The title is back in your wallet" : "A buyer holds the title", detail);
  if (result === "sent") await markHandoffMail(cluster, item.title, owner, "sent");
  return result;
}

export async function saveSubscription(input: {
  cluster: ClusterName;
  item: IndexedTitle;
  wallet: string;
  side: HandoffSide;
  text: string;
}): Promise<"sent" | "saved" | "same" | "stopped" | "bad"> {
  const parsed = parseSubscribe(input.text);
  if (!parsed) return "bad";
  const prior = await readHandoffMail(input.cluster, input.wallet);
  const name = objectName(input.item.name);
  const page = saleUrl(input.item.title, input.cluster);
  if (parsed === "stop") {
    if (prior) await deleteHandoffMail(input.cluster, input.wallet);
    if (prior) {
      await sendAbout(prior, input.side, name, "Email stopped", [
        "You cleared this subscription.",
        `PAR will not send more messages about this ${input.side === "sale" ? "sale" : "purchase"} to this address.`,
        `Sale page: ${page}`,
      ]);
    }
    return "stopped";
  }
  if (prior === parsed.email) return "same";
  await writeHandoffMail(input.cluster, input.wallet, parsed.email);
  const detail =
    input.side === "sale"
      ? [
          "You asked the PAR platform to email this address about your sale.",
          "PAR writes when a buyer holds the title, when the handoff days run close, and when the buyer leaves a note on the sale page.",
          `Sale page: ${page}`,
        ]
      : [
          "You asked the PAR platform to email this address about your purchase.",
          "Notes the seller writes on the sale page come to this address.",
          `Sale page: ${page}`,
        ];
  const result = await sendAbout(parsed.email, input.side, name, "You are subscribed", detail);
  return result === "sent" ? "sent" : "saved";
}

const NOTE_GAP_MS = 20 * 1000;

export async function acceptNote(input: {
  cluster: ClusterName;
  title: string;
  wallet: string;
  text: string;
  signature: string;
}): Promise<"bad" | "soon" | "replay" | "saved"> {
  const body = cleanReach(input.text);
  if (!body) return "bad";
  const existing = await readHandoffNoteBySignature(input.cluster, input.signature);
  if (existing) return "replay";
  const last = await latestHandoffNote(input.cluster, input.title, input.wallet);
  if (last && Date.now() - Date.parse(last.created_at) < NOTE_GAP_MS) return "soon";
  try {
    await insertHandoffNote({ cluster: input.cluster, title: input.title, wallet: input.wallet, body, signature: input.signature });
  } catch (error) {
    const again = await readHandoffNoteBySignature(input.cluster, input.signature);
    if (again) return "replay";
    throw error;
  }
  return "saved";
}

function oneLine(value: string, max: number): string {
  return cleanReach(value.replace(/\n/g, " ")).slice(0, max);
}

function cardLines(card: { name: string; address: string; email: string }, message: string): string[] {
  const lines = ["The buyer left contact on the sale page and is waiting to hear from you."];
  if (card.name) lines.push(`Name: ${card.name}`);
  if (card.address) {
    lines.push("Mailing address:");
    for (const line of card.address.split("\n")) if (line.trim()) lines.push(line.trim());
  }
  lines.push(`Email: ${card.email}`);
  if (message) {
    lines.push("The buyer wrote:");
    lines.push(message);
  }
  return lines;
}

async function mailBuyerContact(cluster: ClusterName, item: IndexedTitle, owner: string, message: string): Promise<"sent" | "idle" | "retry" | "wait"> {
  const seller = await readHandoffMail(cluster, item.creator);
  if (!seller) return "wait";
  const reach = await readHandoffReach(cluster, item.title, owner);
  const card = reach ? readBuyerCard(reach.body) : null;
  if (!card) return "wait";
  const result = await sendAbout(seller, "sale", objectName(item.name), "The buyer left contact", [
    ...cardLines(card, message),
    `Sale page: ${saleUrl(item.title, cluster)}`,
  ]);
  return result;
}

/** The holder leaves a name, mailing address, and email for the seller in one signature. */
export async function acceptBuyerLeave(input: {
  cluster: ClusterName;
  item: IndexedTitle;
  wallet: string;
  text: string;
  signature: string;
}): Promise<"bad" | "soon" | "replay" | "same" | "saved"> {
  if (input.text.length > 2500) return "bad";
  const parsed = parseBuyerLeave(input.text);
  if (!parsed) return "bad";
  const name = oneLine(parsed.name, 80);
  const address = cleanReach(parsed.address).slice(0, 220);
  const message = cleanReach(parsed.message).slice(0, 500);
  const cardText = buyerCardText({ name, address, email: parsed.email });
  if (cardText.length > 500 || !readBuyerCard(cardText)) return "bad";
  const existing = message ? await readHandoffNoteBySignature(input.cluster, input.signature) : null;
  if (existing) return "replay";
  if (message) {
    const last = await latestHandoffNote(input.cluster, input.item.title, input.wallet);
    if (last && Date.now() - Date.parse(last.created_at) < NOTE_GAP_MS) return "soon";
  }
  const current = await readHandoffReach(input.cluster, input.item.title, input.wallet);
  if (current && current.body !== cardText && Date.now() - Date.parse(current.updated_at) < NOTE_GAP_MS) return "soon";
  const prior = await readHandoffMail(input.cluster, input.wallet);
  const sameMail = parsed.subscribe ? prior === parsed.email : !prior;
  if (current?.body === cardText && !message && sameMail) return "same";
  const hold = await readHandoffHold(input.cluster, input.item.title, input.wallet);
  await writeHandoffReach(input.cluster, input.item.title, input.wallet, cardText);
  if (parsed.subscribe) {
    await saveSubscription({ cluster: input.cluster, item: input.item, wallet: input.wallet, side: "purchase", text: `subscribe\n${parsed.email}` });
  } else if (prior) {
    await saveSubscription({ cluster: input.cluster, item: input.item, wallet: input.wallet, side: "purchase", text: "stop" });
  }
  if (message) {
    const noted = await acceptNote({ cluster: input.cluster, title: input.item.title, wallet: input.wallet, text: message, signature: input.signature });
    if (noted === "bad") return "bad";
  }
  if (hold?.intro === "sent") {
    const mailed = await mailBuyerContact(input.cluster, input.item, input.wallet, message);
    if (mailed === "sent" && message) {
      const row = await readHandoffNoteBySignature(input.cluster, input.signature);
      if (row && row.mail !== "sent") await markHandoffNote(row.id, "sent");
    }
  }
  return "saved";
}

/** Pauses a reminder while this owner is not holding the title. Drops unsent notes only when the title is home. */
async function closeQuiet(cluster: ClusterName, title: string, liveOwner: string, keepLive: boolean, dropNotes: boolean): Promise<void> {
  const holds = await listHandoffHolds(cluster, title);
  for (const hold of holds) {
    if (keepLive && hold.owner === liveOwner) continue;
    if (hold.nudge === "open" || hold.nudge === "wait") await markHandoffNudge(cluster, title, hold.owner, "skip");
  }
  if (!dropNotes) return;
  const notes = await readOpenHandoffNotes(cluster, title);
  for (const note of notes) await markHandoffNote(note.id, "skip");
}

async function remindSeller(cluster: ClusterName, item: IndexedTitle, owner: string, hold: HoldRow, days: number | null): Promise<boolean> {
  if (hold.nudge === "sent") return false;
  if (!hold.held_at || !reminderDue(hold.held_at, days)) return false;
  const email = await readHandoffMail(cluster, item.creator);
  if (!email) {
    if (hold.nudge !== "wait") await markHandoffNudge(cluster, item.title, owner, "wait");
    return false;
  }
  const end = hold.held_at && days ? Date.parse(hold.held_at) + days * HANDOFF_DAY_MS : NaN;
  const leftMs = Number.isFinite(end) ? end - Date.now() : 0;
  const leftDays = Math.ceil(leftMs / HANDOFF_DAY_MS);
  const remain =
    leftMs <= 0
      ? "The handoff days on the sheet have passed."
      : leftDays <= 1
        ? "Less than a day remains on the handoff clock."
        : `${leftDays} days remain on the handoff clock.`;
  const result = await sendAbout(email, "sale", objectName(item.name), "The handoff days are close", [
    "This is a reminder to finish the handoff.",
    remain,
    days
      ? `Your promise is to hand the object to the holder of the title within ${days} ${days === 1 ? "day" : "days"} of their claim.`
      : "Your promise is to hand the object to the holder of the title.",
    `Sale page: ${saleUrl(item.title, cluster)}`,
    "Open that page, read the buyer's note, and answer on the page.",
  ]);
  if (result === "sent") await markHandoffNudge(cluster, item.title, owner, "sent");
  return result === "retry";
}

async function introduceBuyer(cluster: ClusterName, item: IndexedTitle, owner: string, hold: HoldRow): Promise<boolean> {
  if (hold.intro === "sent") return false;
  const seller = await readHandoffMail(cluster, item.creator);
  if (!seller) return false;
  const reach = await readHandoffReach(cluster, item.title, owner);
  const card = reach ? readBuyerCard(reach.body) : null;
  const buyer = await readHandoffMail(cluster, owner);
  if (!card && !buyer) return false;
  const pending = (await readOpenHandoffNotes(cluster, item.title)).filter((note) => note.wallet === owner);
  const message = pending.map((note) => note.body).join("\n\n");
  const detail = card
    ? [...cardLines(card, message), `Sale page: ${saleUrl(item.title, cluster)}`]
    : [
        "The buyer subscribed to purchase email from the PAR platform.",
        "You can write a note on the sale page. PAR sends it only to the buyer.",
        `Sale page: ${saleUrl(item.title, cluster)}`,
      ];
  const result = await sendAbout(seller, "sale", objectName(item.name), card ? "The buyer left contact" : "The buyer can receive notes", detail);
  if (result === "sent") {
    await markHandoffIntro(cluster, item.title, owner, "sent");
    if (card) for (const note of pending) await markHandoffNote(note.id, "sent");
  }
  return result === "retry";
}

async function deliverNotes(cluster: ClusterName, item: IndexedTitle, owner: string): Promise<boolean> {
  const notes = await readOpenHandoffNotes(cluster, item.title);
  let retry = false;
  for (const note of notes) {
    const fromSeller = note.wallet === item.creator;
    if (!fromSeller && note.wallet !== owner) {
      await markHandoffNote(note.id, "skip");
      continue;
    }
    const to = fromSeller ? await readHandoffMail(cluster, owner) : await readHandoffMail(cluster, item.creator);
    if (!to) {
      if (note.mail !== "wait") await markHandoffNote(note.id, "wait");
      continue;
    }
    const result = await sendAbout(
      to,
      fromSeller ? "purchase" : "sale",
      objectName(item.name),
      fromSeller ? "A note from the seller" : "A note from the buyer",
      fromSeller
        ? ["The seller wrote this on the sale page:", note.body, "Answer on the sale page. PAR sends your answer only to the seller.", `Sale page: ${saleUrl(item.title, cluster)}`]
        : ["The buyer wrote this on the sale page:", note.body, "Answer on the sale page. PAR sends your answer only to the buyer.", `Sale page: ${saleUrl(item.title, cluster)}`],
    );
    if (result === "sent") await markHandoffNote(note.id, "sent");
    else if (result === "retry") retry = true;
  }
  return retry;
}

function published(place: HandoffPlace, days: number | null, hold: HoldRow | null): HandoffPublic {
  const heldAt = place === "held" ? hold?.held_at ?? null : null;
  const left = daysLeft(heldAt, days);
  return { indexed: true, place, handoffDays: days, heldAt, daysLeft: left };
}

/** Reads the owner from the chain and records a new holder once. Mail is one notice per holder. */
export async function noteHolder(cluster: ClusterName, title: string): Promise<{ view: HandoffPublic; retry: boolean } | null> {
  if (!hasIndex() || !ADDRESS.test(title)) return null;
  const item = await readItemByTitle(cluster, title);
  if (!item) return { view: { indexed: false, place: "none", handoffDays: null, heldAt: null, daysLeft: null }, retry: false };
  const chain = await readTitle(serverRpcUrl(cluster), title);
  const owner = chain.exists ? chain.owner : "";
  const place = placeOf(owner, item.creator, title, cluster);
  const days = handoffDaysOf(item.sheet);
  if (place !== "held" && place !== "wallet") {
    await closeQuiet(cluster, title, owner, false, false);
    return { view: published(place, days, null), retry: false };
  }

  if (place === "wallet") {
    const prior = await readAnyOtherHold(cluster, title, owner);
    let hold = await readHandoffHold(cluster, title, owner);
    let retry = false;
    if (prior && !hold) {
      const change = await latestChange(cluster, title);
      await insertHandoffHold({ cluster, title, owner, signature: change.signature || null, held_at: change.at, mail: "pending" });
      hold = await readHandoffHold(cluster, title, owner);
    }
    if (hold?.mail === "wait" && (await readHandoffMail(cluster, item.creator))) {
      await markHandoffMail(cluster, title, owner, "pending");
      hold = await readHandoffHold(cluster, title, owner);
    }
    if (hold?.mail === "pending") retry = (await tryMail(cluster, item, owner, "home")) === "retry";
    await closeQuiet(cluster, title, owner, false, true);
    return { view: published(place, days, await readHandoffHold(cluster, title, owner)), retry };
  }

  await deleteHandoffHold(cluster, title, item.creator);
  let hold = await readHandoffHold(cluster, title, owner);
  if (!hold) {
    const change = await latestChange(cluster, title);
    await insertHandoffHold({ cluster, title, owner, signature: change.signature || null, held_at: change.at, mail: "pending" });
    hold = await readHandoffHold(cluster, title, owner);
  }
  let retry = false;
  if (hold?.mail === "wait" && (await readHandoffMail(cluster, item.creator))) {
    await markHandoffMail(cluster, title, owner, "pending");
    hold = await readHandoffHold(cluster, title, owner);
  }
  if (hold?.mail === "pending") retry = (await tryMail(cluster, item, owner, "held")) === "retry";
  hold = (await readHandoffHold(cluster, title, owner)) ?? hold;
  if (hold?.nudge === "skip" && !reminderDue(hold.held_at, days)) {
    await markHandoffNudge(cluster, title, owner, "open");
    hold = { ...hold, nudge: "open" };
  }
  await closeQuiet(cluster, title, owner, true, false);
  if (hold) {
    if (await remindSeller(cluster, item, owner, hold, days)) retry = true;
    hold = (await readHandoffHold(cluster, title, owner)) ?? hold;
    if (await introduceBuyer(cluster, item, owner, hold)) retry = true;
  }
  if (await deliverNotes(cluster, item, owner)) retry = true;
  return { view: published(place, days, await readHandoffHold(cluster, title, owner)), retry };
}

/** Sends the seller reminder for titles whose handoff clock is close, even if nobody has the page open. */
export async function remindOpenHolds(cluster: ClusterName): Promise<{ checked: number; retry: boolean }> {
  if (!hasIndex()) return { checked: 0, retry: false };
  const titles = await listNudgeTitles(cluster);
  const seen = new Set<string>();
  let retry = false;
  for (const title of titles) {
    if (seen.has(title)) continue;
    seen.add(title);
    const noted = await noteHolder(cluster, title).catch(() => null);
    if (noted?.retry) retry = true;
  }
  return { checked: seen.size, retry };
}

/** One Helius webhook per network. Its address list is the indexed titles, refreshed at most every ten minutes. */
export async function syncHeliusHook(cluster: ClusterName): Promise<void> {
  const key = heliusKey(cluster);
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!key || !secret || !hasIndex()) return;
  const existing = await readHeliusHook(cluster);
  if (existing && Date.now() - Date.parse(existing.updated_at) < HOOK_REFRESH_MS) return;
  const addresses = (await listTitleAddresses(cluster)).filter((title) => ADDRESS.test(title));
  if (!addresses.length) return;
  const body = {
    webhookURL: `${PUBLIC_ORIGIN}/api/helius/handoff?c=${cluster === "devnet" ? "devnet" : "mainnet"}`,
    webhookType: "enhanced",
    accountAddresses: addresses,
    transactionTypes: ["ANY"],
    txnStatus: "success",
    authHeader: `Bearer ${secret}`,
  };
  const base = "https://api.helius.xyz/v0/webhooks";
  const putExisting = async (hookId: string) =>
    fetch(`${base}/${hookId}?api-key=${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  if (existing) {
    const put = await putExisting(existing.hook_id);
    if (put.ok) {
      await writeHeliusHook(cluster, existing.hook_id);
      return;
    }
    if (put.status !== 404) return;
  }
  const created = await fetch(`${base}?api-key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!created.ok) return;
  const payload = (await created.json()) as { webhookID?: string; webhookId?: string };
  const hookId = payload.webhookID || payload.webhookId;
  if (hookId) await writeHeliusHook(cluster, hookId);
}

export function accountsInPayload(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || found.size > 40) return;
    if (typeof node === "string") {
      if (ADDRESS.test(node)) found.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return [...found];
}

export async function titlesInPayload(cluster: ClusterName, payload: unknown): Promise<string[]> {
  const accounts = accountsInPayload(payload);
  if (!accounts.length || !hasIndex()) return [];
  const rows = await readItemsByTitles(cluster, accounts);
  return rows.map((row) => row.title);
}
