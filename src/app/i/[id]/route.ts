import { head } from "@vercel/blob";
import { readFile } from "fs/promises";
import path from "path";
import { readPicture } from "@/lib/store";

const PICTURE_HEADERS = {
  "content-type": "image/jpeg",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=31536000, immutable",
} as const;

/** Example Devnet cards keep a solid copy in the repo so they never depend on Blob or Arweave. */
async function readBundledPicture(id: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path.join(process.cwd(), "public", "devnet", `${id}.jpg`)));
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{12}$/.test(id)) return new Response("Not found", { status: 404 });
  const stored = await readPicture(id).catch(() => null);
  if (stored) {
    return new Response(new Blob([new Uint8Array(stored)], { type: "image/jpeg" }), { headers: PICTURE_HEADERS });
  }
  const bundled = await readBundledPicture(id);
  if (bundled) {
    return new Response(new Blob([bundled], { type: "image/jpeg" }), { headers: PICTURE_HEADERS });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return new Response("Not found", { status: 404 });
  try {
    const meta = await head(`t/${id}.jpg`);
    const file = await fetch(meta.url);
    if (!file.ok || !file.body) return new Response("Not found", { status: 404 });
    return new Response(file.body, {
      headers: {
        "content-type": meta.contentType || "image/jpeg",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
