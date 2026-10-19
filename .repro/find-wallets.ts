import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const c = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wsol = new PublicKey("So11111111111111111111111111111111111111112");
const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
(async () => {
  for (const w of (process.env.CANDIDATES || "").split(",").filter(Boolean)) {
    const k = new PublicKey(w);
    const ws = await c.getAccountInfo(getAssociatedTokenAddressSync(wsol, k));
    const us = await c.getAccountInfo(getAssociatedTokenAddressSync(usdc, k));
    console.log(w, "SOL", (await c.getBalance(k)) / 1e9, "WSOL ata", ws ? ws.data.readBigUInt64LE(64).toString() : "none", "USDC ata", us ? us.data.readBigUInt64LE(64).toString() : "none");
  }
})();
