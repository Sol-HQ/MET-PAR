/** Turns a wallet or Solana failure into one sentence. Anchor programs put that sentence in the logs. */
export function explainTx(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const logs = collectLogs(cause);
  const onChain = Boolean(cause && typeof cause === "object" && "onChain" in cause && (cause as { onChain?: boolean }).onChain);
  const tail = onChain ? "The network fee was spent." : "Nothing was sent.";
  if (/user rejected|rejected the request|user (cancelled|canceled)|approval denied/i.test(message)) {
    return "You closed the wallet. Nothing was sent.";
  }
  if (/block height exceeded|blockhash not found|transaction expired/i.test(message)) {
    return "The transaction expired before a block included it. The SOL stayed in the wallet. Sign it again.";
  }
  const anchor = anchorSentence(logs);
  if (anchor) return `${anchor} ${tail}`;
  const blob = `${message}\n${logs.join("\n")}`;
  if (/slippage/i.test(blob)) return `The price moved past the slippage you set. ${tail}`;
  if (/insufficient lamports|insufficient funds|attempt to debit an account/i.test(blob)) {
    return `The wallet does not hold enough for this transaction. ${tail}`;
  }
  const code = customCode(cause, message);
  if (code !== null) {
    if (code === 1 && /TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA/.test(blob)) {
      return `The wallet does not hold enough of that token. ${tail}`;
    }
    return `The program refused the transaction (error ${code}). ${tail}`;
  }
  if (message.startsWith("The wallet") || message.startsWith("The network returned") || message.startsWith("Jito did not")) {
    return message;
  }
  const logLine = logs.find((line) => /error|failed|insufficient/i.test(line) && line.length < 180);
  if (logLine) {
    const clean = logLine.replace(/^Program log: /, "").replace(/^Program [A-Za-z0-9]+ failed: /, "");
    return `${clean} ${tail}`;
  }
  if (message && message.length < 180 && !/simulation failed|logs:/i.test(message)) return message;
  return onChain ? "The transaction landed and the program rejected it. The network fee was spent." : "The transaction was not sent.";
}

function collectLogs(cause: unknown): string[] {
  const logs: string[] = [];
  if (cause && typeof cause === "object" && "logs" in cause && Array.isArray((cause as { logs: unknown }).logs)) {
    for (const line of (cause as { logs: unknown[] }).logs) {
      if (typeof line === "string") logs.push(line);
    }
  }
  const message = cause instanceof Error ? cause.message : "";
  for (const line of message.split("\n")) {
    if (line.includes("Program log:") || line.includes("Error Message:")) logs.push(line.trim());
  }
  return logs;
}

function anchorSentence(logs: string[]): string {
  for (const line of logs) {
    const message = /Error Message: (.+?)\.?$/.exec(line);
    if (!message) continue;
    const sentence = message[1].trim();
    if (!sentence) continue;
    return /[.!?]$/.test(sentence) ? sentence : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
  }
  return "";
}

function customCode(cause: unknown, message: string): number | null {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(message);
  if (hex) return Number.parseInt(hex[1], 16);
  const err = cause && typeof cause === "object" && "err" in cause ? (cause as { err: unknown }).err : null;
  const custom = /"Custom":\s*(\d+)/.exec(JSON.stringify(err ?? ""));
  return custom ? Number(custom[1]) : null;
}
