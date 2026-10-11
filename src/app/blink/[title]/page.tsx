import type { Metadata } from "next";
import { BlinkPurchase } from "@/components/BlinkPurchase";
import type { ClusterName } from "@/lib/constants";
import { PUBLIC_ORIGIN } from "@/lib/record";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ title: string }>;
  searchParams: Promise<{ c?: string }>;
}): Promise<Metadata> {
  const [{ title }, query] = await Promise.all([params, searchParams]);
  const cluster: ClusterName = query.c === "devnet" ? "devnet" : "mainnet-beta";
  const salePath = `/t/${encodeURIComponent(title)}${cluster === "devnet" ? "?c=devnet" : ""}`;
  return {
    title: "Buy title on PAR",
    description: "Review the live Tensor listing and buy the title NFT with your Solana wallet.",
    alternates: { canonical: `${PUBLIC_ORIGIN}${salePath}` },
    openGraph: {
      type: "website",
      siteName: "PAR",
      title: "Buy title on PAR",
      description: "Review the live Tensor listing and buy the title NFT with your Solana wallet.",
      url: `${PUBLIC_ORIGIN}${salePath}`,
      images: [`${PUBLIC_ORIGIN}/share.png`],
    },
    twitter: { card: "summary_large_image", title: "Buy title on PAR", images: [`${PUBLIC_ORIGIN}/share.png`] },
  };
}

export default async function BlinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ title: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const [{ title }, query] = await Promise.all([params, searchParams]);
  const cluster: ClusterName = query.c === "devnet" ? "devnet" : "mainnet-beta";
  return (
    <main className="blink-shell">
      <BlinkPurchase title={title} pageCluster={cluster} />
    </main>
  );
}
