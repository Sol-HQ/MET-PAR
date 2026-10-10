"use client";

import { useState, type ReactNode } from "react";

export function Fold({
  children,
  label,
  lead,
  end = false,
  dotsFirst = false,
  arrow = false,
  tail,
}: {
  children: ReactNode;
  label?: string;
  lead?: string;
  end?: boolean;
  dotsFirst?: boolean;
  arrow?: boolean;
  tail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const words = open ? "Press to close" : "Press to open";
  const mark = <span className="fold-dots" aria-hidden="true">···</span>;
  const point = arrow ? (
    <span className="fold-arrow" aria-hidden="true">{open ? "↓" : "→"}</span>
  ) : null;
  const button = (
    <button type="button" className={end ? "fold-open fold-end" : "fold-open"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {end ? (
        <>
          <span className="fold-end-words">{lead}</span>
          {mark}
        </>
      ) : (
        <>
          {dotsFirst ? mark : null}
          <span className="fold-words">{words}</span>
          {point}
          {dotsFirst ? null : mark}
        </>
      )}
    </button>
  );
  return (
    <div className={end ? "fold fold-end" : "fold"}>
      {label ? (
        <div className="fold-head">
          <h2>{label}</h2>
          {button}
        </div>
      ) : (
        button
      )}
      {tail}
      {open ? <div className="fold-body">{children}</div> : null}
    </div>
  );
}
