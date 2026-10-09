import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";
import { PUBLIC_ORIGIN } from "@/lib/record";
import "./globals.css";

const display = Inter({
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

const description = "Buyers fill most of the sale within 10% of one price. Then the pool locks.";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_ORIGIN),
  title: "PAR",
  description,
  openGraph: {
    title: "PAR",
    description,
    url: PUBLIC_ORIGIN,
    siteName: "PAR",
    type: "website",
    images: [{ url: "/share.png", width: 1024, height: 827, alt: "PAR" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PAR",
    description,
    images: ["/share.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable}`}>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
