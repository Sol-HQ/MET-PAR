export type TokenMetadataFields = {
  name: string;
  symbol: string;
  image: string;
  description: string;
};

export function buildMetadataUri(origin: string, fields: TokenMetadataFields): string {
  const url = new URL("/m", origin);
  url.searchParams.set("n", fields.name);
  url.searchParams.set("s", fields.symbol);
  if (fields.image) url.searchParams.set("i", fields.image);
  if (fields.description) url.searchParams.set("d", fields.description);
  return url.toString();
}

export function metadataUriForChain(origin: string, fields: TokenMetadataFields): string {
  const withDescription = buildMetadataUri(origin, fields);
  if (withDescription.length <= 200) return withDescription;
  const withoutDescription = buildMetadataUri(origin, { ...fields, description: "" });
  if (withoutDescription.length <= 200) return withoutDescription;
  throw new Error(
    `Metadata link is ${withoutDescription.length} characters. The chain allows 200. Use a shorter image link.`,
  );
}
