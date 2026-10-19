/**
 * The title's "paid in" line is the buyer's promise; Unwrap SOL is one closeAccount. Run: npx tsx --test tests/*.test.ts
 * No network: every Connection here is a stub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WSOL } from "../src/lib/constants";
import { PAID_AT_LISTING, PAID_IN_OWN, paidInWords, priceRuleAllows, titleAttributes, titlePriceRule, type TitleFacts } from "../src/lib/title";
import { readWrappedSol, unwrapSolInstruction } from "../src/lib/token-pay";
import { readClassicMint } from "../src/lib/coin-read";

const COIN = Keypair.generate().publicKey.toBase58();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("paid in: the default is the words every existing title carries", () => {
  assert.equal(PAID_IN_OWN, "this token only");
  assert.equal(paidInWords(COIN), "this token only");
  assert.equal(paidInWords(COIN, null), "this token only");
  assert.equal(paidInWords(COIN, COIN), "this token only", "picking the coin itself writes the old words");
  assert.equal(paidInWords(COIN, USDC), USDC);
  assert.equal(paidInWords(COIN, WSOL), WSOL);
  assert.equal(paidInWords(COIN, USDC, true), PAID_AT_LISTING);
});

test("price rule: existing titles stay locked to their own token", () => {
  assert.deepEqual(titlePriceRule("this token only", COIN), { kind: "fixed", mint: COIN });
  assert.deepEqual(titlePriceRule(undefined, COIN), { kind: "fixed", mint: COIN });
  assert.deepEqual(titlePriceRule("anything else", COIN), { kind: "fixed", mint: COIN });
  assert.deepEqual(titlePriceRule(USDC, COIN), { kind: "fixed", mint: USDC });
  assert.deepEqual(titlePriceRule(PAID_AT_LISTING, COIN), { kind: "listing" });
  assert.equal(titlePriceRule("this token only", "not a mint"), null);
  const own = titlePriceRule("this token only", WSOL);
  assert.equal(priceRuleAllows(own, WSOL), true, "a SOL-paired title listed in SOL (the live AuZnoN listing) is allowed");
  assert.equal(priceRuleAllows(own, USDC), false);
  assert.equal(priceRuleAllows({ kind: "fixed", mint: USDC }, USDC), true);
  assert.equal(priceRuleAllows({ kind: "fixed", mint: USDC }, COIN), false);
  assert.equal(priceRuleAllows({ kind: "listing" }, USDC), true);
  assert.equal(priceRuleAllows({ kind: "listing" }, null), false);
  assert.equal(priceRuleAllows(null, COIN), false);
});

const FACTS: TitleFacts = {
  record: Keypair.generate().publicKey.toBase58(),
  mint: COIN,
  pool: Keypair.generate().publicKey.toBase58(),
  creator: Keypair.generate().publicKey.toBase58(),
  rail: "creator",
  delayDays: 7,
  burnPercent: 0,
  venue: "https://example.com/t",
};
const paidIn = (facts: TitleFacts) => titleAttributes(facts).find((row) => row.key === "paid in")?.value;

test("titleAttributes writes the price token only when the creator picks another", () => {
  assert.equal(paidIn(FACTS), "this token only");
  assert.equal(paidIn({ ...FACTS, priceMint: COIN }), "this token only");
  assert.equal(paidIn({ ...FACTS, priceMint: USDC }), USDC);
  assert.equal(paidIn({ ...FACTS, payAtListing: true }), PAID_AT_LISTING);
  // Everything except the "paid in" row is the same whichever token is picked.
  const strip = (facts: TitleFacts) => titleAttributes(facts).filter((row) => row.key !== "paid in");
  assert.deepEqual(strip({ ...FACTS, priceMint: USDC }), strip(FACTS));
});

function stub(accounts: Map<string, AccountInfo<Buffer>>): Connection {
  return {
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getParsedAccountInfo: async (key: PublicKey) => ({ value: accounts.get(key.toBase58()) ?? null, context: { slot: 1 } }),
  } as unknown as Connection;
}

function tokenAccount(owner: PublicKey, amount: bigint, opts: { state?: number; delegate?: PublicKey; holder?: PublicKey } = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: new PublicKey(WSOL),
      owner: opts.holder ?? owner,
      amount,
      delegateOption: opts.delegate ? 1 : 0,
      delegate: opts.delegate ?? PublicKey.default,
      state: opts.state ?? 1,
      isNativeOption: 1,
      isNative: BigInt(2039280),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, executable: false, lamports: Number(amount) + 2_039_280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 };
}

test("unwrap: one closeAccount of the owner's own wrapped-SOL account, back to the owner", () => {
  const owner = Keypair.generate().publicKey;
  const ix = unwrapSolInstruction(owner);
  const ata = getAssociatedTokenAddressSync(new PublicKey(WSOL), owner, false, TOKEN_PROGRAM_ID);
  assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID));
  assert.deepEqual(Array.from(ix.data), [9], "SPL Token CloseAccount");
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [ata.toBase58(), false, true],
      [owner.toBase58(), false, true],
      [owner.toBase58(), true, false],
    ],
  );
});

test("readWrappedSol reads the amount and refuses accounts it must not close", async () => {
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(new PublicKey(WSOL), owner, false, TOKEN_PROGRAM_ID).toBase58();
  assert.equal(await readWrappedSol(stub(new Map()), owner), null);
  const ok = await readWrappedSol(stub(new Map([[ata, tokenAccount(owner, BigInt(300000000))]])), owner);
  assert.equal(ok?.amount, BigInt(300000000));
  assert.equal(ok?.lamports, BigInt(302039280));
  assert.equal(ok?.closable, true);
  const frozen = await readWrappedSol(stub(new Map([[ata, tokenAccount(owner, BigInt(1), { state: 2 })]])), owner);
  assert.equal(frozen?.closable, false);
  assert.match(frozen!.reason, /frozen/);
  const delegated = await readWrappedSol(stub(new Map([[ata, tokenAccount(owner, BigInt(1), { delegate: Keypair.generate().publicKey })]])), owner);
  assert.equal(delegated?.closable, false);
  assert.match(delegated!.reason, /delegate/);
  const foreign = await readWrappedSol(stub(new Map([[ata, tokenAccount(owner, BigInt(1), { holder: Keypair.generate().publicKey })]])), owner);
  assert.equal(foreign?.closable, false);
});

test("escrow price tokens: Token-2022 is refused with a clear message", async () => {
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: BigInt(0), decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  const t22 = stub(new Map([[mint.toBase58(), { data, executable: false, lamports: 1, owner: TOKEN_2022_PROGRAM_ID, rentEpoch: 0 }]]));
  await assert.rejects(readClassicMint(t22, mint.toBase58()), /Token-2022\. The escrow cannot settle it/);
  await assert.rejects(readClassicMint(stub(new Map()), mint.toBase58()), /not a token on this network/);
  const other = stub(new Map([[mint.toBase58(), { data, executable: false, lamports: 1, owner: Keypair.generate().publicKey, rentEpoch: 0 }]]));
  await assert.rejects(readClassicMint(other, mint.toBase58()), /not an ordinary SPL token/);
});
