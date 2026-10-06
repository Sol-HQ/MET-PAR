import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { JITO_TIP_ACCOUNTS } from "@/lib/send";

const JITO_TRANSACTIONS = "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true";
const TIP_ACCOUNTS = new Set<string>(JITO_TIP_ACCOUNTS);

function carriesTip(encoded: string): boolean {
  try {
    const transaction = Transaction.from(Buffer.from(encoded, "base64"));
    return transaction.instructions.some((instruction) => {
      if (!instruction.programId.equals(SystemProgram.programId)) return false;
      if (instruction.data.length < 12 || instruction.data[0] !== 2) return false;
      const destination = instruction.keys[1]?.pubkey;
      return destination instanceof PublicKey && TIP_ACCOUNTS.has(destination.toBase58());
    });
  } catch {
    return false;
  }
}

/** Relays one already-signed mainnet transaction to Jito. The browser cannot call the block engine directly. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { transaction?: string } | null;
  const transaction = body?.transaction || "";
  if (transaction.length < 80 || transaction.length > 4_000 || !carriesTip(transaction)) {
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
