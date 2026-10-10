import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { isAdminWallet } from "@/lib/admins";
import type { ClusterName } from "@/lib/constants";
import { hasIndex, listCoins, listItems, readWatcher } from "@/lib/store";
import { watchOnce } from "@/lib/watch-pass";

function clusterOf(value: string | null): ClusterName | null {
  return value === "devnet" || value === "mainnet-beta" ? value : null;
}

/** The status page is public. A failed pass must not carry a URL or a key into that response. */
function publicWatcherNote(note: string): string {
  return note
    .replace(/https?:\/\/\S+/gi, "a network address")
    .replace(/api-key[=:][^\s&]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 180);
}

export async function GET(request: Request) {
  const cluster = clusterOf(new URL(request.url).searchParams.get("cluster"));
  if (!cluster) return Response.json({ error: "That network is not a PAR cluster." }, { status: 400 });
  if (!hasIndex()) {
    return Response.json({
      index: false,
      objects: [],
      coins: [],
      watcher: null,
    });
  }
  const [objects, coins, watcher] = await Promise.all([
    listItems(cluster),
    listCoins(cluster),
    readWatcher(),
  ]);
  return Response.json(
    {
      index: true,
      objects,
      coins,
      watcher: watcher ? { ...watcher, note: publicWatcherNote(watcher.note) } : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    publicKey?: string;
    signature?: string;
    issuedAt?: number;
    cluster?: string;
  } | null;
  const cluster = clusterOf(body?.cluster || null);
  if (!cluster) return Response.json({ error: "That network is not a PAR cluster." }, { status: 400 });
  if (!body?.publicKey || !isAdminWallet(body.publicKey)) {
    return Response.json({ error: "This wallet cannot wake the watcher." }, { status: 403 });
  }
  const issuedAt = Number(body.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60 * 1000) {
    return Response.json({ error: "The admin signature expired. Sign it again." }, { status: 400 });
  }
  if (cluster !== "devnet") {
    return Response.json({ error: "The watcher runs on the practice network." }, { status: 400 });
  }
  const message = ["PAR watcher pass", `cluster=${cluster}`, `issuedAt=${issuedAt}`].join("\n");
  let signature: Uint8Array;
  try {
    signature = Buffer.from(body.signature || "", "base64");
  } catch {
    return Response.json({ error: "The admin signature could not be read." }, { status: 400 });
  }
  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    signature,
    new PublicKey(body.publicKey).toBytes(),
  );
  if (!verified) return Response.json({ error: "The admin signature does not match." }, { status: 403 });
  try {
    const result = await watchOnce();
    return Response.json(result);
  } catch (error) {
    const note = error instanceof Error ? error.message : "The pass failed.";
    return Response.json({ error: note }, { status: 500 });
  }
}
