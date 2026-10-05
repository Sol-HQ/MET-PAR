/** The wallet signs this before a picture is stored. The hash is of the JPEG bytes. */
export function pictureMessage(sha256: string, issuedAt: number): string {
  return ["PAR picture", sha256, String(issuedAt)].join("\n");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function signedPictureHeaders(
  jpeg: Blob,
  wallet: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<HeadersInit> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const issuedAt = Date.now();
  const signature = await sign(new TextEncoder().encode(pictureMessage(sha256, issuedAt)));
  return {
    "content-type": "image/jpeg",
    "x-par-wallet": wallet,
    "x-par-issued": String(issuedAt),
    "x-par-signature": bytesToBase64(signature),
  };
}
