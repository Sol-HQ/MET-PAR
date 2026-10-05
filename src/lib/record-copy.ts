import { head, put } from "@vercel/blob";
import type { ClusterName } from "./constants";
import { hasIndex, readItemSheet } from "./store";

function pathFor(cluster: ClusterName, asset: string): string {
  return `records/${cluster}/${asset}.json`;
}

async function readBlobCopy(cluster: ClusterName, asset: string): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const found = await head(pathFor(cluster, asset));
    const response = await fetch(found.url, { cache: "no-store" });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/** PAR's copy of a sheet. Written once, after its hash matched the record on chain. */
export async function readCopy(cluster: ClusterName, asset: string): Promise<string | null> {
  if (hasIndex()) {
    const indexed = await readItemSheet(cluster, asset).catch(() => null);
    if (indexed) return indexed;
  }
  return readBlobCopy(cluster, asset);
}

export async function writeCopy(cluster: ClusterName, asset: string, sheet: string): Promise<void> {
  await put(pathFor(cluster, asset), sheet, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });
}
