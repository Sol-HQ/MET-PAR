import { PublicKey } from "@solana/web3.js";

export const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

export type FreshBlockhash = {
  blockhash: string;
  lastValidBlockHeight: number;
};

export type ClockRead = {
  slot: number;
  unixTimestamp: number;
};

const listeners = new Set<(note: FreshBlockhash) => void>();

/** A send already paid for this hash. The header reuses it instead of asking again. */
export function noteFreshBlockhash(note: FreshBlockhash) {
  if (!note.blockhash || !Number.isFinite(note.lastValidBlockHeight)) return;
  for (const listener of listeners) listener(note);
}

export function watchFreshBlockhash(listener: (note: FreshBlockhash) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clock sysvar: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp. */
export function readClock(data: Uint8Array): ClockRead | null {
  if (data.length < 40) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unixTimestamp = Number(view.getBigInt64(32, true));
  if (!Number.isFinite(unixTimestamp) || unixTimestamp <= 0) return null;
  return {
    slot: Number(view.getBigUint64(0, true)),
    unixTimestamp,
  };
}

export function formatSolanaTime(unixTimestamp: number): string {
  if (!Number.isFinite(unixTimestamp) || unixTimestamp <= 0) return "";
  return `${new Date(unixTimestamp * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`;
}
