declare module "../../scripts/escrow-watch.mjs" {
  export function watchOnce(): Promise<{
    ok: boolean;
    note: string;
    watched: number;
    marked: number;
    settled: number;
  }>;
}
