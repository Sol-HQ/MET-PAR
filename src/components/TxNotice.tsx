"use client";

import { useEffect, useState } from "react";
import { subscribeTx, type TxNoticeEvent } from "@/lib/tx-notice";

export function TxNotice() {
  const [notice, setNotice] = useState<TxNoticeEvent | null>(null);

  useEffect(() => subscribeTx(setNotice), []);

  if (!notice) return null;
  return (
    <div className={notice.kind === "ok" ? "toast" : "toast bad"} role="status">
      <p>{notice.text}</p>
      {notice.href ? (
        <p>
          <a href={notice.href} target="_blank" rel="noreferrer">
            View the transaction
          </a>
        </p>
      ) : null}
      <button type="button" onClick={() => setNotice(null)}>
        Close
      </button>
    </div>
  );
}
