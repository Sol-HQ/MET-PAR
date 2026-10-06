import { USDC_MAINNET, WSOL } from "@/lib/constants";

export const dynamic = "force-dynamic";

const LITE = "https://lite-api.jup.ag/swap/v1";

type RawAccount = { pubkey: string; isSigner: boolean; isWritable: boolean };
type RawInstruction = { programId: string; accounts: RawAccount[]; data: string };

type QuoteBody = {
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  error?: string;
};

type InstructionBody = QuoteBody & {
  computeBudgetInstructions?: RawInstruction[];
  setupInstructions?: RawInstruction[];
  swapInstruction?: RawInstruction;
  cleanupInstruction?: RawInstruction | null;
  otherInstructions?: RawInstruction[];
  addressLookupTableAddresses?: string[];
  computeUnitLimit?: number;
  error?: string;
};

function whole(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  if (value.length > 18) return null;
  return value;
}

function pair(inputMint: string, outputMint: string): boolean {
  return (
    inputMint !== outputMint &&
    [inputMint, outputMint].every((mint) => mint === WSOL || mint === USDC_MAINNET)
  );
}

export async function POST(request: Request) {
  let body: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
    slippageBps?: number;
    taker?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "The swap request could not be read." }, { status: 400 });
  }
  const inputMint = body.inputMint || "";
  const outputMint = body.outputMint || "";
  const amount = whole(body.amount);
  const slippageBps = Number(body.slippageBps);
  const taker = body.taker || "";
  if (!pair(inputMint, outputMint) || !amount || amount === "0") {
    return Response.json({ error: "The swap is only between SOL and USDC." }, { status: 400 });
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 50 || slippageBps > 500) {
    return Response.json({ error: "Slippage has to be between 0.50% and 5%." }, { status: 400 });
  }
  if (taker && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(taker)) {
    return Response.json({ error: "The wallet address is not valid." }, { status: 400 });
  }

  const quoteUrl = new URL(`${LITE}/quote`);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amount);
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));
  quoteUrl.searchParams.set("maxAccounts", "20");
  const quoted = await fetch(quoteUrl, { cache: "no-store" });
  const quote = (await quoted.json().catch(() => null)) as QuoteBody | null;
  if (!quoted.ok || !quote?.outAmount || !quote.otherAmountThreshold) {
    return Response.json({ error: "No SOL and USDC route is available right now." }, { status: 502 });
  }
  if (!taker) {
    return Response.json({
      outAmount: quote.outAmount,
      otherAmountThreshold: quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct || "0",
    });
  }

  const built = await fetch(`${LITE}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: taker, wrapAndUnwrapSol: true }),
    cache: "no-store",
  });
  const instructions = (await built.json().catch(() => null)) as InstructionBody | null;
  if (!built.ok || !instructions?.swapInstruction) {
    return Response.json({ error: "The SOL and USDC swap could not be built." }, { status: 502 });
  }
  return Response.json({
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct || "0",
    computeBudgetInstructions: instructions.computeBudgetInstructions || [],
    setupInstructions: instructions.setupInstructions || [],
    swapInstruction: instructions.swapInstruction,
    cleanupInstruction: instructions.cleanupInstruction,
    otherInstructions: instructions.otherInstructions || [],
    addressLookupTableAddresses: instructions.addressLookupTableAddresses || [],
    computeUnitLimit: instructions.computeUnitLimit || 200_000,
  });
}
