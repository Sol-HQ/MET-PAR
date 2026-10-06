"use client";

import { useState } from "react";

export function MainnetGate({
  title,
  lines,
  confirmLabel,
  onCancel,
  onConfirm,
  kicker = "Mainnet confirmation",
  note = "These are the amounts this signature will use. Nothing is sent until you confirm.",
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  kicker?: string;
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const review = [kicker, title, "", note, "", ...lines].join("\n");

  async function copyReview() {
    try {
      await navigator.clipboard.writeText(review);
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = review;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        const copiedNow = document.execCommand("copy");
        area.remove();
        if (!copiedNow) return;
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div className="gate-card">
        <p className="eyebrow">{kicker}</p>
        <h2 id="gate-title">{title}</h2>
        <p>{note}</p>
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" onClick={() => void copyReview()}>
            {copied ? "Copied" : "Copy"}
          </button>
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
