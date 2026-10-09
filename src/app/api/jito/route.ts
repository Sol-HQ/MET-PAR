import { transactionCarriesJitoTip } from "@/lib/send";

const JITO_TRANSACTIONS = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";

/** Relays one already-signed mainnet transaction to Jito. The browser cannot call the block engine directly. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { transaction?: string } | null;
  const transaction = body?.transaction || "";
  let raw: Uint8Array | null = null;
  try {
    raw = Uint8Array.from(Buffer.from(transaction, "base64"));
  } catch {
    raw = null;
  }
  if (!raw || transaction.length < 80 || transaction.length > 4_000 || !transactionCarriesJitoTip(raw)) {
    return Response.json({ error: "Send the signed transaction." }, { status: 400 });
  }
  const response = await fetch(JITO_TRANSACTIONS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [transaction, { encoding: "base64" }],
    }),
  });
  const payload = (await response.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (typeof payload?.result !== "string") {
    return Response.json({ error: payload?.error?.message || "Jito did not take the transaction." }, { status: 502 });
  }
  return Response.json({ signature: payload.result });
}
