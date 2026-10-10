"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { ClusterName } from "@/lib/constants";
import { handoffCloseMs, handoffEndsAt, handoffMessage, readBuyerCard, type HandoffPublic } from "@/lib/handoff-message";
import { bytesToBase64 } from "@/lib/picture";

type DeskNote = { from: "seller" | "buyer"; body: string; at: string };

type Signed = HandoffPublic & {
  role: "creator" | "holder";
  email: string | null;
  mine: string;
  mineAt: string | null;
  theirs: string;
  theirsAt: string | null;
  otherSubscribed: boolean;
  notes: DeskNote[];
  notice: "sent" | "saved" | "same" | "stopped" | "wait" | null;
};

function clockLine(view: HandoffPublic): string {
  if (!view.indexed) return "This title is not in the PAR index, so this box stays closed.";
  if (view.place === "none") return "The title is not on chain yet.";
  if (view.place === "listed") return "The title is listed. The seller can subscribe to sale email now.";
  if (view.place === "escrow") return "The escrow holds the title. The seller can subscribe to sale email now.";
  if (view.place === "wallet") return "The title is in the creator wallet. The seller can subscribe to sale email now.";
  if (!view.heldAt) return "A buyer holds the title. The chain has not given the move time yet, so the clock has not started.";
  if (!view.handoffDays) return "A buyer holds the title. The sheet names the handoff.";
  return "A buyer holds the title. This clock is the handoff time on the sheet.";
}

function unit(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function remain(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [unit(days, "day", "days"), unit(hours, "hour", "hours"), unit(minutes, "minute", "minutes"), unit(seconds, "second", "seconds")].join(" ");
}

function when(iso: string | null): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toUTCString().replace(/:\d\d GMT$/, " UTC");
}

function HandoffClock({ view }: { view: HandoffPublic }) {
  const [now, setNow] = useState(() => Date.now());
  const end = view.place === "held" && view.heldAt && view.handoffDays ? handoffEndsAt(view.heldAt, view.handoffDays) : null;
  useEffect(() => {
    if (end === null || end <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [end]);

  if (!view.indexed || view.place === "none") return null;
  if (view.place !== "held" || !view.heldAt || !view.handoffDays || end === null) {
    return (
      <>
        <p className="handoff-clock">{view.handoffDays ? unit(view.handoffDays, "day", "days") : "Handoff"}</p>
        <p className="note">
          {view.handoffDays
            ? "The sheet sets this many days. The clock starts when a buyer holds the title."
            : "The sheet names the handoff. The clock starts when a buyer holds the title."}
        </p>
      </>
    );
  }
  const left = end - now;
  const close = left <= handoffCloseMs(view.handoffDays);
  return (
    <>
      <p className="handoff-clock" role="timer">
        {left > 0 ? remain(left) : "The handoff days have passed"}
      </p>
      <p className="note">
        {left <= 0
          ? "The seller's promise still stands: hand the object to the holder of the title."
          : close
            ? "The handoff days are close. The seller's promise is to finish handing over the object."
            : `The sheet sets ${unit(view.handoffDays, "day", "days")}. The clock started when this wallet held the title.`}
      </p>
    </>
  );
}

export function HandoffDesk({
  cluster,
  title,
  mailOnly = false,
}: {
  cluster: ClusterName;
  title: string;
  mailOnly?: boolean;
}) {
  const { publicKey, signMessage } = useWallet();
  const [view, setView] = useState<HandoffPublic | null>(null);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [line, setLine] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const wallet = publicKey?.toBase58() || "";

  const load = useCallback(async () => {
    const response = await fetch(`/api/handoff?title=${encodeURIComponent(title)}&c=${cluster === "devnet" ? "devnet" : "mainnet"}`);
    const body = (await response.json()) as HandoffPublic & { error?: string };
    if (!response.ok) throw new Error(body.error || "The handoff box did not load.");
    setView(body);
  }, [cluster, title]);

  useEffect(() => {
    let gone = false;
    void load().catch((cause) => {
      if (!gone) setError(cause instanceof Error ? cause.message : "The handoff box did not load.");
    });
    return () => {
      gone = true;
    };
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => {
      void load().catch(() => undefined);
    }, 20000);
    return () => clearInterval(id);
  }, [load]);

  async function post(kind: "mail" | "reach" | "read" | "note" | "buyer", text: string) {
    if (!wallet || !signMessage) throw new Error("Connect the creator wallet or the holder wallet.");
    const issuedAt = Date.now();
    const messageText = kind === "read" ? "" : text;
    const signedMessage = handoffMessage({ kind, cluster, title, wallet, text: messageText, issuedAt });
    const signature = bytesToBase64(await signMessage(new TextEncoder().encode(signedMessage)));
    const response = await fetch("/api/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cluster, title, kind, text: messageText, wallet, issuedAt, signature }),
    });
    const body = (await response.json()) as Signed & { error?: string };
    if (!response.ok) throw new Error(body.error || "The handoff box did not save.");
    setSigned(body);
    setView(body);
    setAgree(Boolean(body.email));
    setLine(body.mine || "");
    const card = body.role === "holder" ? readBuyerCard(body.mine || "") : null;
    setEmail(card?.email || body.email || "");
    if (card) {
      setBuyerName(card.name);
      setBuyerAddress(card.address);
    }
    return body;
  }

  async function open() {
    setBusy(true);
    setError("");
    try {
      await post("read", "");
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not sign.");
    } finally {
      setBusy(false);
    }
  }

  async function saveMail() {
    setBusy(true);
    setError("");
    try {
      if (!agree && !signed?.email) throw new Error("Check the box to subscribe.");
      const body = await post("mail", agree ? `subscribe\n${email.trim()}` : "stop");
      if (body.notice === "sent") setNote("PAR sent a confirmation from the PAR platform to that address.");
      else if (body.notice === "same") setNote("That address is already subscribed.");
      else if (body.notice === "stopped") setNote("Those PAR emails will stop.");
      else setNote("Saved. The confirmation from the PAR platform sends when mail is connected.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The email did not save.");
    } finally {
      setBusy(false);
    }
  }

  async function leaveBuyer() {
    setBusy(true);
    setError("");
    try {
      if (!email.trim()) throw new Error("Enter the email the seller should use.");
      const body = await post(
        "buyer",
        JSON.stringify({
          name: buyerName.trim(),
          address: buyerAddress.trim(),
          email: email.trim(),
          message: firstMessage.trim(),
          subscribe: agree,
        }),
      );
      setFirstMessage("");
      if (body.notice === "same") setNote("That contact is already saved for the seller.");
      else setNote("Saved. The seller sees your name, mailing address, and email on this page. Wait to hear from the seller.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The contact did not save.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLine() {
    setBusy(true);
    setError("");
    try {
      await post("reach", line);
      setNote("The handoff line is saved for the other wallet.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff line did not save.");
    } finally {
      setBusy(false);
    }
  }

  async function sendNote() {
    setBusy(true);
    setError("");
    try {
      const body = await post("note", message);
      setMessage("");
      if (body.notice === "sent") setNote("PAR emailed that note from the PAR platform.");
      else if (body.notice === "wait") setNote("Saved. PAR emails it from the PAR platform once the other person subscribes.");
      else setNote("Saved. PAR emails that note from the PAR platform.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The note did not send.");
    } finally {
      setBusy(false);
    }
  }

  const shown = signed ?? view;
  const sale = signed?.role === "creator";
  const buyerOpen = Boolean(shown && shown.place === "held" && !mailOnly && (!signed || signed.role === "holder"));
  const buyerCard = signed?.theirs ? readBuyerCard(signed.theirs) : null;
  return (
    <article className="card">
      <p className="eyebrow">Handoff</p>
      <h2>How to be reached</h2>
      <p>{shown ? clockLine(shown) : "Reading the title."}</p>
      {shown ? <HandoffClock view={shown} /> : null}
      {mailOnly ? (
        <p className="note">Confirm sale email from the PAR platform while the title is still yours. The sale page counts the handoff days after a buyer holds the title.</p>
      ) : (
        <>
          <p>
            {shown?.place === "held"
              ? "The purchase is complete. The buyer stays signed in with the wallet that holds the title, or signs in again with that wallet, and leaves a name, a mailing address, and an email."
              : "Once the purchase is complete, the buyer stays signed in with the wallet that holds the title, or signs in again with that wallet, and leaves a name, a mailing address, and an email."}
          </p>
          <ol className="handoff-road">
            <li>The seller connects the creator wallet, checks the box, and subscribes to sale email from the PAR platform. This can happen while the title is in that wallet, listed, or in escrow.</li>
            <li>When a buyer holds the title, PAR emails the seller once. The clock starts then and counts down the days on the sheet.</li>
            <li>The buyer leaves a name, a mailing address, and an email here, as soon as that wallet holds the title or a few minutes later, then waits to hear from the seller.</li>
            <li>Each person can write a note on this page. PAR emails that note only to the other person.</li>
            <li>When the handoff days run close, PAR emails the seller once, to remind them of the handoff and the promise on the sheet.</li>
          </ol>
        </>
      )}
      {buyerOpen ? (
        <>
          <h3>For the seller</h3>
          <p className="note">You can leave this as soon as this wallet holds the title, or a few minutes later.</p>
          <label>
            Name
            <input value={buyerName} onChange={(event) => setBuyerName(event.target.value)} autoComplete="name" maxLength={80} />
          </label>
          <label>
            Mailing address
            <textarea value={buyerAddress} onChange={(event) => setBuyerAddress(event.target.value)} rows={4} maxLength={220} autoComplete="street-address" />
          </label>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" maxLength={120} />
            <span className="note">The seller sees this email with your name and mailing address. You can leave the email on its own and wait for the seller to write first.</span>
          </label>
          <label className="agree">
            <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} />
            <span>I also want email from the PAR platform about this purchase.</span>
          </label>
          <label>
            Message for the seller
            <textarea value={firstMessage} onChange={(event) => setFirstMessage(event.target.value)} rows={4} maxLength={500} />
            <span className="note">Optional. Leave it blank to wait for the seller.</span>
          </label>
          <button type="button" className="solid" disabled={busy || !wallet || !email.trim()} onClick={() => void leaveBuyer()}>
            {busy ? "Saving…" : wallet ? "Leave this for the seller" : "Connect the wallet that holds the title"}
          </button>
        </>
      ) : null}
      {!signed ? (
        <button type="button" className="solid" disabled={busy || !wallet} onClick={() => void open()}>
          {busy ? "Waiting for the wallet…" : wallet ? (shown?.place === "held" ? "Sign in with the wallet that holds the title" : "Sign in to this handoff") : shown?.place === "held" ? "Connect the wallet that holds the title" : "Connect the creator wallet or the holder wallet"}
        </button>
      ) : (
        <>
          {sale ? (
            <>
              <label className="agree">
                <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} />
                <span>I want email from the PAR platform about this sale.</span>
              </label>
              <label>
                Email for this sale
                <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" maxLength={120} />
                <span className="note">Private. The buyer does not see this address. Every message says it is from the PAR platform and that it is about your sale.</span>
              </label>
              <button type="button" disabled={busy || (agree && !email.trim())} onClick={() => void saveMail()}>
                {busy ? "Saving…" : agree ? "Subscribe to sale email" : "Stop PAR email"}
              </button>
            </>
          ) : null}
          {mailOnly ? null : (
            <>
              {sale ? (
                <>
                  <label>
                    How the buyer can reach you
                    <textarea value={line} onChange={(event) => setLine(event.target.value)} rows={4} maxLength={500} />
                    <span className="note">An email, a ship-to, or a place to meet. This line shows on the page after a buyer holds the title. Leave it blank and save to clear it.</span>
                  </label>
                  <button type="button" disabled={busy} onClick={() => void saveLine()}>
                    {busy ? "Saving…" : "Save the handoff line"}
                  </button>
                </>
              ) : null}
              {buyerCard ? (
                <div>
                  <p>
                    {sale ? "The buyer left" : "The seller wrote"}
                    {signed.theirsAt ? ` ${when(signed.theirsAt)}` : ""}
                  </p>
                  {buyerCard.name ? <p>Name: {buyerCard.name}</p> : null}
                  {buyerCard.address ? <p className="handoff-address">Mailing address: {buyerCard.address}</p> : null}
                  <p>Email: {buyerCard.email}</p>
                </div>
              ) : signed.theirs ? (
                <p>
                  {sale ? "The buyer wrote" : "The seller wrote"}
                  {signed.theirsAt ? ` ${when(signed.theirsAt)}` : ""}: {signed.theirs}
                </p>
              ) : signed.place === "held" ? (
                <p className="note">{sale ? "The buyer has not left contact yet." : "The seller has not left a line yet."}</p>
              ) : (
                <p className="note">The other line shows after a buyer holds the title.</p>
              )}
              {signed.place === "held" ? (
                <>
                  {signed.notes.length ? (
                    <ul className="handoff-notes">
                      {signed.notes.map((item, index) => (
                        <li key={`${item.at}-${index}`}>
                          <span className="note">
                            {item.from === "seller" ? "Seller" : "Buyer"}
                            {item.at ? ` · ${when(item.at)}` : ""}
                          </span>
                          <p>{item.body}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note">No notes yet.</p>
                  )}
                  <label>
                    {sale ? "Note to the buyer" : "Note to the seller"}
                    <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} maxLength={500} />
                    <span className="note">PAR emails this note from the PAR platform. It stays off the NFT.</span>
                  </label>
                  <button type="button" disabled={busy || !message.trim()} onClick={() => void sendNote()}>
                    {busy ? "Sending…" : "Send the note"}
                  </button>
                  {signed.otherSubscribed ? null : <p className="note">PAR keeps the note until the other person subscribes, then sends it.</p>}
                </>
              ) : null}
            </>
          )}
        </>
      )}
      {note ? <p className="note">{note}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </article>
  );
}
