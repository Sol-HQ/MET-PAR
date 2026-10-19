// Read-only: every listing account of the devnet escrow program, its price mint, pool coin, and burn.
import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection("https://solana-devnet.api.onfinality.io/public", "confirmed");
const PROGRAM = new PublicKey("FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF");
const accounts = await c.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 252 }] });
console.log("listings:", accounts.length);
for (const { pubkey, account } of accounts) {
  const d = account.data;
  const key = (at: number) => new PublicKey(d.subarray(at, at + 32)).toBase58();
  const mint = key(104), pool = key(136), burn = d.readUInt16LE(200);
  let coin = "none";
  if (pool !== PublicKey.default.toBase58()) {
    const p = await c.getAccountInfo(new PublicKey(pool));
    // DBC pool base mint (same offset the program reads, POOL_BASE_MINT_AT).
    coin = p ? `pool owner ${p.owner.toBase58().slice(0, 8)} len ${p.data.length}` : "pool missing";
  }
  console.log(JSON.stringify({ listing: pubkey.toBase58(), asset: key(40), mint, pool, burnBps: burn, coin }));
}
