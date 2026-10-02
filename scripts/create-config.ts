import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import published from "../configs/published.json";
import {
  PRESETS,
  quoteMintAddress,
  rpcUrl,
  type ClusterName,
  type PresetId,
} from "../src/lib/constants";
import { assertPreset, buildPresetConfig } from "../src/lib/curve";
import { formatLamports } from "../src/lib/format";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function loadKeypair(file: string): Keypair {
  const secret = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function clusterFileKey(cluster: ClusterName): "devnet" | "mainnet" {
  return cluster === "devnet" ? "devnet" : "mainnet";
}

async function main() {
  const preset = arg("--preset") as PresetId | undefined;
  const cluster = (arg("--cluster") ?? "devnet") as ClusterName;
  const payerPath = arg("--payer");
  const dryRun = process.argv.includes("--dry-run");

  if (preset !== "par" && preset !== "demo") {
    throw new Error("Pass --preset par or --preset demo");
  }
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new Error("Pass --cluster devnet or --cluster mainnet-beta");
  }
  if (preset === "demo" && cluster !== "devnet") {
    throw new Error("The demo config is devnet only.");
  }
  if (!payerPath) {
    throw new Error("Pass --payer path/to/solana-keygen.json");
  }

  const check = assertPreset(preset);
  const spec = PRESETS[preset];
  const quoteMint = quoteMintAddress(cluster);
  const payer = loadKeypair(payerPath);
  mkdirSync("keys", { recursive: true });
  const configPath = `keys/${cluster}-${preset}-config.json`;
  const configKey = existsSync(configPath) ? loadKeypair(configPath) : Keypair.generate();
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(Array.from(configKey.secretKey)));
  }

  const lines = [
    `Preset: ${preset}`,
    `Network: ${cluster}`,
    `Quote mint: ${quoteMint.toBase58()} (USDC, 6 decimals)`,
    `migration_quote_threshold: ${spec.thresholdLabel} (${check.migrationQuoteThreshold} base units)`,
    `Start price: ${check.startPrice} USDC`,
    `End price: ${check.endPrice} USDC`,
    `Price multiple: ${check.ratio}`,
    `Curve segments: ${check.points}`,
    `Supply: ${spec.totalTokenSupply}`,
    `Leftover: ${spec.leftover}`,
    `Fee scheduler: 50% to 1%, exponential, 60 periods, 3600 seconds`,
    `Rate limiter: no`,
    `DAMM v2 config: ${check.dammConfig} (25 bps)`,
    `Pool creation fee: 0 lamports`,
    `USDC moved by this transaction: 0`,
    `Payer: ${payer.publicKey.toBase58()}`,
    `Fee claimer and leftover receiver: ${payer.publicKey.toBase58()}`,
    `Config account: ${configKey.publicKey.toBase58()}`,
  ];
  console.log(lines.join("\n"));

  if (cluster === "mainnet-beta" && process.env.PAR_CONFIRM_MAINNET !== "yes") {
    console.error(
      "\nRefusing to send a mainnet transaction. Review the amounts above, then rerun with PAR_CONFIRM_MAINNET=yes.",
    );
    process.exit(1);
  }

  const connection = new Connection(rpcUrl(cluster), "confirmed");
  const existing = await connection.getAccountInfo(configKey.publicKey);
  if (existing) {
    console.log("\nConfig account already exists. Publishing the address without a new transaction.");
    publish(cluster, preset, configKey.publicKey);
    return;
  }

  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const transaction = await client.partner.createConfig({
    ...buildPresetConfig(preset),
    config: configKey.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    payer: payer.publicKey,
    quoteMint,
  });
  transaction.feePayer = payer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  console.log(`\nNetwork fee: ${formatLamports(fee.value ?? 0)}`);
  console.log("Rent for the new config account is charged in addition to that network fee.");

  if (dryRun) {
    console.log("Dry run only. No transaction sent.");
    return;
  }

  transaction.partialSign(payer, configKey);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  console.log(`\nConfig created: ${signature}`);
  publish(cluster, preset, configKey.publicKey);
}

function publish(cluster: ClusterName, preset: PresetId, config: PublicKey) {
  const next = structuredClone(published) as typeof published & {
    devnet: { par: string; demo: string };
    mainnet: { par: string };
  };
  const key = clusterFileKey(cluster);
  if (preset === "demo") next.devnet.demo = config.toBase58();
  else next[key].par = config.toBase58();
  writeFileSync("configs/published.json", `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote configs/published.json ${key}.${preset}=${config.toBase58()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
