import { transactionCarriesJitoTip } from "@/lib/send";

const JITO_TRANSACTIONS = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
const JITO_BUNDLES = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

function decodeRaw(transaction: string): Uint8Array | null {
  try {
    const raw = Uint8Array.from(Buffer.from(transaction, "base64"));
    return raw.length >= 80 && transaction.length <= 4_000 ? raw : null;
  } catch {
    return null;
  }
}

/** Relays one signed mainnet transaction, or a signed bundle, to Jito. The browser cannot call the block engine directly. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { transaction?: string; transactions?: string[] } | null;
  const listed = Array.isArray(body?.transactions) ? body.transactions.filter((item) => typeof item === "string") : [];
  const single = typeof body?.transaction === "string" ? body.transaction : "";
  const encoded = listed.length > 0 ? listed : single ? [single] : [];
  const raws = encoded.map(decodeRaw);
  if (raws.some((raw) => !raw) || encoded.length === 0 || encoded.length > 5) {
    return Response.json({ error: "Send the signed transaction." }, { status: 400 });
  }
  if (!raws.some((raw) => raw && transactionCarriesJitoTip(raw))) {
    return Response.json({ error: "Send the signed transaction." }, { status: 400 });
  }

  if (encoded.length === 1) {
    const response = await fetch(JITO_TRANSACTIONS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [encoded[0], { encoding: "base64" }],
      }),
    });
    const payload = (await response.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
    if (typeof payload?.result !== "string") {
      return Response.json({ error: payload?.error?.message || "Jito did not take the transaction." }, { status: 502 });
    }
    return Response.json({ signature: payload.result });
  }

  const response = await fetch(JITO_BUNDLES, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [encoded, { encoding: "base64" }],
    }),
  });
  const payload = (await response.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (typeof payload?.result !== "string") {
    return Response.json({ error: payload?.error?.message || "Jito did not take the bundle." }, { status: 502 });
  }
  return Response.json({ bundle: payload.result });
}
