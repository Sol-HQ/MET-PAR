"use client";

import { useEffect, useState } from "react";
import { explorerAccount, type ClusterName } from "@/lib/constants";
import { parseRecordUri, type RecordCheck } from "@/lib/record";
import { railWords, salePath, type TitleStatus } from "@/lib/title";

type RecordBody = {
  record?: {
    address: string;
    status: "verified" | "mismatch" | "missing";
    vault: string;
    sheet: string;
    sheetFrom: string;
    pool: string;
    checks: RecordCheck[];
  };
  title?: TitleStatus | null;
};

type SheetWords = { claim: string; terms: string; handoff: string; maker: string };

export function RecordPanel({ uri, mint, pool, cluster }: { uri: string; mint: string; pool: string; cluster: ClusterName }) {
  const link = parseRecordUri(uri);
  const [body, setBody] = useState<RecordBody | null>(null);
  const [words, setWords] = useState<SheetWords | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    const url = new URL(uri);
    void fetch(`${url.pathname}${url.search}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("record");
        const loaded = (await response.json()) as RecordBody;
        if (cancelled) return;
        setBody(loaded);
        if (loaded.record?.sheet) {
          const sheet = (await fetch(loaded.record.sheet).then((item) => item.json())) as {
            record?: { claim?: { text?: string }; redemption?: { ifClaimGoesWrong?: string; handoff?: string }; maker?: { name?: string; role?: string } };
          };
          if (!cancelled) {
            setWords({
              claim: sheet.record?.claim?.text ?? "",
              terms: sheet.record?.redemption?.ifClaimGoesWrong ?? "",
              handoff: sheet.record?.redemption?.handoff ?? "",
              maker: [sheet.record?.maker?.name, sheet.record?.maker?.role].filter(Boolean).join(". "),
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!link) return null;
  const record = body?.record;
  const checks = record
    ? [
        ...record.checks,
        { label: "The record names this pool", ok: record.pool === pool },
        { label: "The token link names this mint", ok: link.mint === mint },
      ]
    : [];

  return (
    <article className="card record-create">
      <p className="eyebrow">Asset record</p>
      <h2>
        {record?.status === "verified"
          ? "The record and the token match"
          : record?.status === "missing"
            ? "The record is missing"
            : record
              ? "The record does not match"
              : failed
                ? "The record could not be read"
                : "Reading the record…"}
      </h2>
      {record?.status === "missing" ? (
        <p className="error">
          This token names record {link.asset}, and that record was never minted. Without the record this token is
          only half of the asset.
        </p>
      ) : null}
      {checks.length > 0 ? (
        <ul className="record-checks">
          {checks.map((check) => (
            <li key={check.label} className={check.ok ? "ok" : "no"}>
              {check.label}
            </li>
          ))}
        </ul>
      ) : null}
      {body?.title ? (
        <>
          <p className="eyebrow">Title</p>
          <p className="note">
            The title is the one NFT that sells, and only for this token. It is held by the {railWords(body.title.rail)}.{" "}
            <a href={salePath(body.title.address, cluster)}>Open the sale page</a>.
          </p>
          <ul className="record-checks">
            {body.title.checks.map((check) => (
              <li key={check.label} className={check.ok ? "ok" : "no"}>
                {check.label}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {words ? (
        <dl>
          <div>
            <dt>Responsible</dt>
            <dd>{words.maker}</dd>
          </div>
          <div>
            <dt>Claim</dt>
            <dd>{words.claim}</dd>
          </div>
          <div>
            <dt>Handoff</dt>
            <dd>{words.handoff}</dd>
          </div>
          <div>
            <dt>If a claim goes wrong</dt>
            <dd className="asset-terms">{words.terms}</dd>
          </div>
        </dl>
      ) : null}
      <p className="note">
        <a href={explorerAccount(link.asset, cluster)} target="_blank" rel="noreferrer">
          Record on the explorer
        </a>
        {record?.sheet ? (
          <>
            {" · "}
            <a href={record.sheet} target="_blank" rel="noreferrer">
              Full record sheet on Arweave
            </a>
          </>
        ) : null}
        . These words locked with the record. PAR does not hold the object, the tokens, or any payment. The person
        named here owes what the card says.
      </p>
    </article>
  );
}
