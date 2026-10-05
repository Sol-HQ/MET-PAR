import { put } from "@vercel/blob";
import { randomBytes } from "node:crypto";

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      { error: "Image upload is not configured yet. Paste an https image link instead." },
      { status: 503 },
    );
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length < 32 || bytes.length > 1_500_000) {
    return Response.json({ error: "Use an image under 1.5 MB." }, { status: 400 });
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return Response.json({ error: "Upload a JPEG, PNG, WebP, or GIF. The page converts it before sending." }, { status: 400 });
  }
  const id = randomBytes(6).toString("hex");
  await put(`t/${id}.jpg`, bytes, {
    access: "public",
    contentType: "image/jpeg",
    addRandomSuffix: false,
  });
  const origin = new URL(request.url).origin;
  const host = new URL(origin).hostname;
  const base = host === "localhost" || host === "127.0.0.1" ? "https://metpar-ten.vercel.app" : origin;
  return Response.json(
    { url: `${base}/i/${id}` },
    { headers: { "cache-control": "no-store" } },
  );
}
