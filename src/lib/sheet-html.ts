function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The sentence a wallet shows under the picture, and the first lines of the sheet. */
export function sheetLead(input: {
  name: string;
  tokenName: string;
  symbol: string;
  mint: string;
  soldThrough: string;
  salePage: string;
  attached: boolean;
}): string {
  const token = input.attached
    ? `The token ${input.tokenName} (${input.symbol}) pays for this title. Token address ${input.mint}.`
    : `A buyer pays for this title in ${input.tokenName} (${input.symbol}). Token address ${input.mint}. The sale is a fixed price or a bid. The creator sets how long before it opens.`;
  return `${input.name}. ${token} The title is sold through ${input.soldThrough}. The sale page is ${input.salePage}.`;
}

/** The page a person reads when they open the sheet link on the NFT. */
export function sheetPageHtml(input: {
  name: string;
  tokenName: string;
  symbol: string;
  mint: string;
  soldThrough: string;
  salePage: string;
  pool: string;
  pathLine: string;
  rows: [string, string][];
  promises: string[];
  imageUrl: string;
  attached: boolean;
}): string {
  const sale = input.salePage.startsWith("https://")
    ? `<a href="${escapeHtml(input.salePage)}">Open the sale page</a>`
    : escapeHtml(input.salePage);
  const image = input.imageUrl.startsWith("https://")
    ? `<img src="${escapeHtml(input.imageUrl)}" alt="${escapeHtml(input.name)}" />`
    : "";
  const sections = input.rows
    .map(([title, body]) => `<section><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></section>`)
    .join("\n");
  const promises = input.promises.map((line) => `<li>${escapeHtml(line)}</li>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.name)}</title>
<style>
  body { margin: 0; background: #f4f1eb; color: #1c1c1c; font: 17px/1.55 Georgia, "Times New Roman", serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; background: #fff; }
  .mark { margin: 0; font: 600 12px/1 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #6b6560; }
  h1 { margin: 0.35rem 0 1rem; font-size: 2rem; font-weight: 500; }
  h2 { margin: 1.4rem 0 0.25rem; font-size: 1.05rem; font-weight: 600; }
  img { display: block; max-width: 100%; height: auto; margin: 0 0 1.25rem; }
  a { color: #1c1c1c; }
  dl { display: grid; grid-template-columns: 8.5rem 1fr; gap: 0.35rem 1rem; margin: 1rem 0 0; }
  dt { color: #6b6560; }
  dd { margin: 0; overflow-wrap: anywhere; }
  p, li { overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<p class="mark">PAR record</p>
<h1>${escapeHtml(input.name)}</h1>
${image}
<p>${input.attached ? "This picture is the record image. The coin keeps the image it was created with." : "This picture is the record image."}</p>
<p>${escapeHtml(sheetLead(input))}</p>
<p>${sale}. ${escapeHtml(input.pathLine)}</p>
<dl>
<dt>Token</dt><dd>${escapeHtml(input.tokenName)} (${escapeHtml(input.symbol)})</dd>
<dt>Token address</dt><dd>${escapeHtml(input.mint)}</dd>
<dt>Sold through</dt><dd>${escapeHtml(input.soldThrough)}</dd>
<dt>Sale page</dt><dd>${sale}</dd>
<dt>Pool</dt><dd>${escapeHtml(input.pool)}</dd>
</dl>
${sections}
<h2>Creator promises</h2>
<ol>
${promises}
</ol>
</main>
</body>
</html>`;
}
