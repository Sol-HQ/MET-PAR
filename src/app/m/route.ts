export function GET(request: Request) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("n") || "Token").slice(0, 32);
  const symbol = (url.searchParams.get("s") || "TOKEN").slice(0, 10);
  const image = url.searchParams.get("i") || "";
  const description = url.searchParams.get("d") || `${name} listed on PAR.`;
  return Response.json(
    { name, symbol, description, image },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    },
  );
}
