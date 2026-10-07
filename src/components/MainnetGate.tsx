"use client";

import { useState } from "react";

export function reviewText(heading: string, lines: string[], note?: string): string {
  return [heading, ...(note ? ["", note] : []), "", ...lines].join("\n");
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const copiedNow = document.execCommand("copy");
      area.remove();
      return copiedNow;
    } catch {
      return false;
    }
  }
}

function saveReview(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ReviewFile({ text, filename }: { text: string; filename: string }) {
  const [copied, setCopied] = useState(false);

  async function copyReview() {
    if (!(await writeClipboard(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <button type="button" onClick={() => void copyReview()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <button type="button" onClick={() => saveReview(filename, text)}>
        Download
      </button>
    </>
  );
}

export function MainnetGate({
  title,
  lines,
  confirmLabel,
  onCancel,
  onConfirm,
  kicker = "Mainnet confirmation",
  note = "These are the amounts this signature will use. Nothing is sent until you confirm.",
  filename = "par-review.txt",
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  kicker?: string;
  note?: string;
  filename?: string;
}) {
  const review = reviewText(`${kicker}\n${title}`, lines, note);

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
          <ReviewFile text={review} filename={filename} />
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
