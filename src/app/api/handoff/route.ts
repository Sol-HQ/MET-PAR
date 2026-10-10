import { PublicKey } from "@solana/web3.js";
import { isAdminWallet } from "@/lib/admins";
import { serverRpcUrl, type ClusterName } from "@/lib/constants";
import { handoffMessage, type HandoffPublic } from "@/lib/handoff-message";
import { acceptBuyerLeave, acceptNote, cleanReach, noteHolder, saveSubscription, syncHeliusHook, verifyHandoffSignature } from "@/lib/handoff-server";
import { readItemByTitle, readHandoffMail, readHandoffNoteBySignature, readHandoffReach, readHandoffThread, writeHandoffReach, clearHandoffReach } from "@/lib/store";
import { ESCROW_PROGRAM, listingAddress, readTitle, tensorListAddress } from "@/lib/title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FRESH_MS = 10 * 60 * 1000;
const REACH_GAP_MS = 20 * 1000;

function fail(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function clusterOf(value: string | null | undefined): ClusterName {
  return value === "devnet" ? "devnet" : "mainnet-beta";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const title = url.searchParams.get("title") || "";
  const cluster = clusterOf(url.searchParams.get("c"));
  if (!ADDRESS.test(title)) return fail("That is not a title.", 400);
  await syncHeliusHook(cluster).catch(() => undefined);
  const noted = await noteHolder(cluster, title).catch(() => null);
  if (!noted) return fail("The handoff index is not configured.", 503);
  return Response.json(noted.view, { headers: { "cache-control": "no-store" } });
}

type Body = {
  cluster?: string;
  title?: string;
  kind?: string;
  text?: string;
  wallet?: string;
  issuedAt?: number;
  signature?: string;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  const cluster = clusterOf(body?.cluster);
  const title = body?.title || "";
  const wallet = body?.wallet || "";
  const kind = body?.kind;
  const text = typeof body?.text === "string" ? body.text : "";
  const issuedAt = Number(body?.issuedAt);
  const signature = body?.signature || "";
  if (!ADDRESS.test(title) || !ADDRESS.test(wallet)) return fail("Send the title and the wallet.", 400);
  if (kind !== "mail" && kind !== "reach" && kind !== "read" && kind !== "note" && kind !== "buyer") return fail("That handoff request is not valid.", 400);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > FRESH_MS) return fail("Sign the handoff again.", 401);
  const message = handoffMessage({ kind, cluster, title, wallet, text: kind === "read" ? "" : text, issuedAt });
  if (!verifyHandoffSignature(message, signature, wallet)) return fail("The handoff signature does not match.", 403);

  const item = await readItemByTitle(cluster, title);
  if (!item) return fail("That title is not in the PAR index.", 404);
  const chain = await readTitle(serverRpcUrl(cluster), title);
  const owner = chain.exists ? chain.owner : "";
  const tensor = tensorListAddress(new PublicKey(title)).toBase58();
  const program = ESCROW_PROGRAM[cluster];
  const escrow = program ? listingAddress(new PublicKey(title), new PublicKey(program)).toBase58() : "";
  const place = !owner ? "none" : owner === tensor ? "listed" : escrow && owner === escrow ? "escrow" : owner === item.creator ? "wallet" : "held";
  const creator = wallet === item.creator;
  const holder = place === "held" && wallet === owner;
  const adminRead = !creator && !holder && isAdminWallet(wallet);
  if (kind === "buyer") {
    if (!holder) return fail("Sign in with the wallet that holds the title.", 403);
  } else if (adminRead) {
    if (kind !== "read") return fail("An admin can read this handoff. The seller and the buyer send the notes.", 403);
  } else if (!creator && !holder) return fail("This wallet is not the creator or the holder.", 403);

  let notice: "sent" | "saved" | "same" | "stopped" | "wait" | null = null;
  if (kind === "mail") {
    const saved = await saveSubscription({ cluster, item, wallet, side: creator ? "sale" : "purchase", text });
    if (saved === "bad") return fail(creator ? "Enter the sale email." : "Enter the purchase email.", 400);
    notice = saved;
    await noteHolder(cluster, title).catch(() => undefined);
  } else if (kind === "buyer") {
    const saved = await acceptBuyerLeave({ cluster, item, wallet, text, signature });
    if (saved === "bad") return fail("Enter the email the seller should use.", 400);
    if (saved === "soon") return fail("Wait a moment before saving the contact again.", 429);
    notice = saved === "same" || saved === "replay" ? "same" : "saved";
    await noteHolder(cluster, title).catch(() => undefined);
  } else if (kind === "note") {
    if (place !== "held") return fail("Notes open when a buyer holds the title.", 400);
    const saved = await acceptNote({ cluster, title, wallet, text, signature });
    if (saved === "bad") return fail("Write the note.", 400);
    if (saved === "soon") return fail("Wait a moment before sending another note.", 429);
    await noteHolder(cluster, title).catch(() => undefined);
    const row = await readHandoffNoteBySignature(cluster, signature);
    notice = row?.mail === "sent" ? "sent" : row?.mail === "wait" ? "wait" : "saved";
  } else if (kind === "reach") {
    const cleaned = cleanReach(text);
    const current = await readHandoffReach(cluster, title, wallet);
    if (current && Date.now() - Date.parse(current.updated_at) < REACH_GAP_MS) {
      return fail("Wait a moment before saving the handoff line again.", 429);
    }
    if (!cleaned) await clearHandoffReach(cluster, title, wallet);
    else await writeHandoffReach(cluster, title, wallet, cleaned);
  }

  const noted = await noteHolder(cluster, title).catch(() => null);
  const view: HandoffPublic = noted?.view ?? {
    indexed: true,
    place,
    handoffDays: null,
    heldAt: null,
    daysLeft: null,
  };
  const holderWallet = view.place === "held" ? owner : "";
  const mine = creator || holder ? await readHandoffReach(cluster, title, wallet) : null;
  const otherWallet = creator ? holderWallet : item.creator;
  const theirs = view.place === "held" && otherWallet ? await readHandoffReach(cluster, title, otherWallet) : null;
  const buyerReach = holderWallet ? await readHandoffReach(cluster, title, holderWallet) : null;
  const sellerReach = await readHandoffReach(cluster, title, item.creator);
  const otherSubscribed = Boolean(!adminRead && otherWallet && (await readHandoffMail(cluster, otherWallet)));
  const thread =
    view.place === "held" ? await readHandoffThread(cluster, title, [item.creator, owner].filter((row) => row.length > 0)) : [];
  return Response.json(
    {
      ...view,
      role: adminRead ? "admin" : creator ? "creator" : "holder",
      email: adminRead ? null : await readHandoffMail(cluster, wallet),
      sellerMail: adminRead ? await readHandoffMail(cluster, item.creator) : null,
      buyerMail: adminRead && holderWallet ? await readHandoffMail(cluster, holderWallet) : null,
      mine: mine?.body ?? "",
      mineAt: mine?.updated_at ?? null,
      theirs: theirs?.body ?? "",
      theirsAt: theirs?.updated_at ?? null,
      proofs: {
        buyer: buyerReach ? { body: buyerReach.body, at: buyerReach.updated_at } : null,
        seller: sellerReach ? { body: sellerReach.body, at: sellerReach.updated_at } : null,
      },
      otherSubscribed,
      notes: thread.reverse().map((row) => ({
        from: row.wallet === item.creator ? "seller" : "buyer",
        body: row.body,
        at: row.created_at,
      })),
      notice,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
