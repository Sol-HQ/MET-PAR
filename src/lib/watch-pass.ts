export type WatchPass = {
  ok: boolean;
  note: string;
  watched: number;
  marked: number;
  settled: number;
};

export async function watchOnce(): Promise<WatchPass> {
  const mod = (await import("../../scripts/escrow-watch.mjs")) as { watchOnce: () => Promise<WatchPass> };
  return mod.watchOnce();
}
