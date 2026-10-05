import { head } from "@vercel/blob";
import { readPicture } from "@/lib/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{12}$/.test(id)) return new Response("Not found", { status: 404 });
  const stored = await readPicture(id).catch(() => null);
  if (stored) {
    return new Response(Buffer.from(stored), {
      headers: {
        "content-type": "image/jpeg",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
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
