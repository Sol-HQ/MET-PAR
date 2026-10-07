export type TxNoticeEvent = {
  kind: "ok" | "bad";
  text: string;
  href?: string;
};

type Listener = (event: TxNoticeEvent) => void;

const listeners = new Set<Listener>();

export function subscribeTx(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportTx(event: TxNoticeEvent) {
  listeners.forEach((listener) => listener(event));
}

/** Thrown after the notice is already on screen, so a caller does not report it again. */
export class ReportedTxError extends Error {}
