import { Keypair } from "@solana/web3.js";
import type { ClusterName } from "./constants";

const DRAFT_KEY = "par.rwa.draft";
const KEYS_PREFIX = "par.rwa.keys.v1";

export type RwaKeys = { record: Keypair; title: Keypair; collection: Keypair };

export function rwaDraftKey(): string {
  return DRAFT_KEY;
}

export function makeRwaKeys(): RwaKeys {
  return { record: Keypair.generate(), title: Keypair.generate(), collection: Keypair.generate() };
}

function keysStore(wallet: string, cluster: ClusterName) {
  return `${KEYS_PREFIX}:${wallet}:${cluster}`;
}

function encodeSecret(secret: Uint8Array): string {
  let binary = "";
  for (const byte of secret) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeSecret(text: string): Uint8Array {
  const binary = atob(text);
  const secret = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) secret[index] = binary.charCodeAt(index);
  return secret;
}

function fromSecret(text: string): Keypair | null {
  try {
    const secret = decodeSecret(text);
    if (secret.length !== 64) return null;
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

/** Same three addresses for this wallet and network, so a refresh can finish the mint. */
export function readRwaKeys(wallet: string, cluster: ClusterName): RwaKeys | null {
  if (typeof sessionStorage === "undefined" || !wallet) return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(keysStore(wallet, cluster)) || "null") as {
      record?: string;
      title?: string;
      collection?: string;
    } | null;
    if (!parsed?.record || !parsed.title || !parsed.collection) return null;
    const record = fromSecret(parsed.record);
    const title = fromSecret(parsed.title);
    const collection = fromSecret(parsed.collection);
    if (!record || !title || !collection) return null;
    return { record, title, collection };
  } catch {
    return null;
  }
}

export function writeRwaKeys(wallet: string, cluster: ClusterName, keys: RwaKeys) {
  if (typeof sessionStorage === "undefined" || !wallet) return;
  try {
    sessionStorage.setItem(
      keysStore(wallet, cluster),
      JSON.stringify({
        record: encodeSecret(keys.record.secretKey),
        title: encodeSecret(keys.title.secretKey),
        collection: encodeSecret(keys.collection.secretKey),
      }),
    );
  } catch {
    /* A private browser can refuse storage. The page still holds the keys until refresh. */
  }
}

export function clearRwaKeys(wallet: string, cluster: ClusterName) {
  try {
    sessionStorage.removeItem(keysStore(wallet, cluster));
  } catch {
    /* The mint already finished. */
  }
}

/** Drop the saved real-world-asset form. The record already exists. */
export function clearRwaDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* The draft stays in memory for this visit. */
  }
}
