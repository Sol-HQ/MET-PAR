// Read-only: copies public devnet accounts used by the escrow tests. Run with `node fetch-fixtures.mjs`.
import { writeFileSync } from "node:fs";
const RPC = process.env.DEVNET_RPC_URL || "https://solana-devnet.api.onfinality.io/public";
const accounts = {
  sealedTitle: "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi",
  sealedCollection: "7WCvRVVEFaa2fPsdCe1HgYw1yT5diUnuuxHcL5s3yxvc",
  sealedRecord: "9vSeor8BrXwMC4KUTEeFzRmqgA8GQLadV61KRijWkf75",
  liveListing: "MADGVsSMy2pMwMSRt5XZwb9yqmbFUFXryxpiKmQcBQq",
  liveTitle: "6BpdLJb1FVwPoS5E8t91CsCZfX5xj5KVBKHh9pQCc8ea",
  livePool: "4muA54PzKNKt9xVkb84y46vJTWCQeEqZgRtRzzcxQC7V",
  liveCoin: "B4NRfZPEn3izWTgZxSJkEt4CrNvEPEisfiyLwsKFN8oG",
};
const body = { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [Object.values(accounts), { encoding: "base64", commitment: "confirmed" }] };
const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = await res.json();
const out = { fetchedAt: new Date().toISOString(), slot: json.result.context.slot, accounts: {} };
Object.entries(accounts).forEach(([name, address], i) => {
  const a = json.result.value[i];
  out.accounts[name] = a && { address, owner: a.owner, lamports: a.lamports, executable: a.executable, data: a.data[0] };
});
writeFileSync(new URL("./fixtures/devnet-accounts.json", import.meta.url), JSON.stringify(out, null, 2));
for (const [k, v] of Object.entries(out.accounts)) console.log(k, v ? `${v.owner} ${Buffer.from(v.data, "base64").length}B` : "MISSING");

// The programs the tests load: Metaplex Core and the escrow binary deployed today (to compare old and new behaviour).
async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = await r.json().catch(() => ({}));
    if (json.result) return json.result;
    await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
  }
  throw new Error(`${method} kept failing on ${RPC}`);
}
const { PublicKey } = await import("@solana/web3.js");
for (const [file, program] of [["mpl_core.so", "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"], ["par_escrow_deployed.so", "FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF"]]) {
  const prog = await rpc("getAccountInfo", [program, { encoding: "base64" }]);
  const programData = new PublicKey(Buffer.from(prog.value.data[0], "base64").subarray(4, 36)).toBase58();
  const pd = await rpc("getAccountInfo", [programData, { encoding: "base64" }]);
  const bytes = Buffer.from(pd.value.data[0], "base64").subarray(45);
  writeFileSync(new URL(`./fixtures/${file}`, import.meta.url), bytes);
  console.log(file, bytes.length, "bytes from", programData);
}
