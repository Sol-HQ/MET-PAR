"use client";

import { useEffect, useState, type ReactNode } from "react";
import { explorerAccount, type ClusterName } from "@/lib/constants";
import { shortAddress } from "@/lib/format";

/** A trait chip. With `address`, the value links to that account on the explorer. */
export type NftTrait = { type: string; value: string; address?: string };
export type NftDetail = { label: string; value: string; address?: string };
export type NftPrice = { label: string; amount: string; symbol: string; note?: string };

/** ar:// and ipfs:// links are opened through public gateways, the same way the share card reads them. */
function artUrl(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (trimmed.startsWith("ar://")) return `https://arweave.net/${trimmed.slice(5)}`;
  if (trimmed.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${trimmed.slice(7)}`;
  return trimmed;
}

function networkName(cluster: ClusterName): string {
  return cluster === "devnet" ? "Devnet" : "Mainnet";
}

/**
 * A title in the PAR escrow shown the way a marketplace shows an NFT for sale: the artwork, its name and collection,
 * the price, its on-chain traits, and its accounts. Display only. The buy itself is `children`, the page's existing
 * escrow panel, unchanged. Any field the chain did not give is left out, never filled in.
 */
export function NftListingCard({
  cluster,
  image,
  name,
  collectionName,
  edition,
  standard,
  status,
  live,
  seller,
  price,
  traits,
  details,
  children,
}: {
  cluster: ClusterName;
  image?: string | null;
  name: string;
  collectionName?: string | null;
  edition?: number | null;
  standard?: string;
  status: string;
  /** True while a buyer can act now. */
  live: boolean;
  /** The wallet that listed the title in the escrow. */
  seller: string;
  price?: NftPrice | null;
  traits: NftTrait[];
  details: NftDetail[];
  children?: ReactNode;
}) {
  const src = artUrl(image);
  const [failed, setFailed] = useState(!src);
  useEffect(() => setFailed(!src), [src]);
  const statusText = status.replace(/\.$/, "");
  const subtitle = [collectionName || "", edition ? `Edition #${edition}` : ""].filter(Boolean);

  return (
    <article className="nft-listing" aria-label={`${name} NFT listing`}>
      <figure className="nft-listing-art">
        {!failed ? (
          <img src={src} alt={name} loading="eager" onError={() => setFailed(true)} />
        ) : (
          <div className="nft-listing-art-empty" role="img" aria-label="No artwork could be shown">
            <span className="nft-listing-art-mark" aria-hidden="true">
              {name.trim().charAt(0).toUpperCase() || "·"}
            </span>
            <span>{src ? "The artwork did not load." : "No artwork is stored for this NFT."}</span>
          </div>
        )}
        {edition ? <figcaption className="nft-listing-edition">#{edition}</figcaption> : null}
      </figure>

      <div className="nft-listing-head">
        {subtitle.length ? <p className="nft-listing-collection">{subtitle.join(" · ")}</p> : null}
        <h2 className="nft-listing-name">{name}</h2>
        <div className="nft-listing-badges">
          <span className="nft-badge nft-badge-escrow">Listed in PAR escrow ({networkName(cluster)})</span>
          <span className={`nft-badge nft-badge-state${live ? " nft-badge-live" : ""}`}>
            {live ? <i aria-hidden="true" /> : null}
            {statusText}
          </span>
          {standard ? <span className="nft-badge nft-badge-quiet">{standard}</span> : null}
        </div>
        <p className="nft-listing-seller">
          Seller{" "}
          <a href={explorerAccount(seller, cluster)} target="_blank" rel="noreferrer" title={seller}>
            {shortAddress(seller)}
          </a>
        </p>
        {price ? (
          <div className="nft-listing-price">
            <span className="nft-listing-price-label">{price.label}</span>
            <span className="nft-listing-price-figure">
              {price.amount} <small>{price.symbol}</small>
            </span>
            {price.note ? <span className="nft-listing-price-note">{price.note}</span> : null}
          </div>
        ) : null}
      </div>

      {children ? (
        <section className="nft-listing-buy nft-listing-action" aria-label="Buy">
          {children}
        </section>
      ) : null}

      {traits.length ? (
        <section className="nft-listing-section" aria-label="Traits">
          <h3>Traits</h3>
          <ul className="nft-traits">
            {traits.map((trait) => (
              <li key={`${trait.type}:${trait.value}`}>
                <span>{trait.type}</span>
                <strong>
                  {trait.address ? (
                    <a href={explorerAccount(trait.address, cluster)} target="_blank" rel="noreferrer" title={trait.address}>
                      {trait.value}
                    </a>
                  ) : (
                    trait.value
                  )}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {details.length ? (
        <section className="nft-listing-section" aria-label="Details">
          <h3>Details</h3>
          <dl className="nft-details">
            {details.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.address ? (
                    <a href={explorerAccount(row.address, cluster)} target="_blank" rel="noreferrer" title={row.address}>
                      {row.value}
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </article>
  );
}
