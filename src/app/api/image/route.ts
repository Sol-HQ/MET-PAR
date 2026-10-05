import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { pictureMessage } from "@/lib/picture";
import { countRecentPictures, hasIndex, savePicture } from "@/lib/store";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HOUR = 60 * 60 * 1000;
const PICTURES_PER_HOUR = 12;

export async function POST(request: Request) {
  if (!hasIndex()) {
    return Response.json({ error: "Picture storage is not configured." }, { status: 503 });
  }
  const wallet = request.headers.get("x-par-wallet") || "";
  const issuedAt = Number(request.headers.get("x-par-issued"));
  if (!ADDRESS.test(wallet) || !Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60 * 1000) {
    return Response.json({ error: "Connect a wallet and sign the picture." }, { status: 401 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length < 32 || bytes.length > 1_500_000) {
    return Response.json({ error: "Use an image under 1.5 MB." }, { status: 400 });
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return Response.json({ error: "Upload a JPEG, PNG, WebP, or GIF. The page converts it before sending." }, { status: 400 });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let signature: Uint8Array;
  try {
    signature = Buffer.from(request.headers.get("x-par-signature") || "", "base64");
  } catch {
    return Response.json({ error: "Connect a wallet and sign the picture." }, { status: 401 });
  }
  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(pictureMessage(sha256, issuedAt)),
    signature,
    new PublicKey(wallet).toBytes(),
  );
  if (!verified) {
    return Response.json({ error: "The picture signature does not match." }, { status: 403 });
  }
  const recent = await countRecentPictures(wallet, new Date(Date.now() - HOUR).toISOString());
  if (recent >= PICTURES_PER_HOUR) {
    return Response.json({ error: "That wallet has saved enough pictures for this hour." }, { status: 429 });
  }
  const id = randomBytes(6).toString("hex");
  await savePicture(id, bytes, wallet, sha256);
  const origin = new URL(request.url).origin;
  const host = new URL(origin).hostname;
  const base = host === "localhost" || host === "127.0.0.1" ? "https://metpar-ten.vercel.app" : origin;
  return Response.json({ url: `${base}/i/${id}` }, { headers: { "cache-control": "no-store" } });
}
