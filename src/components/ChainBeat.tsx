"use client";

import { useEffect, useState } from "react";
import { formatSolanaTime, watchFreshBlockhash } from "@/lib/chain-beat";
import { useCluster } from "@/lib/cluster";

const POLL_MS = 16_000;
const HIDDEN_MS = 60_000;

type Beat = {
  unixTimestamp: number;
  readAt: number;
  slot: number;
  blockhash: string;
};

export function ChainBeat() {
  const { cluster } = useCluster();
  const [beat, setBeat] = useState<Beat | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    return watchFreshBlockhash((note) => {
      setBeat((current) =>
        current
          ? { ...current, blockhash: note.blockhash }
          : { unixTimestamp: 0, readAt: Date.now(), slot: 0, blockhash: note.blockhash },
      );
    });
  }, []);

  useEffect(() => {
    let stop = false;
    let inFlight = false;
    let timer = 0;
    const path = `/api/beat?c=${cluster === "devnet" ? "devnet" : "mainnet"}`;

    async function poll() {
      if (stop || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await fetch(path);
        const body = (await response.json()) as { unixTimestamp?: number; slot?: number; blockhash?: string };
        if (stop || !response.ok) return;
        setBeat((current) => ({
          unixTimestamp: body.unixTimestamp || current?.unixTimestamp || 0,
          readAt: body.unixTimestamp ? Date.now() : current?.readAt || Date.now(),
          slot: body.slot || current?.slot || 0,
          blockhash: body.blockhash || current?.blockhash || "",
        }));
      } catch {
        /* Keep the last reading. The next pass asks again. */
      } finally {
        inFlight = false;
      }
    }

    function wait() {
      window.clearTimeout(timer);
      if (stop) return;
      const hidden = document.visibilityState === "hidden";
      timer = window.setTimeout(() => {
        if (hidden) {
          wait();
          return;
        }
        void poll().then(wait);
      }, hidden ? HIDDEN_MS : POLL_MS);
    }

    void poll().then(wait);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll().then(wait);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cluster]);

  const elapsed = beat && beat.unixTimestamp > 0 ? beat.unixTimestamp + Math.max(0, Math.floor((now - beat.readAt) / 1000)) : 0;
  const time = formatSolanaTime(elapsed);
  const hash = beat?.blockhash || "";

  return (
    <p className="chain-beat" aria-live="polite">
      <span>Solana {time || "time"}</span>
      {beat?.slot ? <span>Slot {beat.slot.toLocaleString("en-US")}</span> : null}
      <span className="chain-hash">{hash || "Recent blockhash"}</span>
    </p>
  );
}
