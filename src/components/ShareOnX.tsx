type ShareOnXProps = {
  name: string;
  description: string;
  url: string;
};

export function ShareOnX({ name, description, url }: ShareOnXProps) {
  const summary = `${name} — ${description}`.replace(/\s+/g, " ").trim();
  const text = summary.length > 200 ? `${summary.slice(0, 197).trimEnd()}…` : summary;
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);

  return (
    <div className="card-actions sale-share-actions">
      <a href={intent.toString()} target="_blank" rel="noreferrer" title="Share this RWA title and its sale page on X.">
        Share on X
      </a>
    </div>
  );
}
