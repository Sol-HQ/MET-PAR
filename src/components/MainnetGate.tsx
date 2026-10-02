"use client";

import type { ReactNode } from "react";

export function MainnetGate({
  title,
  lines,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div className="gate-card">
        <p className="eyebrow">Mainnet confirmation</p>
        <h2 id="gate-title">{title}</h2>
        <p>These are the amounts this signature will use. Nothing is sent until you confirm.</p>
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return <p className="status">{children}</p>;
}
