"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { isAdminWallet } from "@/lib/admins";
import type { ClusterName } from "@/lib/constants";
import { handoffCloseMs, handoffEndsAt, handoffMessage, PLATFORM_MAIL, readBuyerCard, type BuyerCard, type HandoffPublic } from "@/lib/handoff-message";
import { bytesToBase64 } from "@/lib/picture";

type DeskNote = { from: "seller" | "buyer"; body: string; at: string; mail?: "pending" | "sent" | "wait" | "skip" };
type Letter = {
  kind: string;
  side: "sale" | "purchase";
  subject: string;
  body: string;
  status: "sent" | "idle" | "retry";
  note: string;
  at: string;
};
type Proof = { body: string; at: string };

type Signed = HandoffPublic & {
  role: "creator" | "holder" | "admin";
  email: string | null;
  sellerMail: string | null;
  buyerMail: string | null;
  mine: string;
  mineAt: string | null;
  theirs: string;
  theirsAt: string | null;
  proofs: { buyer: Proof | null; seller: Proof | null };
  otherSubscribed: boolean;
  notes: DeskNote[];
  mailFrom: string | null;
  mailReady: boolean;
  mailAt: string | null;
  letters: Letter[];
  notice: "sent" | "saved" | "same" | "stopped" | "wait" | null;
};

const ALREADY_SUBSCRIBED = "You've already subscribed with this email. If you'd like to change it, resubscribe.";

function sameSubscription(onFile: string | null | undefined, typed: string): boolean {
  const saved = (onFile || "").trim().toLowerCase();
  const next = typed.trim().toLowerCase();
  return Boolean(saved) && saved === next;
}

function letterState(status: Letter["status"]): string {
  if (status === "sent") return "Sent";
  if (status === "retry") return "Not sent yet";
  return "Not sent";
}

function ContactProof({ card, at, who }: { card: BuyerCard; at: string; who: string }) {
  return (
    <div>
      <p>
        {who} left contact{at ? ` ${when(at)}` : ""}
      </p>
      {card.name ? <p>Name: {card.name}</p> : null}
      {card.address ? <p className="handoff-address">Mailing address: {card.address}</p> : null}
      <p>Email: {card.email}</p>
    </div>
  );
}

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
        <p className="handoff-clock">{view.handoffDays ? `${unit(view.handoffDays, "day", "days")} (GFD)` : "Handoff"}</p>
        <p className="note">
          {view.handoffDays
            ? "Good faith delivery. By this day the seller does their best to put the object in the mail, with a shipper, or in the holder's hands. Time with the carrier or customs does not count. Once it is in the mail and in transit, the seller is not liable for a mistake in the mail, a wrong delivery, or a holder who received it and says they did not. The clock starts when a buyer holds the title."
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
        {left > 0 ? remain(left) : "The good faith date has passed"}
      </p>
      <p className="note">
        {left <= 0
          ? "The good faith date has passed. Once the object is in the mail and in transit, the seller is not liable for a mistake in the mail, a wrong delivery, or a holder who received it and says they did not."
          : close
            ? "The good faith date is close. By that day the seller does their best to put the object in the mail, with a shipper, or in the holder's hands. Once it is in transit, the seller is not liable for a mistake in the mail."
            : `${unit(view.handoffDays, "day", "days")} (GFD). By that day the seller does their best to put the object in the mail, with a shipper, or in the holder's hands. Time with the carrier or customs does not count. Once it is in transit, the seller is not liable for a mistake in the mail.`}
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
    if (kind === "read" || kind === "reach") setLine(body.mine || "");
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
      if (agree && sameSubscription(signed?.email, email)) {
        setNote(ALREADY_SUBSCRIBED);
        return;
      }
      const body = await post("mail", agree ? `subscribe\n${email.trim()}` : "stop");
      if (body.notice === "sent") setNote(`PAR sent a confirmation as ${body.mailFrom || "the PAR platform"}. A copy goes to the platform inbox.`);
      else if (body.notice === "same") setNote(ALREADY_SUBSCRIBED);
      else if (body.notice === "stopped") setNote("Those PAR emails will stop.");
      else setNote(`The address is on file. ${body.mailReady ? "The confirmation was not accepted by the mail service." : "The mail key is not on this site yet, so the letter is recorded and not delivered."}`);
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
      if (!email.trim()) throw new Error("Enter your email, then press Send.");
      const sentText = [buyerName.trim(), buyerAddress.trim(), firstMessage.trim()].filter(Boolean).join(" ");
      const body = await post(
        "buyer",
        JSON.stringify({
          name: buyerName.trim(),
          address: buyerAddress.trim(),
          email: email.trim(),
          message: firstMessage.trim(),
          subscribe: true,
        }),
      );
      setFirstMessage("");
      if (body.notice === "same") setNote("That is already on the handoff card.");
      else if (sentText) setNote("Sent. It is on the handoff card with the time. The seller receives it by email through the PAR platform.");
      else setNote("Your email is on file. The seller does not see it. Write a message and press Send when you want the seller to receive it.");
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
  const party = signed?.role === "creator" || signed?.role === "holder";
  const buyerOpen = Boolean(signed?.role === "holder" && signed.place === "held" && !mailOnly);
  const buyerProof = signed?.proofs.buyer ? readBuyerCard(signed.proofs.buyer.body) : null;
  const sellerProof = signed?.proofs.seller?.body ?? "";
  const admin = isAdminWallet(wallet);
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
            <li>Before a list, the seller can subscribe with a private email, and can leave a contact line. That line can be an email or a phone number. Until a buyer holds the title, only the seller and an admin see it. The subscription address stays private.</li>
            <li>When a buyer holds the title, PAR emails the seller to check this sale page. The buyer signs in with that wallet and sees the seller's contact line, and every message sent or waiting, with the time.</li>
            <li>The buyer enters a private email and presses Send. A message is optional. Send is what tells the seller. The two addresses do not have to be shared. PAR carries the message.</li>
            <li>Later messages work the same way. Each person writes and presses Send. The handoff card keeps each one with the time, and says whether it was emailed.</li>
            <li>When the good faith date runs close, PAR emails the seller once. Those days are the best effort to get the object into the mail or into the holder's hands. Once it is in the mail and in transit, the seller is not liable for a mistake in the mail, a wrong delivery, or a holder who received it and says they did not.</li>
          </ol>
        </>
      )}
      {buyerOpen ? (
        <>
          <h3>Send to the seller</h3>
          {sellerProof ? (
            <p>The seller wrote{signed?.proofs.seller?.at ? ` ${when(signed.proofs.seller.at)}` : ""}: {sellerProof}</p>
          ) : (
            <p className="note">The seller has not left a contact line yet. You can still send.</p>
          )}
          <label>
            Your email
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" maxLength={120} />
            <span className="note">Private. The seller does not see this address. PAR uses it to send you replies. {PLATFORM_MAIL} is the platform copy, so use your own.</span>
          </label>
          <label>
            Name
            <input value={buyerName} onChange={(event) => setBuyerName(event.target.value)} autoComplete="name" maxLength={80} />
          </label>
          <label>
            Mailing address
            <textarea value={buyerAddress} onChange={(event) => setBuyerAddress(event.target.value)} rows={3} maxLength={220} autoComplete="street-address" />
          </label>
          <label>
            Message
            <textarea value={firstMessage} onChange={(event) => setFirstMessage(event.target.value)} rows={4} maxLength={500} />
            <span className="note">Optional. This is what the seller sees. You can include a shipping address, a phone number, or an email. You can also leave it blank and only keep your private email on file.</span>
          </label>
          <button type="button" className="solid" disabled={busy || !wallet || !email.trim()} onClick={() => void leaveBuyer()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </>
      ) : null}
      {!signed ? (
        <button type="button" className="solid" disabled={busy || !wallet} onClick={() => void open()}>
          {busy
            ? "Waiting for the wallet…"
            : wallet
              ? admin
                ? "Sign in as admin to read this handoff"
                : shown?.place === "held"
                  ? "Sign in with the wallet that holds the title"
                  : "Sign in to this handoff"
              : shown?.place === "held"
                ? "Connect the wallet that holds the title"
                : "Connect the creator wallet or the holder wallet"}
        </button>
      ) : (
        <>
          {(sale && signed.email) || signed.role === "admin" ? (
            <div className="record-promises">
              <p className="eyebrow">Handoff card</p>
              <p>
                Copies and replies go to {PLATFORM_MAIL}. The buyer does not see your subscription address. The buyer sees this card after that wallet holds the title.
              </p>
              <p>
                On file: {signed.role === "admin" ? signed.sellerMail || "no seller address yet" : signed.email}
                {signed.role !== "admin" && signed.mailAt ? ` since ${when(signed.mailAt)}` : ""}.{" "}
                {(signed.role === "admin" ? signed.sellerMail : signed.email)?.toLowerCase() === PLATFORM_MAIL
                  ? "This inbox is also the platform inbox, so each message arrives once."
                  : `A copy of each message also goes to ${PLATFORM_MAIL}.`}
              </p>
              <p>
                Messages leave as {signed.mailFrom || `PAR platform <${PLATFORM_MAIL}>`}.{" "}
                {signed.mailReady
                  ? "Mail is connected."
                  : "The mail key is not on this site yet, so a letter is recorded here and is not delivered."}
              </p>
              {sellerProof ? (
                <p>Saved handoff line{signed.proofs.seller?.at ? ` ${when(signed.proofs.seller.at)}` : ""}: {sellerProof}</p>
              ) : (
                <p>No handoff line is saved yet.</p>
              )}
              <h3>Letters</h3>
              {signed.letters?.length ? (
                <ul className="handoff-notes">
                  {signed.letters.map((item, index) => (
                    <li key={`${item.at}-${index}`}>
                      <span className="note">
                        {when(item.at)} · {item.side === "sale" ? "To the seller" : "To the buyer"} · {letterState(item.status)}
                      </span>
                      <p>{item.subject}</p>
                      {item.note ? <p className="note">{item.note}</p> : null}
                      {item.body ? <p>{item.body}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note">No letter has been written yet. The address on file stays. A letter is written the next time PAR sends.</p>
              )}
            </div>
          ) : null}
          {signed.role === "holder" && signed.place === "held" ? (
            <div className="record-promises">
              <p className="eyebrow">Handoff card</p>
              <p>Copies and replies go to {PLATFORM_MAIL}. Purchase messages leave from the PAR platform.</p>
              {sellerProof ? <p>The seller wrote: {sellerProof}</p> : <p className="note">The seller has not left a line yet.</p>}
              <h3>Letters</h3>
              {signed.letters?.length ? (
                <ul className="handoff-notes">
                  {signed.letters.map((item, index) => (
                    <li key={`${item.at}-${index}`}>
                      <span className="note">
                        {when(item.at)} · {item.side === "sale" ? "To the seller" : "To the buyer"} · {letterState(item.status)}
                      </span>
                      <p>{item.subject}</p>
                      {item.body ? <p>{item.body}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note">No letter has been written yet.</p>
              )}
            </div>
          ) : null}
          {sale ? (
            <>
              <label className="agree">
                <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} />
                <span>I want email from the PAR platform about this sale.</span>
              </label>
              <label>
                Email for this sale
                <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" maxLength={120} />
                {sameSubscription(signed.email, email) ? (
                  <span className="note">{ALREADY_SUBSCRIBED}</span>
                ) : (
                  <span className="note">Private. Use your own email. The buyer does not see this address. Copies and replies go to {PLATFORM_MAIL}. Messages leave as PAR platform &lt;platform@meteora.surf&gt;.</span>
                )}
              </label>
              <button type="button" disabled={busy || (agree && !email.trim())} onClick={() => void saveMail()}>
                {busy ? "Saving…" : !agree ? "Stop PAR email" : sameSubscription(signed.email, email) ? "Subscribed" : signed.email ? "Resubscribe" : "Subscribe to sale email"}
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
                    <span className="note">An email or a phone number. Until a buyer holds the title, only you and an admin see this. After that, the buyer sees this line. Your subscription email stays private. Leave it blank and save to clear it.</span>
                  </label>
                  <button type="button" disabled={busy} onClick={() => void saveLine()}>
                    {busy ? "Saving…" : "Save the handoff line"}
                  </button>
                </>
              ) : null}
              <h3>Between the two wallets</h3>
              <p className="note">Only the seller wallet, the buyer wallet, the PAR platform, and an admin can see these.</p>
              {buyerProof && signed.proofs.buyer ? (
                <ContactProof card={buyerProof} at={signed.proofs.buyer.at} who="The buyer" />
              ) : signed.proofs.buyer ? (
                <p>
                  The buyer wrote{signed.proofs.buyer.at ? ` ${when(signed.proofs.buyer.at)}` : ""}: {signed.proofs.buyer.body}
                </p>
              ) : signed.place === "held" ? (
                <p className="note">The buyer has not left contact yet.</p>
              ) : (
                <p className="note">The buyer's contact shows here after that wallet holds the title.</p>
              )}
              {sellerProof ? (
                <p>
                  Saved handoff line{signed.proofs.seller?.at ? ` ${when(signed.proofs.seller.at)}` : ""}: {sellerProof}
                </p>
              ) : sale ? (
                <p className="note">No handoff line is saved yet. The box above keeps what you type until you press Save the handoff line.</p>
              ) : (
                <p className="note">The seller has not left a line yet.</p>
              )}
              {signed.role === "admin" ? (
                <p className="note">
                  Sale email on file: {signed.sellerMail || "none"}. Purchase email on file: {signed.buyerMail || "none"}.
                </p>
              ) : null}
              {signed.place === "held" ? (
                <>
                  {signed.notes.length ? (
                    <ul className="handoff-notes">
                      {signed.notes.map((item, index) => (
                        <li key={`${item.at}-${index}`}>
                          <span className="note">
                            {item.from === "seller" ? "Seller" : "Buyer"}
                            {item.at ? ` · ${when(item.at)}` : ""}
                            {item.mail === "sent" ? " · Emailed" : item.mail === "wait" ? " · Not emailed yet" : item.mail ? " · Not emailed" : ""}
                          </span>
                          <p>{item.body}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note">No notes yet.</p>
                  )}
                  {party ? (
                    <>
                      <label>
                        {sale ? "Note to the buyer" : "Note to the seller"}
                        <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} maxLength={500} />
                        <span className="note">
                          {sale
                            ? "When you ship, write the tracking number here, and the insurance if you bought it. PAR emails this note to the buyer. PAR strongly recommends tracking on every shipment, and insurance as well when the object is over $100. Once it is in the mail and in transit, you are not liable for a mistake in the mail, a wrong delivery, or a holder who received it and says they did not."
                            : "PAR emails this note from the PAR platform. The other wallet sees it here after signing in. It stays off the NFT and off the public page."}
                        </span>
                      </label>
                      <button type="button" disabled={busy || !message.trim()} onClick={() => void sendNote()}>
                        {busy ? "Sending…" : "Send"}
                      </button>
                      {signed.otherSubscribed ? null : <p className="note">PAR keeps the note until the other person subscribes, then sends it.</p>}
                    </>
                  ) : null}
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
