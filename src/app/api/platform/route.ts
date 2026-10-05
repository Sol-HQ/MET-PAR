import { head, put } from "@vercel/blob";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { isAdminWallet, PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { hasIndex, readPlatformRow, writePlatformRow } from "@/lib/store";
import {
  assertPlatformFeePercent,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_PLATFORM_SETTINGS,
  settingsMessage,
  type PlatformSettings,
} from "@/lib/platform";

const PATH = "platform/settings.json";

function clean(value: unknown): PlatformSettings {
  const raw = value && typeof value === "object" ? (value as Partial<PlatformSettings> & { platformSharePercent?: number }) : {};
  const openingFeeBps = Number(raw.openingFeeBps);
  const platformFeeBps = Number(raw.platformFeeBps);
  const platformFeePercent = Number.isInteger(raw.platformFeePercent)
    ? Number(raw.platformFeePercent)
    : DEFAULT_PLATFORM_FEE_PERCENT;
  try {
    assertPlatformFeePercent(platformFeePercent);
  } catch {
    return DEFAULT_PLATFORM_SETTINGS;
  }
  return {
    openingFeeBps: Number.isFinite(openingFeeBps) ? openingFeeBps : DEFAULT_PLATFORM_SETTINGS.openingFeeBps,
    platformFeeBps: Number.isFinite(platformFeeBps) ? platformFeeBps : DEFAULT_PLATFORM_SETTINGS.platformFeeBps,
    platformFeePercent,
    feeClaimer: PLATFORM_FEE_CLAIMER,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "",
  };
}

async function readBlobSettings(): Promise<PlatformSettings> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return DEFAULT_PLATFORM_SETTINGS;
  try {
    const meta = await head(PATH);
    const response = await fetch(meta.url, { cache: "no-store" });
    if (!response.ok) return DEFAULT_PLATFORM_SETTINGS;
    return clean(await response.json());
  } catch {
    return DEFAULT_PLATFORM_SETTINGS;
  }
}

async function readSettings(): Promise<PlatformSettings> {
  if (!hasIndex()) return readBlobSettings();
  const stored = await readPlatformRow().catch(() => null);
  if (stored) return clean(stored);
  const older = await readBlobSettings();
  if (older.updatedAt) await writePlatformRow(older).catch(() => undefined);
  return older;
}

export async function GET() {
  const settings = await readSettings();
  return Response.json(settings, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    publicKey?: string;
    signature?: string;
    issuedAt?: number;
    platformFeePercent?: number;
  };
  if (!body.publicKey || !isAdminWallet(body.publicKey)) {
    return Response.json({ error: "This wallet cannot change platform settings." }, { status: 403 });
  }
  const issuedAt = Number(body.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60 * 1000) {
    return Response.json({ error: "The admin signature expired. Sign it again." }, { status: 400 });
  }
  const platformFeePercent = Number(body.platformFeePercent);
  try {
    assertPlatformFeePercent(platformFeePercent);
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : "That platform fee is not allowed." },
      { status: 400 },
    );
  }
  const current = await readSettings();
  const openingFeeBps = current.openingFeeBps;
  const platformFeeBps = current.platformFeeBps;
  const message = settingsMessage({
    openingFeeBps,
    platformFeeBps,
    platformFeePercent,
    issuedAt,
  });
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
  if (!verified) {
    return Response.json({ error: "The admin signature does not match these settings." }, { status: 403 });
  }
  const settings: PlatformSettings = {
    openingFeeBps,
    platformFeeBps,
    platformFeePercent,
    feeClaimer: PLATFORM_FEE_CLAIMER,
    updatedAt: new Date(issuedAt).toISOString(),
    updatedBy: body.publicKey,
  };
  if (hasIndex()) {
    await writePlatformRow(settings);
    return Response.json(settings);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ error: "Platform storage is not configured." }, { status: 503 });
  }
  await put(PATH, JSON.stringify(settings), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  return Response.json(settings);
}
