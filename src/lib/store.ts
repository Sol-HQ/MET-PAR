import type { ClusterName } from "./constants";
import type { PlatformSettings } from "./platform";
import type { TitleRail } from "./title";

const PICTURE_BUCKET = "par-pictures";

/** Server only. With Supabase set, PAR's index lives there; without it, sheets fall back to Vercel Blob. */
function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

export function hasIndex(): boolean {
  return supabase() !== null;
}

async function rest(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
  const db = supabase();
  if (!db) throw new Error("The PAR index is not configured.");
  const headers: Record<string, string> = {
    apikey: db.key,
    authorization: `Bearer ${db.key}`,
    "content-type": "application/json",
  };
  if (init.prefer) headers.prefer = init.prefer;
  const response = await fetch(`${db.url}/rest/v1/${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) throw new Error(`The PAR index answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response;
}

export type ItemRow = {
  cluster: ClusterName;
  record: string;
  title: string;
  mint: string;
  pool: string;
  config: string;
  creator: string;
  vault: string;
  rail: TitleRail;
  listing: string | null;
  name: string;
  symbol: string;
  quote: string;
  sheet_uri: string;
  sheet_sha256: string;
  image_sha256: string;
  sale_delay_days: number;
  burn_percent: number;
  /** The exact bytes that hash to sheet_sha256. Kept as text because jsonb reorders keys. */
  sheet: string;
};

/** Written once per record. A second write for the same record is ignored, so facts never drift. */
export async function saveItem(item: ItemRow, signatures: { record?: string; title?: string; deposit?: string }) {
  await rest("items?on_conflict=cluster,record", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify(item),
  });
  const events = (["record", "title", "deposit"] as const)
    .filter((kind) => signatures[kind])
    .map((kind) => ({ cluster: item.cluster, record: item.record, kind, signature: signatures[kind] }));
  if (events.length) {
    await rest("events?on_conflict=cluster,kind,signature", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify(events),
    });
  }
}

export async function readItemSheet(cluster: ClusterName, record: string): Promise<string | null> {
  const response = await rest(
    `items?select=sheet&cluster=eq.${encodeURIComponent(cluster)}&record=eq.${encodeURIComponent(record)}&limit=1`,
  );
  const rows = (await response.json()) as { sheet: string }[];
  return rows[0]?.sheet ?? null;
}

export async function hasItem(cluster: ClusterName, record: string): Promise<boolean> {
  const response = await rest(
    `items?select=record&cluster=eq.${encodeURIComponent(cluster)}&record=eq.${encodeURIComponent(record)}&limit=1`,
  );
  return ((await response.json()) as unknown[]).length > 0;
}

export type PoolRow = {
  cluster: ClusterName;
  pool: string;
  config: string;
  creator?: string | null;
  mint?: string | null;
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
};

export async function savePool(row: PoolRow): Promise<void> {
  await rest("pools?on_conflict=cluster,pool", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(row),
  });
}

export async function listPools(cluster: ClusterName | null, limit = 500): Promise<PoolRow[]> {
  const where = cluster ? `&cluster=eq.${encodeURIComponent(cluster)}` : "";
  const response = await rest(
    `pools?select=cluster,pool,config,creator,mint,name,symbol&hidden=eq.false${where}&order=created_at.desc&limit=${limit}`,
  );
  return (await response.json()) as PoolRow[];
}

export type ItemSummary = {
  cluster: ClusterName;
  record: string;
  title: string;
  mint: string;
  pool: string;
  creator: string;
  name: string;
  symbol: string;
  rail: TitleRail;
  status: string;
  created_at: string;
};

export async function listItems(cluster: ClusterName, limit = 100): Promise<ItemSummary[]> {
  const response = await rest(
    `items?select=cluster,record,title,mint,pool,creator,name,symbol,rail,status,created_at&cluster=eq.${encodeURIComponent(cluster)}&order=created_at.desc&limit=${limit}`,
  );
  return (await response.json()) as ItemSummary[];
}

export type CoinSummary = PoolRow & { created_at?: string };

export async function listCoins(cluster: ClusterName, limit = 100): Promise<CoinSummary[]> {
  const response = await rest(
    `pools?select=cluster,pool,config,creator,mint,name,symbol,uri,created_at&hidden=eq.false&cluster=eq.${encodeURIComponent(cluster)}&order=created_at.desc&limit=${limit}`,
  );
  return (await response.json()) as CoinSummary[];
}

export async function readPlatformRow(): Promise<PlatformSettings | null> {
  const response = await rest("settings?select=body&id=eq.platform&limit=1");
  const rows = (await response.json()) as { body: PlatformSettings }[];
  return rows[0]?.body ?? null;
}

export async function writePlatformRow(settings: PlatformSettings): Promise<void> {
  await rest("settings?on_conflict=id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ id: "platform", body: settings, updated_at: new Date().toISOString() }),
  });
}

export async function countRecentPictures(wallet: string, sinceIso: string): Promise<number> {
  const response = await rest(
    `pictures?select=id&wallet=eq.${encodeURIComponent(wallet)}&created_at=gte.${encodeURIComponent(sinceIso)}`,
  );
  return ((await response.json()) as unknown[]).length;
}

export async function savePicture(id: string, bytes: Uint8Array, wallet: string, sha256: string): Promise<void> {
  const db = supabase();
  if (!db) throw new Error("Picture storage is not configured.");
  const response = await fetch(`${db.url}/storage/v1/object/${PICTURE_BUCKET}/t/${id}.jpg`, {
    method: "POST",
    headers: {
      apikey: db.key,
      authorization: `Bearer ${db.key}`,
      "content-type": "image/jpeg",
      "x-upsert": "true",
    },
    body: new Blob([bytes.slice()], { type: "image/jpeg" }),
  });
  if (!response.ok) throw new Error(`The picture store answered ${response.status}.`);
  await rest("pictures?on_conflict=id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ id, wallet, sha256, bytes: bytes.byteLength }),
  });
}

export async function readPicture(id: string): Promise<Uint8Array | null> {
  const db = supabase();
  if (!db) return null;
  const response = await fetch(`${db.url}/storage/v1/object/${PICTURE_BUCKET}/t/${id}.jpg`, {
    headers: { apikey: db.key, authorization: `Bearer ${db.key}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

export type WatcherBeat = {
  name: string;
  cluster: ClusterName;
  last_at: string | null;
  ok: boolean;
  note: string;
  watched: number;
  marked: number;
  settled: number;
  wake_at: string | null;
};

export async function readWatcher(): Promise<WatcherBeat | null> {
  const response = await rest(
    "jobs?select=name,cluster,last_at,ok,note,watched,marked,settled,wake_at&name=eq.escrow-watch&limit=1",
  );
  const rows = (await response.json()) as WatcherBeat[];
  return rows[0] ?? null;
}

export async function writeWatcher(beat: WatcherBeat): Promise<void> {
  await rest("jobs?on_conflict=name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(beat),
  });
}

export async function wakeWatcher(cluster: ClusterName): Promise<void> {
  await rest("jobs?on_conflict=name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ name: "escrow-watch", cluster, wake_at: new Date().toISOString() }),
  });
}

export type IndexedTitle = {
  cluster: ClusterName;
  record: string;
  title: string;
  creator: string;
  name: string;
  sheet: string;
};

export async function readItemsByTitles(cluster: ClusterName, titles: string[]): Promise<IndexedTitle[]> {
  if (!titles.length) return [];
  const list = titles.slice(0, 40).map((title) => encodeURIComponent(title)).join(",");
  const response = await rest(
    `items?select=cluster,record,title,creator,name,sheet&cluster=eq.${encodeURIComponent(cluster)}&title=in.(${list})&limit=40`,
  );
  return (await response.json()) as IndexedTitle[];
}

export async function readItemByTitle(cluster: ClusterName, title: string): Promise<IndexedTitle | null> {
  const response = await rest(
    `items?select=cluster,record,title,creator,name,sheet&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&limit=1`,
  );
  const rows = (await response.json()) as IndexedTitle[];
  return rows[0] ?? null;
}

export async function listTitleAddresses(cluster: ClusterName): Promise<string[]> {
  const response = await rest(
    `items?select=title&cluster=eq.${encodeURIComponent(cluster)}&order=created_at.desc&limit=1000`,
  );
  return ((await response.json()) as { title: string }[]).map((row) => row.title);
}

export async function readHandoffMail(cluster: ClusterName, wallet: string): Promise<string | null> {
  const response = await rest(
    `handoff_mail?select=email&cluster=eq.${encodeURIComponent(cluster)}&wallet=eq.${encodeURIComponent(wallet)}&limit=1`,
  );
  const rows = (await response.json()) as { email: string }[];
  return rows[0]?.email ?? null;
}

export async function writeHandoffMail(cluster: ClusterName, wallet: string, email: string): Promise<void> {
  await rest("handoff_mail?on_conflict=cluster,wallet", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ cluster, wallet, email, updated_at: new Date().toISOString() }),
  });
}

export async function readHandoffReach(cluster: ClusterName, title: string, wallet: string): Promise<{ body: string; updated_at: string } | null> {
  const response = await rest(
    `handoff_reach?select=body,updated_at&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&wallet=eq.${encodeURIComponent(wallet)}&limit=1`,
  );
  const rows = (await response.json()) as { body: string; updated_at: string }[];
  return rows[0] ?? null;
}

export async function writeHandoffReach(cluster: ClusterName, title: string, wallet: string, body: string): Promise<void> {
  await rest("handoff_reach?on_conflict=cluster,title,wallet", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ cluster, title, wallet, body, updated_at: new Date().toISOString() }),
  });
}

export async function clearHandoffReach(cluster: ClusterName, title: string, wallet: string): Promise<void> {
  await rest(
    `handoff_reach?cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&wallet=eq.${encodeURIComponent(wallet)}`,
    { method: "DELETE" },
  );
}

export async function deleteHandoffMail(cluster: ClusterName, wallet: string): Promise<void> {
  await rest(
    `handoff_mail?cluster=eq.${encodeURIComponent(cluster)}&wallet=eq.${encodeURIComponent(wallet)}`,
    { method: "DELETE" },
  );
}

export type HoldRow = {
  owner: string;
  signature: string | null;
  held_at: string | null;
  mail: "pending" | "sent" | "skip" | "wait";
  nudge: "open" | "sent" | "wait" | "skip";
  intro: "open" | "sent";
};

export async function readHandoffHold(cluster: ClusterName, title: string, owner: string): Promise<HoldRow | null> {
  const response = await rest(
    `handoff_hold?select=owner,signature,held_at,mail,nudge,intro&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=eq.${encodeURIComponent(owner)}&limit=1`,
  );
  const rows = (await response.json()) as HoldRow[];
  return rows[0] ?? null;
}

export async function listHandoffHolds(cluster: ClusterName, title: string): Promise<HoldRow[]> {
  const response = await rest(
    `handoff_hold?select=owner,signature,held_at,mail,nudge,intro&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&limit=10`,
  );
  return (await response.json()) as HoldRow[];
}

export async function listNudgeTitles(cluster: ClusterName): Promise<string[]> {
  const response = await rest(
    `handoff_hold?select=title&cluster=eq.${encodeURIComponent(cluster)}&nudge=in.(open,wait)&held_at=not.is.null&order=held_at.asc&limit=8`,
  );
  return ((await response.json()) as { title: string }[]).map((row) => row.title);
}

export async function readAnyOtherHold(cluster: ClusterName, title: string, owner: string): Promise<boolean> {
  const response = await rest(
    `handoff_hold?select=owner&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=neq.${encodeURIComponent(owner)}&limit=1`,
  );
  return ((await response.json()) as unknown[]).length > 0;
}

export async function insertHandoffHold(row: {
  cluster: ClusterName;
  title: string;
  owner: string;
  signature: string | null;
  held_at: string | null;
  mail: "pending" | "sent" | "skip" | "wait";
}): Promise<void> {
  await rest("handoff_hold?on_conflict=cluster,title,owner", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify(row),
  });
}

export async function markHandoffMail(cluster: ClusterName, title: string, owner: string, mail: "pending" | "sent" | "skip" | "wait"): Promise<void> {
  await rest(
    `handoff_hold?cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=eq.${encodeURIComponent(owner)}`,
    { method: "PATCH", body: JSON.stringify({ mail }) },
  );
}

export async function markHandoffNudge(cluster: ClusterName, title: string, owner: string, nudge: "open" | "sent" | "wait" | "skip"): Promise<void> {
  await rest(
    `handoff_hold?cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=eq.${encodeURIComponent(owner)}`,
    { method: "PATCH", body: JSON.stringify({ nudge }) },
  );
}

export async function markHandoffIntro(cluster: ClusterName, title: string, owner: string, intro: "open" | "sent"): Promise<void> {
  await rest(
    `handoff_hold?cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=eq.${encodeURIComponent(owner)}`,
    { method: "PATCH", body: JSON.stringify({ intro }) },
  );
}

export type NoteRow = {
  id: number;
  wallet: string;
  body: string;
  signature: string;
  mail: "pending" | "sent" | "wait" | "skip";
  created_at: string;
};

export async function insertHandoffNote(row: {
  cluster: ClusterName;
  title: string;
  wallet: string;
  body: string;
  signature: string;
}): Promise<void> {
  await rest("handoff_note", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({ ...row, mail: "pending" }),
  });
}

export async function readHandoffNoteBySignature(cluster: ClusterName, signature: string): Promise<NoteRow | null> {
  const response = await rest(
    `handoff_note?select=id,wallet,body,signature,mail,created_at&cluster=eq.${encodeURIComponent(cluster)}&signature=eq.${encodeURIComponent(signature)}&limit=1`,
  );
  const rows = (await response.json()) as NoteRow[];
  return rows[0] ?? null;
}

export async function latestHandoffNote(cluster: ClusterName, title: string, wallet: string): Promise<NoteRow | null> {
  const response = await rest(
    `handoff_note?select=id,wallet,body,signature,mail,created_at&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&wallet=eq.${encodeURIComponent(wallet)}&order=created_at.desc&limit=1`,
  );
  const rows = (await response.json()) as NoteRow[];
  return rows[0] ?? null;
}

export async function readOpenHandoffNotes(cluster: ClusterName, title: string): Promise<NoteRow[]> {
  const response = await rest(
    `handoff_note?select=id,wallet,body,signature,mail,created_at&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&mail=in.(pending,wait)&order=created_at.asc&limit=20`,
  );
  return (await response.json()) as NoteRow[];
}

export async function readHandoffThread(cluster: ClusterName, title: string, wallets: string[]): Promise<NoteRow[]> {
  if (!wallets.length) return [];
  const list = wallets.map((wallet) => encodeURIComponent(wallet)).join(",");
  const response = await rest(
    `handoff_note?select=id,wallet,body,signature,mail,created_at&cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&wallet=in.(${list})&mail=neq.skip&order=created_at.desc&limit=12`,
  );
  return (await response.json()) as NoteRow[];
}

export async function markHandoffNote(id: number, mail: "pending" | "sent" | "wait" | "skip"): Promise<void> {
  await rest(`handoff_note?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ mail }) });
}

export async function deleteHandoffHold(cluster: ClusterName, title: string, owner: string): Promise<void> {
  await rest(
    `handoff_hold?cluster=eq.${encodeURIComponent(cluster)}&title=eq.${encodeURIComponent(title)}&owner=eq.${encodeURIComponent(owner)}`,
    { method: "DELETE" },
  );
}

export async function readHeliusHook(cluster: ClusterName): Promise<{ hook_id: string; updated_at: string } | null> {
  const response = await rest(
    `helius_hooks?select=hook_id,updated_at&cluster=eq.${encodeURIComponent(cluster)}&limit=1`,
  );
  const rows = (await response.json()) as { hook_id: string; updated_at: string }[];
  return rows[0] ?? null;
}

export async function writeHeliusHook(cluster: ClusterName, hookId: string): Promise<void> {
  await rest("helius_hooks?on_conflict=cluster", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ cluster, hook_id: hookId, updated_at: new Date().toISOString() }),
  });
}
