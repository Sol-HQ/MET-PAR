import type { ClusterName } from "./constants";
import type { TitleRail } from "./title";

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

export type PoolRow = { cluster: ClusterName; pool: string; config: string };

export async function savePool(row: PoolRow): Promise<void> {
  await rest("pools?on_conflict=cluster,pool", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify(row),
  });
}

export async function listPools(cluster: ClusterName | null, limit = 500): Promise<PoolRow[]> {
  const where = cluster ? `&cluster=eq.${encodeURIComponent(cluster)}` : "";
  const response = await rest(`pools?select=cluster,pool,config&hidden=eq.false${where}&order=created_at.desc&limit=${limit}`);
  return (await response.json()) as PoolRow[];
}
