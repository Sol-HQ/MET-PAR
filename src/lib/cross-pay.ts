import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Transaction,
} from "@solana/web3.js";
import { finishSignature, JITO_TIP_ACCOUNTS, JITO_TIP_LAMPORTS, jitoTipLamports } from "./send";
import { explainTx } from "./tx-error";
import { reportTx, ReportedTxError } from "./tx-notice";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

export type RawInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

export type PayRoute = {
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  computeBudgetInstructions?: RawInstruction[];
  setupInstructions?: RawInstruction[];
  swapInstruction?: RawInstruction;
  cleanupInstruction?: RawInstruction | null;
  otherInstructions?: RawInstruction[];
  addressLookupTableAddresses?: string[];
  computeUnitLimit?: number;
};

export async function readPayRoute(input: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  taker?: string;
}): Promise<PayRoute> {
  const response = await fetch("/api/pay-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as (PayRoute & { error?: string }) | null;
  if (!response.ok || !body?.outAmount || !body.otherAmountThreshold) {
    throw new Error(body?.error || "The SOL and USDC swap could not be quoted.");
  }
  return body;
}

function toInstruction(raw: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

function priceInstruction(rows: RawInstruction[]): TransactionInstruction | null {
  const row = rows.find((item) => item.programId === COMPUTE_BUDGET && Buffer.from(item.data, "base64")[0] === 3);
  return row ? toInstruction(row) : null;
}

function poolInstructions(transaction: Transaction): TransactionInstruction[] {
  return transaction.instructions.filter((item) => item.programId.toBase58() !== COMPUTE_BUDGET);
}

async function lookupTables(connection: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const keys = addresses.map((item) => new PublicKey(item));
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const tables: AddressLookupTableAccount[] = [];
  infos.forEach((info, index) => {
    if (!info) return;
    tables.push(
      new AddressLookupTableAccount({
        key: keys[index],
        state: AddressLookupTableAccount.deserialize(info.data),
      }),
    );
  });
  return tables;
}

/**
 * One signature. The SOL/USDC swap and the pool swap share it.
 * On a buy the swap runs first and the pool spends the minimum it promised.
 * On a sell the pool runs first and the swap spends the minimum the pool promised.
 */
export async function buildCrossTransaction(input: {
  connection: Connection;
  payer: PublicKey;
  route: PayRoute;
  pool: Transaction;
  sell: boolean;
}): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number }> {
  if (!input.route.swapInstruction) throw new Error("The SOL and USDC swap did not return a transaction.");
  const tables = await lookupTables(input.connection, input.route.addressLookupTableAddresses || []);
  const units = Math.min(1_400_000, (input.route.computeUnitLimit || 200_000) + 400_000);
  const setup = (input.route.setupInstructions || []).map(toInstruction);
  const swap = [
    toInstruction(input.route.swapInstruction),
    ...(input.route.otherInstructions || []).map(toInstruction),
  ];
  const cleanup = input.route.cleanupInstruction ? [toInstruction(input.route.cleanupInstruction)] : [];
  const pool = poolInstructions(input.pool);
  const price = priceInstruction(input.route.computeBudgetInstructions || []);
  const ordered = input.sell ? [...setup, ...pool, ...swap, ...cleanup] : [...setup, ...swap, ...pool, ...cleanup];
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tip = jitoTipLamports(input.connection.rpcEndpoint);
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const tipInstruction =
    tip > 0
      ? SystemProgram.transfer({
          fromPubkey: input.payer,
          toPubkey: new PublicKey(tipAccount),
          lamports: JITO_TIP_LAMPORTS,
        })
      : null;

  function compile(withTip: boolean): VersionedTransaction {
    const message = new TransactionMessage({
      payerKey: input.payer,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ...(price ? [price] : []),
        ...ordered,
        ...(withTip && tipInstruction ? [tipInstruction] : []),
      ],
    }).compileToV0Message(tables);
    const transaction = new VersionedTransaction(message);
    transaction.signatures = transaction.signatures.map(() => new Uint8Array(64));
    return transaction;
  }

  let transaction = compile(true);
  if (transaction.serialize().length > 1232) transaction = compile(false);
  if (transaction.serialize().length > 1232) {
    throw new Error("That SOL and USDC route does not fit in one transaction. Pay with the coin's own quote.");
  }
  return { transaction, lastValidBlockHeight: latest.lastValidBlockHeight };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function sendCrossTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  lastValidBlockHeight: number,
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>,
  landed = "Transaction confirmed.",
): Promise<string> {
  let signature = "";
  try {
    const expected = transaction.message.serialize();
    const blockhash = transaction.message.recentBlockhash;
    const signed = await signTransaction(transaction);
    if (!sameBytes(signed.message.serialize(), expected)) {
      throw new Error("The wallet changed the transaction. It was not sent.");
    }
    const raw = signed.serialize();
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
    await finishSignature(connection, signature, blockhash, lastValidBlockHeight, landed);
    return signature;
  } catch (cause) {
    if (cause instanceof ReportedTxError) throw cause;
    const text = explainTx(cause);
    reportTx({ kind: "bad", text });
    throw new ReportedTxError(text);
  }
}
