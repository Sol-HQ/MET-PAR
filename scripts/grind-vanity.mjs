import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const prefixes = process.argv.slice(2);
if (prefixes.length === 0) {
  console.error("Usage: node scripts/grind-vanity.mjs MET PAR");
  process.exit(1);
}

os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
mkdirSync("keys", { recursive: true });

for (const prefix of prefixes) {
  const started = Date.now();
  let tries = 0;
  let found = null;
  while (!found) {
    const { secretKey, publicKey } = ed25519.keygen();
    tries += 1;
    const address = bs58.encode(publicKey);
    if (address.startsWith(prefix)) {
      const secret = new Uint8Array(64);
      secret.set(secretKey, 0);
      secret.set(publicKey, 32);
      const pair = Keypair.fromSecretKey(secret);
      if (pair.publicKey.toBase58() !== address) {
        throw new Error(`Refusing to save ${prefix}: public key did not round-trip`);
      }
      found = { address, secret };
    }
    if (tries % 100 === 0) await delay(20);
    if (tries % 25000 === 0) {
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`${prefix} still searching after ${tries.toLocaleString("en-US")} tries (${seconds}s)`);
    }
  }
  const file = `keys/${prefix}.json`;
  writeFileSync(file, JSON.stringify(Array.from(found.secret)));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${prefix} ${found.address}`);
  console.log(`saved ${file} after ${tries.toLocaleString("en-US")} tries in ${seconds}s`);
}
