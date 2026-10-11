import { PAR_BLINK_ICON } from "../../../../../DIALECT.BLINK/icon";

export const dynamic = "force-static";

export async function GET() {
  return new Response(PAR_BLINK_ICON, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}