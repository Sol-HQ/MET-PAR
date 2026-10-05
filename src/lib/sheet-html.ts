function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The page a person reads when they open the sheet link on the NFT. */
export function sheetPageHtml(input: {
  name: string;
  pathLine: string;
  rows: [string, string][];
  promises: string[];
  imageUrl: string;
}): string {
  const sections = input.rows
    .map(([title, body]) => `<section><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></section>`)
    .join("\n");
  const promises = input.promises.map((line) => `<li>${escapeHtml(line)}</li>`).join("\n");
  const image = input.imageUrl.startsWith("https://")
    ? `<img src="${escapeHtml(input.imageUrl)}" alt="${escapeHtml(input.name)}" />`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.name)}</title>
<style>
  body { font: 18px/1.5 Georgia, serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  img { max-width: 100%; height: auto; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.05rem; margin-bottom: 0.2rem; }
  p, li { white-space: pre-wrap; }
</style>
</head>
<body>
<h1>${escapeHtml(input.name)}</h1>
<p>${escapeHtml(input.pathLine)}</p>
${image}
<p>This picture is the token image and the record image.</p>
${sections}
<h2>Creator promises</h2>
<ol>
${promises}
</ol>
</body>
</html>`;
}
