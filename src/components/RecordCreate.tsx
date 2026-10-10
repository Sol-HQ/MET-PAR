"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type Draft } from "@/components/AssetDesk";
import { HandoffDesk } from "@/components/HandoffDesk";
import { MainnetGate, ReviewFile, reviewText } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import { explorerAccount, explorerTx } from "@/lib/constants";
import { bpsToPercent, formatLamports } from "@/lib/format";
import { METEORA_TRADING_FEE_PERCENT } from "@/lib/platform";
import {
  FREE_UPLOAD_BYTES,
  RECORD_KIND,
  RECORD_VAULT,
  arweaveUrl,
  keepArweaveId,
  recordAttributes,
  savedArweaveId,
  recordInstruction,
  sha256Hex,
} from "@/lib/record";
import { JITO_TIP_LAMPORTS, bytesWithDurableNonce, landingCost, prepareTransaction, sendPrepared, transactionBytes } from "@/lib/send";
import { readCoin, readPayToken, type CoinFacts, type PayFacts } from "@/lib/coin-read";
import { sheetLead, sheetPageHtml } from "@/lib/sheet-html";
import { parseTokenAmount } from "@/lib/tensor-sale";
import {
  AUCTION_EXTEND_HOURS,
  AUCTION_HOURS,
  AUCTION_SIT_DAYS,
  creatorPromises,
  ESCROW_PROGRAM,
  escrowDepositInstruction,
  promiseMessage,
  chosenRail,
  escrowDepositAllowed,
  railWords,
  SALE_PROGRAM_FEE_PERCENT,
  creatorSalePercent,
  poolPath,
  salePath,
  saleUrl,
  saleVenueWords,
  CREATOR_BURN_DAYS,
  ESCROW_PATH,
  TENSOR_TAKER_FEE_PERCENT,
  TENSOR_MARKETPLACE,
  TITLE_KIND,
  titleAttributes,
  titleInstructions,
  editionCollectionInstructions,
  type TitleRail,
} from "@/lib/title";

type Keys = { record: Keypair; title: Keypair; collection: Keypair };

type Plan = {
  keys: Keys;
  mint: string;
  pool: string;
  tokenName: string;
  symbol: string;
  par: string;
  poolPrice: string;
  wholeAtPar: string;
  supply: string;
  decimals: number;
  feeDecaySeconds: number;
  creatorFeePercent: number;
  config: string;
  noCoin: boolean;
  quoteSymbol: string;
  compoundingFeeBps: number;
  tokenUri: string;
  /** The coin's own picture. The record picture is a separate file. */
  coinImage: string;
  openingBps: number;
  endingBps: number;
  migrationFeeBps: number;
  platformFeePercent: number;
  quoteMint: string;
  rail: TitleRail;
  venue: string;
  promises: string[];
  lines: string[];
  /** Attribute keys dropped so the full sheet link still fits. The sheet link is never in this list. */
  omitRecord: string[];
  omitTitle: string[];
};

type Promise_ = { message: string; signature: string };

function burnOf(draft: Draft): number {
  const burn = Number(draft.burnPercent);
  if (!Number.isInteger(burn) || burn < 0 || burn > 98) {
    throw new Error("The burn is a whole percent from 0 to 98. The PAR program keeps 2%.");
  }
  return burn;
}

function titleName(assetName: string): string {
  return `${assetName} title`;
}

/** These lines are the proof. A mint that would leave one off stops. */
const LOCKED_ON_NFT = [
  "full sheet",
  "mint",
  "sale page",
  "sold through",
  "sheet sha256",
  "image sha256",
  "creator",
  "title held by",
  "held by",
  "title",
  "record",
  "coin",
  "pool",
  "sale opens",
  "paid in",
  "escrow program",
  "sale",
];

function field(rows: { key: string; value: string }[], key: string): string {
  return rows.find((row) => row.key === key)?.value ?? "";
}

/** Stops the mint when the sheet, the record, and the title would not say the same thing. */
function assertOneStory(input: {
  sheet: string;
  recordRows: { key: string; value: string }[];
  titleRows: { key: string; value: string }[];
  held: string;
  creator: string;
  mint: string;
  pool: string;
  record: string;
  title: string;
  coin: string;
  sheetSha256: string;
  imageSha256: string;
  imageUrl: string;
  sheetImageSha256: string;
  sheetImageUrl: string;
  htmlUrl: string;
  noCoin: boolean;
  saleOpens: string;
  delayDays: number;
}) {
  const parsed = JSON.parse(input.sheet) as {
    image?: string;
    record?: {
      creator?: string;
      address?: string;
      image?: { sha256?: string; arweave?: string };
      sheetImage?: { sha256?: string; arweave?: string };
      readableSheet?: string;
      token?: { mint?: string; pool?: string };
      title?: { address?: string; heldBy?: string; sale?: { opensDaysAfterGraduation?: number | null } };
    };
  };
  const story = parsed.record;
  const problems: string[] = [];
  const expect = (label: string, got: string, want: string) => {
    if (got !== want) problems.push(label);
  };
  expect("record holder", field(input.recordRows, "title held by"), input.held);
  expect("title holder", field(input.titleRows, "held by"), input.held);
  expect("sheet holder", story?.title?.heldBy || "", input.held);
  expect("record creator", field(input.recordRows, "creator"), input.creator);
  expect("title creator", field(input.titleRows, "creator"), input.creator);
  expect("sheet creator", story?.creator || "", input.creator);
  expect("record mint", field(input.recordRows, "mint"), input.mint);
  expect("title mint", field(input.titleRows, "mint"), input.mint);
  expect("sheet mint", story?.token?.mint || "", input.mint);
  expect("record pool", field(input.recordRows, "pool"), input.pool);
  expect("title pool", field(input.titleRows, "pool"), input.pool);
  expect("sheet pool", story?.token?.pool || "", input.pool);
  expect("record coin", field(input.recordRows, "coin"), input.coin);
  expect("title coin", field(input.titleRows, "coin"), input.coin);
  expect("record title", field(input.recordRows, "title"), input.title);
  expect("title record", field(input.titleRows, "record"), input.record);
  expect("sheet record", story?.address || "", input.record);
  expect("sheet title", story?.title?.address || "", input.title);
  expect("sheet hash", field(input.recordRows, "sheet sha256"), input.sheetSha256);
  expect("image hash", field(input.recordRows, "image sha256"), input.imageSha256);
  expect("nft image hash", story?.image?.sha256 || "", input.imageSha256);
  expect("picture", parsed.image || "", input.imageUrl);
  expect("nft picture", story?.image?.arweave || "", input.imageUrl);
  expect("sheet picture", story?.sheetImage?.arweave || "", input.sheetImageUrl);
  expect("sheet picture hash", story?.sheetImage?.sha256 || "", input.sheetImageSha256);
  expect("record sheet link", field(input.recordRows, "full sheet"), input.htmlUrl);
  expect("title sheet link", field(input.titleRows, "full sheet"), input.htmlUrl);
  expect("readable sheet", story?.readableSheet || "", input.htmlUrl);
  expect("sale opens", field(input.titleRows, "sale opens"), input.saleOpens);
  if (!input.noCoin && story?.title?.sale?.opensDaysAfterGraduation !== input.delayDays) problems.push("sale wait");
  if (problems.length) {
    throw new Error(`The record sheet and the NFTs do not say the same thing (${problems.join(", ")}). Nothing was minted.`);
  }
}

function keepSheet(rows: { key: string; value: string }[], omit: string[]) {
  const kept = rows.filter((row) => LOCKED_ON_NFT.includes(row.key) || !omit.includes(row.key));
  for (const row of rows) {
    if (LOCKED_ON_NFT.includes(row.key) && !kept.some((item) => item.key === row.key && item.value === row.value)) {
      throw new Error(`The NFT would leave off ${row.key}. That line stays.`);
    }
  }
  return kept;
}

/**
 * Price lines and the long description can come off the short on-chain list.
 * They stay on the Arweave sheet. The proof lines never come off.
 */
const DROP_BEFORE_SHEET = [
  "auction",
  "burned",
  "serial",
  "maker",
  "declared",
  "handoff days",
  "par",
  "pool price",
  "quote",
  "supply",
  "decimals",
  "vault",
];

type Progress = { label: string; done: boolean; link?: string };

async function waitForAccount(connection: Connection, key: PublicKey) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await connection.getAccountInfo(key, "confirmed")) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

function sheetJson(input: {
  draft: Draft;
  rows: [string, string][];
  plan: Plan;
  cluster: string;
  creator: string;
  vault: string;
  quoteMint: string;
  curveLines: string;
  image: { arweave: string; copy: string; sha256: string };
  sheetImage: { arweave: string; copy: string; sha256: string };
  promise: Promise_;
  htmlUrl: string;
}): string {
  const { draft, plan } = input;
  const mint = plan.mint;
  const symbol = plan.symbol;
  const shortClock = input.cluster === "devnet" && plan.rail === "escrow";
  const saleKind = plan.rail === "escrow" ? (draft.sale === "auction" ? "auction" : "fixed price") : "tensor";
  return JSON.stringify(
    {
      name: draft.assetName,
      description: `${sheetLead({
        name: draft.assetName,
        tokenName: plan.tokenName,
        symbol,
        mint,
        soldThrough: saleVenueWords(plan.rail),
        salePage: plan.venue,
        attached: !plan.noCoin,
      })}\n\n${draft.story}\n\nFull sheet: ${input.htmlUrl}`,
      image: input.image.arweave,
      external_url: input.htmlUrl,
      attributes: [
        { trait_type: "Full sheet", value: input.htmlUrl },
        { trait_type: "Token", value: symbol },
        { trait_type: "Token address", value: mint },
        { trait_type: "Sale page", value: plan.venue },
        { trait_type: "Sold through", value: saleVenueWords(plan.rail) },
        { trait_type: "Sale", value: saleKind },
        { trait_type: "Record", value: RECORD_KIND },
        { trait_type: "Title", value: plan.keys.title.publicKey.toBase58() },
        { trait_type: "Declared value", value: `${draft.declared} ${plan.quoteSymbol}` },
      ],
      properties: {
        category: "image",
        files: [
          { uri: input.image.arweave, type: "image/jpeg" },
          { uri: input.sheetImage.arweave, type: "image/jpeg" },
          { uri: input.htmlUrl, type: "text/html" },
        ],
      },
      record: {
        kind: RECORD_KIND,
        network: input.cluster,
        address: plan.keys.record.publicKey.toBase58(),
        vault: input.vault,
        creator: input.creator,
        token: {
          mint,
          name: plan.tokenName,
          symbol,
          decimals: plan.decimals,
          supply: plan.supply,
          uri: plan.tokenUri,
          image: plan.coinImage,
          pool: plan.pool,
          config: plan.config,
          quote: plan.quoteSymbol,
          quoteMint: input.quoteMint,
        },
        object: {
          name: draft.objectName,
          kind: draft.kind,
          serial: draft.serial.trim(),
          existsNow: draft.existsNow === "yes",
          holder: draft.holder,
          where: draft.where,
          story: draft.story,
        },
        maker: { name: draft.makerName.trim(), owes: draft.maker, role: draft.role, work: draft.work, marks: draft.marks },
        pitch: draft.pitch.trim(),
        claim: { text: draft.claim, claimedBy: "the holder of the title" },
        redemption: {
          handoffDays: draft.shipDays,
          handoff: draft.shipping,
          declaredValue: draft.declared,
          declaredUnit: plan.quoteSymbol,
          ifClaimGoesWrong: draft.terms,
        },
        curve: plan.noCoin
          ? { coin: "none" }
          : {
              par: plan.par,
              poolPrice: plan.poolPrice,
              supply: plan.supply,
              valueAtPar: `${plan.wholeAtPar} ${plan.quoteSymbol}`,
              locked: input.curveLines,
              openingFee: bpsToPercent(plan.openingBps),
              endingFee: bpsToPercent(plan.endingBps),
              feeDecaySeconds: plan.feeDecaySeconds,
              migrationFeeBps: plan.migrationFeeBps,
              compound: plan.compoundingFeeBps > 0,
              meteoraFeePercent: METEORA_TRADING_FEE_PERCENT,
              platformFeePercent: plan.platformFeePercent,
              creatorFeePercent: plan.creatorFeePercent,
            },
        title: {
          kind: TITLE_KIND,
          address: plan.keys.title.publicKey.toBase58(),
          heldBy: railWords(plan.rail),
          escrowProgram: plan.rail === "escrow" ? ESCROW_PROGRAM[input.cluster === "devnet" ? "devnet" : "mainnet-beta"] : null,
          sale: {
            page: plan.venue,
            kind: plan.rail === "escrow" ? (draft.sale === "auction" ? "auction" : "fixed price") : "tensor",
            soldThrough: saleVenueWords(plan.rail),
            soldThroughProgram: plan.rail === "escrow" ? ESCROW_PROGRAM[input.cluster === "devnet" ? "devnet" : "mainnet-beta"] : TENSOR_MARKETPLACE,
            payIn: mint,
            opensDaysAfterGraduation: plan.noCoin ? null : Number(draft.saleDays),
            opensUnit: plan.noCoin ? null : shortClock ? "seconds" : "days",
            burnPercent: plan.noCoin ? null : burnOf(draft),
            creatorPercent: plan.noCoin ? null : plan.rail === "escrow" ? creatorSalePercent(burnOf(draft)) : 100 - burnOf(draft),
            programPercent: plan.noCoin ? null : plan.rail === "escrow" ? SALE_PROGRAM_FEE_PERCENT : 0,
            price: draft.titlePrice.trim() ? `${draft.titlePrice.trim()} of this token` : "Set by the creator in this token.",
            burnedBy: plan.noCoin ? "the creator's own promise, if the creator burns any of the price" : plan.rail === "escrow" ? "the escrow program, at the sale" : `the creator, within ${CREATOR_BURN_DAYS} days of the sale`,
            auction:
              plan.rail === "escrow" && draft.sale === "auction"
                ? {
                    reserve: draft.titlePrice.trim() ? `${draft.titlePrice.trim()} of this token` : "",
                    clockStarts: "on the first bid at or above the reserve",
                    unit: shortClock ? "seconds" : "hours",
                    length: AUCTION_HOURS,
                    extend: shortClock ? 1 : AUCTION_EXTEND_HOURS,
                    sitWithoutBid: shortClock ? 60 : AUCTION_SIT_DAYS,
                    sitUnit: shortClock ? "seconds" : "days",
                    finish: "PAR platform sends the finish when the clock ends. The creator and the bidder do not send it.",
                  }
                : null,
          },
          promises: plan.promises,
          promise: { signedBy: input.creator, message: input.promise.message, signatureBase64: input.promise.signature },
        },
        sheet: input.rows.map(([title, body]) => ({ title, body })),
        image: input.image,
        sheetImage: input.sheetImage,
        readableSheet: input.htmlUrl,
      },
    },
    null,
    2,
  );
}

export function RecordCreate({
  draft,
  rows,
  picture,
  pictureCopy,
  nftPicture,
  nftPictureCopy,
  problem,
  curveLines,
  preparedKeys,
  coin,
  pay,
  onCreated,
}: {
  draft: Draft;
  rows: [string, string][];
  picture: Blob | null;
  pictureCopy: string;
  nftPicture: Blob | null;
  nftPictureCopy: string;
  problem: string;
  curveLines: string;
  preparedKeys: Keys;
  coin: CoinFacts | null;
  pay: PayFacts | null;
  onCreated?: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { cluster } = useCluster();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState<{ pool: string; record: string; title: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const vault = RECORD_VAULT[cluster];
  const rail = chosenRail(cluster, escrowDepositAllowed(cluster, wallet.publicKey?.toBase58()) ? draft.hold : "wallet");
  const previewPromises = creatorPromises({
    rail,
    delayDays: Number(draft.saleDays),
    burnPercent: burnOf(draft),
    handoffDays: draft.shipDays,
    sale: draft.sale,
    shortClock: cluster === "devnet" && rail === "escrow",
    attached: Boolean(coin),
    paySymbol: coin?.symbol || pay?.symbol || draft.symbol,
  });

  useEffect(() => {
    setPlan(null);
    setAgreed(false);
    setGateOpen(false);
  }, [draft, picture, nftPicture, cluster, coin, pay]);

  function mark(label: string, link?: string) {
    setProgress((current) => [...current, { label, done: true, link }]);
  }

  async function review() {
    setError("");
    setFinished(null);
    setProgress([]);
    setGateOpen(false);
    if (problem) {
      setError(problem);
      return;
    }
    if (!vault) {
      setError("The real network vault is not set yet. Records are made on the practice network only.");
      return;
    }
    if (!picture || !pictureCopy) {
      setError("Add the sheet picture on the Object step.");
      return;
    }
    if (!nftPicture || !nftPictureCopy) {
      setError("Add the NFT image on the Object step.");
      return;
    }
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signMessage) {
      setError("Connect a wallet that can sign transactions and messages.");
      return;
    }
    if (!agreed) {
      setError("Read and accept the creator promises first.");
      return;
    }
    setBusy(true);
    try {
      if (!coin && !pay) throw new Error("Paste the token address and read it before creating the title.");
      if (!coin && rail === "escrow") throw new Error("The escrow sells a title only in its own coin.");
      const read = coin ? await readCoin(connection, coin.mint) : null;
      const paid = read ? null : pay ? await readPayToken(connection, pay.mint) : null;
      if (!read && !paid) throw new Error("Paste the token address and read it before creating the title.");
      if (read && (read.mint !== coin?.mint || read.pool !== coin.pool)) {
        throw new Error("That token address is not the coin you read. Press Read this coin again.");
      }
      const keys: Keys = preparedKeys;
      const mint = read?.mint || paid?.mint || "";
      const pool = read?.pool || "none";
      const record = keys.record.publicKey.toBase58();
      const title = keys.title.publicKey.toBase58();
      const payerKey = wallet.publicKey;
      const creator = payerKey.toBase58();
      const venue = saleUrl(title, cluster);
      const attached = Boolean(read);
      const promises = creatorPromises({
        rail: attached ? rail : "creator",
        delayDays: Number(draft.saleDays),
        burnPercent: burnOf(draft),
        handoffDays: draft.shipDays,
        sale: draft.sale,
        shortClock: cluster === "devnet" && rail === "escrow",
        attached,
        paySymbol: read?.symbol || paid?.symbol,
      });
      const titlePrice = attached && rail === "escrow" ? parseTokenAmount(draft.titlePrice, read?.decimals) : null;
      if (attached && rail === "escrow" && !titlePrice) throw new Error("Type the title price in the token on the Claim step.");

      const draftPlan: Plan = {
        keys,
        mint,
        pool,
        tokenName: read?.name || paid?.name || "",
        symbol: read?.symbol || paid?.symbol || "",
        par: read?.startPrice || "none",
        poolPrice: read?.endPrice || "none",
        wholeAtPar: read?.wholeAtPar || "none",
        supply: read ? read.supply.replace(/,/g, "") : "none",
        decimals: read?.decimals ?? paid?.decimals ?? 6,
        feeDecaySeconds: read?.feeDecaySeconds ?? 0,
        creatorFeePercent: read?.creatorFeePercent ?? 0,
        config: read?.config || "none",
        noCoin: !read,
        quoteSymbol: read?.quoteSymbol || paid?.symbol || "",
        quoteMint: read?.quoteMint || paid?.mint || "",
        compoundingFeeBps: read?.compoundingFeeBps ?? 0,
        tokenUri: read?.uri || "",
        coinImage: read?.image || "",
        openingBps: read?.openingFeeBps ?? 0,
        endingBps: read?.endingFeeBps ?? 0,
        migrationFeeBps: read?.migrationFeeBps ?? 0,
        platformFeePercent: read?.platformFeePercent ?? 0,
        rail: attached ? rail : "creator",
        venue,
        promises,
        lines: [],
        omitRecord: [],
        omitTitle: [],
      };
      const sheetSlot = arweaveUrl("x".repeat(43));
      const sampleMessage = promiseMessage({ promises, record, title, mint, creator });
      const sample = sheetJson({
        promise: { message: sampleMessage, signature: "A".repeat(88) },
        draft,
        rows,
        plan: draftPlan,
        cluster,
        creator: wallet.publicKey.toBase58(),
        vault,
        quoteMint: draftPlan.quoteMint,
        curveLines,
        image: { arweave: sheetSlot, copy: nftPictureCopy, sha256: "0".repeat(64) },
        sheetImage: { arweave: sheetSlot, copy: pictureCopy, sha256: "0".repeat(64) },
        htmlUrl: sheetSlot,
      });
      const sheetBytes = new TextEncoder().encode(sample).length;
      if (sheetBytes > FREE_UPLOAD_BYTES) throw new Error("Your record sheet is over 105 KiB. Shorten the longest fields.");
      const htmlBytes = new TextEncoder().encode(
        sheetPageHtml({
          name: draft.assetName,
          tokenName: draftPlan.tokenName,
          symbol: draftPlan.symbol,
          mint,
          soldThrough: saleVenueWords(draftPlan.rail),
          salePage: venue,
          pool,
          pathLine: `${draftPlan.rail === "escrow" ? "PAR escrow" : "Tensor"} token ${mint}`,
          rows,
          promises,
          imageUrl: sheetSlot,
          nftImageUrl: arweaveUrl("y".repeat(43)),
          attached: !draftPlan.noCoin,
        }),
      ).length;
      if (htmlBytes > FREE_UPLOAD_BYTES) throw new Error("The readable sheet is over 105 KiB. Shorten the longest fields.");

      async function fitNft(
        label: string,
        rows: { key: string; value: string }[],
        build: (attributes: { key: string; value: string }[]) => Transaction,
        signer: Keypair,
      ) {
        if (!rows.some((row) => row.key === "full sheet")) throw new Error(`The ${label} is missing the full sheet link.`);
        const omitted: string[] = [];
        let current = rows;
        for (;;) {
          const prepared = await prepareTransaction(connection, payerKey, build(current), [signer], { tip: false });
          const raw = transactionBytes(prepared.transaction);
          const durable = bytesWithDurableNonce(prepared.transaction, payerKey);
          if (raw === null || durable === null) throw new Error(`The ${label} could not be measured.`);
          if (durable <= 1232) return { prepared, bytes: durable, omitted };
          const drop = DROP_BEFORE_SHEET.find((key) => current.some((row) => row.key === key));
          if (!drop || LOCKED_ON_NFT.includes(drop)) {
            if (raw <= 1232) return { prepared, bytes: raw, omitted };
            throw new Error(`The ${label} is ${raw} bytes. The limit is 1232. The proof lines stay on the NFT.`);
          }
          current = current.filter((row) => row.key !== drop);
          omitted.push(drop);
        }
      }

      const recordFit = await fitNft(
        "record",
        recordAttributes({
          mint,
          pool,
          vault,
          creator: payerKey.toBase58(),
          symbol: draftPlan.symbol,
          supply: draftPlan.supply,
          decimals: String(draftPlan.decimals),
          quote: draftPlan.quoteSymbol,
          par: draftPlan.par,
          poolPrice: draftPlan.poolPrice,
          handoffDays: draft.shipDays,
          declared: draft.declared,
          sheetSha256: "0".repeat(64),
          imageSha256: "0".repeat(64),
          title,
          titleHeldBy: railWords(rail),
          serial: draft.serial,
          makerName: draft.makerName,
          escrowProgram: rail === "escrow" ? ESCROW_PROGRAM[cluster] : undefined,
          sheet: sheetSlot,
          salePage: venue,
          soldThrough: saleVenueWords(rail),
          coin: coin ? "attached" : "none",
        }),
        (attributes) =>
          new Transaction().add(
            ...recordInstruction({
              endpoint: connection.rpcEndpoint,
              asset: keys.record,
              payer: payerKey,
              vault: new PublicKey(vault),
              name: draft.assetName,
              uri: sheetSlot,
              attributes,
            }),
          ),
        keys.record,
      );
      const recordPrepared = recordFit.prepared;
      const recordBytes = recordFit.bytes;
      const recordOnChain = await connection.getAccountInfo(keys.record.publicKey, "confirmed");
      let recordRent = recordOnChain?.lamports ?? 0;
      if (!recordOnChain) {
        const simulated = await connection.simulateTransaction(recordPrepared.transaction, undefined, [keys.record.publicKey]);
        if (simulated.value.err) throw new Error(`The record would fail: ${JSON.stringify(simulated.value.err)}`);
        recordRent = simulated.value.accounts?.[0]?.lamports ?? 0;
      }

      const useEdition = draftPlan.rail !== "escrow";
      const titleFit = await fitNft(
        "title",
        titleAttributes({
          record,
          mint,
          pool,
          creator,
          rail: draftPlan.rail,
          delayDays: Number(draft.saleDays),
          burnPercent: burnOf(draft),
          venue,
          program: ESCROW_PROGRAM[cluster],
          sale: draft.sale,
          shortClock: cluster === "devnet" && draftPlan.rail === "escrow",
          sheet: sheetSlot,
          noCoin: draftPlan.noCoin,
        }),
        (attributes) =>
          new Transaction().add(
            ...titleInstructions({
              endpoint: connection.rpcEndpoint,
              asset: keys.title,
              collection: useEdition ? keys.collection.publicKey : undefined,
              creator: payerKey,
              name: titleName(draft.assetName),
              uri: sheetSlot,
              attributes,
            }),
          ),
        keys.title,
      );
      const titlePrepared = titleFit.prepared;
      const titleBytes = titleFit.bytes;
      let titleRent = 0;
      let collectionBytes = 0;
      let collectionRent = 0;
      if (useEdition) {
        const collectionTx = new Transaction().add(
          ...editionCollectionInstructions({
            endpoint: connection.rpcEndpoint,
            collection: keys.collection,
            creator: payerKey,
            name: titleName(draft.assetName),
            uri: sheetSlot,
          }),
        );
        const collectionPrepared = await prepareTransaction(connection, payerKey, collectionTx, [keys.collection], {
          tip: false,
        });
        const measuredCollection =
          bytesWithDurableNonce(collectionPrepared.transaction, payerKey) ?? transactionBytes(collectionPrepared.transaction);
        if (measuredCollection === null) throw new Error("The master edition could not be measured.");
        collectionBytes = measuredCollection;
        if (collectionBytes > 1232) {
          throw new Error(`The master edition is ${collectionBytes} bytes. The limit is 1232.`);
        }
        const collectionSimulated = await connection.simulateTransaction(collectionPrepared.transaction, undefined, [
          keys.collection.publicKey,
        ]);
        if (collectionSimulated.value.err) {
          throw new Error(`The master edition would fail: ${JSON.stringify(collectionSimulated.value.err)}`);
        }
        collectionRent = collectionSimulated.value.accounts?.[0]?.lamports ?? 0;
        const titleSimulated = await connection
          .simulateTransaction(titlePrepared.transaction, undefined, [keys.title.publicKey])
          .catch(() => null);
        const rented = titleSimulated && !titleSimulated.value.err ? titleSimulated.value.accounts?.[0]?.lamports ?? 0 : 0;
        titleRent = rented > 0 ? rented : recordRent;
      } else {
        const titleSimulated = await connection.simulateTransaction(titlePrepared.transaction, undefined, [keys.title.publicKey]);
        if (titleSimulated.value.err) throw new Error(`The title would fail: ${JSON.stringify(titleSimulated.value.err)}`);
        titleRent = titleSimulated.value.accounts?.[0]?.lamports ?? 0;
      }
      draftPlan.omitRecord = recordFit.omitted;
      draftPlan.omitTitle = titleFit.omitted;

      const useRail = draftPlan.rail;
      const bundleLine =
        "The master, the master edition, and the title do not fit in one 1232-byte packet, so they are three signatures. Each one lands before the next one opens. You can read the wallet prompt. When the packet has room, that signature stays valid while you read. When it does not, an aged signature is offered again, and a signature that already landed is not charged again.";
      draftPlan.lines = [
        `Network: ${cluster === "devnet" ? "practice network" : "Solana Mainnet"}`,
        `Order: you sign the promises, then the sheet picture, the NFT image, the readable sheet, and the record file go to Arweave, then the record${useEdition ? ", the master edition," : ""} and the title${useRail === "escrow" ? ", then the title goes into the escrow" : ""}.${draftPlan.noCoin ? "" : " The coin is not created here."}`,
        `The wallet signs the promises, four Arweave uploads, the record${useEdition ? ", the master edition" : ""}, and the title${useRail === "escrow" ? ", then the escrow deposit" : ""}.`,
        bundleLine,
        `Token: ${draftPlan.tokenName} (${draftPlan.symbol})`,
        `Token mint: ${mint}`,
        ...(draftPlan.noCoin
          ? [`Decimals: ${draftPlan.decimals}.`]
          : [`Supply: ${draftPlan.supply}. Decimals: ${draftPlan.decimals}.`, `Pool: ${pool}`]),
        `Record: ${record}`,
        `Title: ${title}`,
        `Platform vault: ${vault}`,
        draftPlan.noCoin
          ? `The title stays in your wallet (${creator}). You list it on the sale page through Tensor's marketplace program. Sale page written on the record and the title: ${venue}.`
          : `The title goes to the ${railWords(useRail)}${useRail === "creator" ? ` (${creator})` : ""}. It is sold through the ${saleVenueWords(useRail)}, because that path is selected on Claim. Sale page written on the record and the title: ${venue}.`,
        useRail === "escrow"
          ? `The ${draft.sale === "auction" ? "reserve" : "price"} is ${draft.titlePrice.trim() || "unset"} ${draftPlan.symbol}. The sale opens ${draft.saleDays} ${cluster === "devnet" ? "seconds" : "days"} after graduation. It is paid in ${draftPlan.symbol} only: ${burnOf(draft)}% is burned by the escrow, ${creatorSalePercent(burnOf(draft))}% goes to you, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
          : draftPlan.noCoin
            ? `On the sale page you list one price in ${draftPlan.symbol}. A buyer pays that price through Tensor's marketplace program. Tensor pays you the full price. The buyer pays Tensor about ${TENSOR_TAKER_FEE_PERCENT}% on top. PAR takes none of that sale. A burn, if you promised one, is your own promise.`
            : `The sale opens ${draft.saleDays} days after graduation. Tensor pays you the full price. Within ${CREATOR_BURN_DAYS} days you burn ${burnOf(draft)}% of it and keep the rest.`,
        ...(useRail === "escrow" ? [] : [ESCROW_PATH]),
        `The record and the title each carry the token address ${mint}, sale page ${venue}, and a full sheet link. That link is the readable page on Arweave.`,
        "The wallet signs this message. These are the words, in this order.",
        ...sampleMessage.split("\n"),
        draftPlan.tokenUri ? `The coin already has its link: ${draftPlan.tokenUri}` : `Payment token: ${draftPlan.tokenName} (${draftPlan.symbol}).`,
        `Sheet picture: ${(picture.size / 1024).toFixed(1)} KiB. NFT image: ${(nftPicture.size / 1024).toFixed(1)} KiB. Record sheet: ${(sheetBytes / 1024).toFixed(1)} KiB. Arweave stores each without payment under 105 KiB. Arweave copies are permanent, even for a practice record.`,
        ...(draftPlan.noCoin
          ? []
          : [
              `Opening price ${draftPlan.par} ${draftPlan.quoteSymbol}. Pool price ${draftPlan.poolPrice} ${draftPlan.quoteSymbol}. Whole supply at the opening price ${draftPlan.wholeAtPar} ${draftPlan.quoteSymbol}. ${curveLines}`,
              `Curve fee: ${draftPlan.openingBps === draftPlan.endingBps ? `${bpsToPercent(draftPlan.openingBps)} until graduation` : `${bpsToPercent(draftPlan.openingBps)} falling to ${bpsToPercent(draftPlan.endingBps)}`}. Of that fee, Meteora ${METEORA_TRADING_FEE_PERCENT}%, PAR ${draftPlan.platformFeePercent}%, you ${draftPlan.creatorFeePercent}%.`,
            ]),
        `Record rent: ${formatLamports(recordRent)}. ${landingCost(recordPrepared)} Record transaction: ${recordBytes} of 1232 bytes.`,
        ...(useEdition
          ? [
              `Master edition rent: ${formatLamports(collectionRent)}. Master edition transaction: ${collectionBytes} of 1232 bytes.`,
            ]
          : []),
        `Title rent: ${formatLamports(titleRent)}. ${landingCost(titlePrepared)} Title transaction: ${titleBytes} of 1232 bytes.`,
        ...(cluster === "mainnet-beta" && useEdition
          ? [
              `Jito tip: ${formatLamports(JITO_TIP_LAMPORTS)} on each signature that has room for it. It is paid only when that signature lands.`,
            ]
          : []),
        ...(recordFit.omitted.length || titleFit.omitted.length
          ? [
              `Some short fields stay off the NFT so the transaction fits in 1232 bytes. Those words stay on the Arweave sheet. Left off the record: ${recordFit.omitted.join(", ") || "none"}. Left off the title: ${titleFit.omitted.join(", ") || "none"}.`,
            ]
          : []),
        "The record locks at creation. Its name, link, and attributes cannot be changed, and no plugin can be added. The vault never burns it.",
        useEdition
          ? "The title is minted as edition 1 of a sealed collection of one. Nobody can add another edition or change its name, link, or attributes. It can only be moved by whoever holds it."
          : "The title locks at creation too. Nobody can change its name, link, or attributes. It can only be moved by whoever holds it.",
      ];
      setPlan(draftPlan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not plan the record.");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!plan || !picture || !nftPicture || !wallet.publicKey || !wallet.signTransaction || !wallet.signMessage) return;
    const { keys, pool } = plan;
    const payer = wallet.publicKey;
    const signTransaction = wallet.signTransaction;
    const signMessage = wallet.signMessage;
    setBusy(true);
    setError("");
    setProgress([]);
    try {
      if (plan.noCoin) {
        const again = await readPayToken(connection, plan.mint);
        if (again.mint !== plan.mint || again.symbol !== plan.symbol || again.name !== plan.tokenName || again.decimals !== plan.decimals) {
          throw new Error("The price token on chain does not match the review. Press Review create again.");
        }
      } else {
        const again = await readCoin(connection, plan.mint);
        const supply = again.supply.replace(/,/g, "");
        if (
          again.mint !== plan.mint ||
          again.pool !== plan.pool ||
          again.config !== plan.config ||
          supply !== plan.supply ||
          again.startPrice !== plan.par ||
          again.endPrice !== plan.poolPrice ||
          again.symbol !== plan.symbol ||
          again.name !== plan.tokenName ||
          again.decimals !== plan.decimals ||
          again.quoteSymbol !== plan.quoteSymbol ||
          again.quoteMint !== plan.quoteMint ||
          again.openingFeeBps !== plan.openingBps ||
          again.endingFeeBps !== plan.endingBps ||
          again.migrationFeeBps !== plan.migrationFeeBps ||
          again.feeDecaySeconds !== plan.feeDecaySeconds ||
          again.creatorFeePercent !== plan.creatorFeePercent ||
          again.platformFeePercent !== plan.platformFeePercent
        ) {
          throw new Error("The coin on chain does not match the review. Press Review create again.");
        }
      }
      const recordAddress = keys.record.publicKey.toBase58();
      const titleAddress = keys.title.publicKey.toBase58();
      const mint = plan.mint;
      const message = promiseMessage({ promises: plan.promises, record: recordAddress, title: titleAddress, mint, creator: payer.toBase58() });
      const shown = plan.lines.slice(plan.lines.indexOf("PAR creator promise"), plan.lines.indexOf("PAR creator promise") + message.split("\n").length).join("\n");
      if (shown !== message) throw new Error("The wallet message does not match the review. Press Review create again.");
      const signed = await signMessage(new TextEncoder().encode(message));
      const promise: Promise_ = { message, signature: Buffer.from(signed).toString("base64") };
      mark("Promises signed by your wallet");

      const { TurboFactory } = await import("@ardrive/turbo-sdk/web");
      const turbo = TurboFactory.authenticated({
        token: "solana",
        walletAdapter: { publicKey: payer, signMessage, signTransaction },
      });
      const sheetPictureBytes = new Uint8Array(await picture.arrayBuffer());
      const sheetImageSha256 = await sha256Hex(sheetPictureBytes);
      const nftPictureBytes = new Uint8Array(await nftPicture.arrayBuffer());
      const imageSha256 = await sha256Hex(nftPictureBytes);
      const creationScope = `${payer.toBase58()}:${await sha256Hex(
        new TextEncoder().encode(
          JSON.stringify({
            cluster,
            asset: draft.assetName,
            mint: plan.mint,
            pool: plan.pool,
            rail: plan.rail,
            record: keys.record.publicKey.toBase58(),
            title: keys.title.publicKey.toBase58(),
            collection: keys.collection.publicKey.toBase58(),
            rows,
            promises: plan.promises,
          }),
        ),
      )}`;
      async function storeFile(bytes: Uint8Array | string, sha256: string, contentType: string) {
        let id = savedArweaveId(creationScope, sha256);
        if (!id) {
          const upload = await turbo.upload({
            data: bytes,
            dataItemOpts: { tags: [{ name: "Content-Type", value: contentType }] },
          });
          id = upload.id;
          keepArweaveId(creationScope, sha256, id);
        }
        return arweaveUrl(id);
      }
      const sheetImageArweave = await storeFile(sheetPictureBytes, sheetImageSha256, "image/jpeg");
      mark("Sheet picture stored on Arweave", sheetImageArweave);
      const imageArweave = await storeFile(nftPictureBytes, imageSha256, "image/jpeg");
      mark("NFT image stored on Arweave", imageArweave);

      const pathLine = plan.noCoin
        ? "Sale path: Tensor. The creator lists one price on the sale page. A buyer pays that price. Tensor pays the creator the full price. PAR takes none of that sale. A burn, if the creator promised one, is the creator's own promise."
        : plan.rail === "escrow"
          ? `Sale path: PAR escrow, because Escrow was selected on Claim. The title is ${draft.sale === "auction" ? "auctioned" : "sold"} only through the PAR escrow program.`
          : "Sale path: Tensor, because Tensor was selected on Claim. The title is listed through Tensor's marketplace program.";
      const html = sheetPageHtml({
        name: draft.assetName,
        tokenName: plan.tokenName,
        symbol: plan.symbol,
        mint,
        soldThrough: saleVenueWords(plan.rail),
        salePage: plan.venue,
        pool: plan.pool,
        pathLine,
        rows,
        promises: plan.promises,
        imageUrl: sheetImageArweave,
        nftImageUrl: imageArweave,
        attached: !plan.noCoin,
      });
      const htmlSha256 = await sha256Hex(new TextEncoder().encode(html));
      const htmlArweave = await storeFile(html, htmlSha256, "text/html");
      mark("Readable sheet stored on Arweave", htmlArweave);

      const sheet = sheetJson({
        draft,
        rows,
        plan,
        cluster,
        creator: payer.toBase58(),
        vault,
        quoteMint: plan.quoteMint,
        curveLines,
        image: { arweave: imageArweave, copy: nftPictureCopy, sha256: imageSha256 },
        sheetImage: { arweave: sheetImageArweave, copy: pictureCopy, sha256: sheetImageSha256 },
        promise,
        htmlUrl: htmlArweave,
      });
      const sheetSha256 = await sha256Hex(new TextEncoder().encode(sheet));
      const sheetArweave = await storeFile(sheet, sheetSha256, "application/json");
      mark("Record sheet stored on Arweave", sheetArweave);

      mark(coin ? "Using the coin already on chain" : `The buyer pays in ${plan.symbol}.`);

      const shortClock = cluster === "devnet" && plan.rail === "escrow";
      const held = railWords(plan.rail);
      const coinWord = plan.noCoin ? "none" : "attached";
      const recordRows = recordAttributes({
        mint,
        pool,
        vault,
        creator: payer.toBase58(),
        symbol: plan.symbol,
        supply: plan.supply,
        decimals: String(plan.decimals),
        quote: plan.quoteSymbol,
        par: plan.par,
        poolPrice: plan.poolPrice,
        handoffDays: draft.shipDays,
        declared: draft.declared,
        sheetSha256,
        imageSha256,
        title: titleAddress,
        titleHeldBy: held,
        serial: draft.serial,
        makerName: draft.makerName,
        escrowProgram: plan.rail === "escrow" ? ESCROW_PROGRAM[cluster] : undefined,
        sheet: htmlArweave,
        salePage: plan.venue,
        soldThrough: saleVenueWords(plan.rail),
        coin: coinWord,
      });
      const titleRows = titleAttributes({
        record: recordAddress,
        mint,
        pool,
        creator: payer.toBase58(),
        rail: plan.rail,
        delayDays: Number(draft.saleDays),
        burnPercent: burnOf(draft),
        venue: plan.venue,
        program: ESCROW_PROGRAM[cluster],
        sale: draft.sale,
        shortClock,
        sheet: htmlArweave,
        noCoin: plan.noCoin,
      });
      assertOneStory({
        sheet,
        recordRows,
        titleRows,
        held,
        creator: payer.toBase58(),
        mint,
        pool,
        record: recordAddress,
        title: titleAddress,
        coin: coinWord,
        sheetSha256,
        imageSha256,
        imageUrl: imageArweave,
        sheetImageSha256,
        sheetImageUrl: sheetImageArweave,
        htmlUrl: htmlArweave,
        noCoin: plan.noCoin,
        saleOpens: plan.noCoin ? "when the creator lists it" : `${Number(draft.saleDays)} ${shortClock ? "seconds" : "days"} after graduation`,
        delayDays: Number(draft.saleDays),
      });

      const useEdition = plan.rail !== "escrow";
      const recordExists = Boolean(await connection.getAccountInfo(keys.record.publicKey, "confirmed"));
      const collectionExists = useEdition
        ? Boolean(await connection.getAccountInfo(keys.collection.publicKey, "confirmed"))
        : true;
      const titleExists = Boolean(await connection.getAccountInfo(keys.title.publicKey, "confirmed"));

      const pending: Array<{
        kind: "record" | "collection" | "title";
        transaction: Transaction;
        signers: Keypair[];
        landed: string;
        done: string;
      }> = [];
      if (!recordExists) {
        pending.push({
          kind: "record",
          transaction: new Transaction().add(
            ...recordInstruction({
              endpoint: connection.rpcEndpoint,
              asset: keys.record,
              payer,
              vault: new PublicKey(vault),
              name: draft.assetName,
              uri: sheetArweave,
              attributes: keepSheet(recordRows, plan.omitRecord),
            }),
          ),
          signers: [keys.record],
          landed: "The record is on chain.",
          done: "Master sent to the program vault",
        });
      } else {
        mark("Master already on chain", explorerAccount(keys.record.publicKey.toBase58(), cluster));
      }
      if (useEdition && !collectionExists) {
        pending.push({
          kind: "collection",
          transaction: new Transaction().add(
            ...editionCollectionInstructions({
              endpoint: connection.rpcEndpoint,
              collection: keys.collection,
              creator: payer,
              name: titleName(draft.assetName),
              uri: sheetArweave,
            }),
          ),
          signers: [keys.collection],
          landed: "The master edition is on chain.",
          done: "Master edition of one, ready for the title",
        });
      } else if (useEdition) {
        mark("Master edition already on chain", explorerAccount(keys.collection.publicKey.toBase58(), cluster));
      }
      if (!titleExists) {
        pending.push({
          kind: "title",
          transaction: new Transaction().add(
            ...titleInstructions({
              endpoint: connection.rpcEndpoint,
              asset: keys.title,
              collection: useEdition ? keys.collection.publicKey : undefined,
              creator: payer,
              name: titleName(draft.assetName),
              uri: sheetArweave,
              attributes: keepSheet(titleRows, plan.omitTitle),
            }),
          ),
          signers: [keys.title],
          landed: "The title is in your wallet.",
          done: `Title minted to your wallet${plan.rail === "creator" ? ". It stays there until the sale" : ""}`,
        });
      } else {
        mark("Title already on chain", explorerAccount(keys.title.publicKey.toBase58(), cluster));
      }

      let recordSig = "";
      let titleSig = "";
      for (const part of pending) {
        const signature = await sendPrepared(
          connection,
          await prepareTransaction(connection, payer, part.transaction, part.signers, {
            tip: cluster === "mainnet-beta",
          }),
          signTransaction,
          part.landed,
        );
        if (part.kind === "record") recordSig = signature;
        if (part.kind === "title") titleSig = signature;
        mark(part.done, explorerTx(signature, cluster));
        if (part.kind === "collection") await waitForAccount(connection, keys.collection.publicKey);
      }

      let depositSig: string | undefined;
      if (plan.rail === "escrow") {
        if (!escrowDepositAllowed(cluster, payer.toBase58())) {
          throw new Error("The escrow path is not available on this network.");
        }
        await waitForAccount(connection, keys.title.publicKey);
        const typedPrice = parseTokenAmount(draft.titlePrice, plan.decimals);
        if (!typedPrice) throw new Error("Type the title price in the token on the Claim step.");
        const depositTx = new Transaction().add(
          escrowDepositInstruction({
            program: new PublicKey(ESCROW_PROGRAM[cluster]),
            creator: payer,
            title: keys.title.publicKey,
            record: keys.record.publicKey,
            mint: new PublicKey(mint),
            pool: new PublicKey(pool),
            price: typedPrice,
            delayDays: Number(draft.saleDays),
            burnPercent: burnOf(draft),
            sale: draft.sale,
          }),
        );
        depositSig = await sendPrepared(connection, await prepareTransaction(connection, payer, depositTx, []), signTransaction, "The escrow deposit is confirmed.");
        mark("Title moved into the escrow until the sale", explorerTx(depositSig, cluster));
      }

      const copy = await fetch("/api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset: recordAddress,
          cluster,
          sheet,
          signatures: { record: recordSig, title: titleSig, deposit: depositSig },
        }),
      })
        .then(async (response) => (await response.json()) as { saved?: boolean; error?: string })
        .catch(() => ({ saved: false, error: "The PAR copy did not save." }));
      if (copy.saved) mark("PAR copy saved");
      else setError(`${copy.error || "The PAR copy did not save."} The Arweave copy and the record are already on chain.`);
      if (coin) {
        void fetch("/api/listings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pool, cluster }),
        }).catch(() => undefined);
      }
      onCreated?.();
      setFinished({ pool, record: recordAddress, title: titleAddress });
      setPlan(null);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "The create stopped."} Steps marked done are already stored. Press Review create again. This tab still has the same addresses.`,
      );
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card record-create">
      <p className="eyebrow">Create</p>
      <h2>{coin ? "Token, record, and title" : "Record and title"}</h2>
      <p className="note">
        {coin
          ? "The coin, the record, and the title are one asset. The coin is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share, and it pays nothing. The coin trades. The master holds the sheet picture, the NFT image, every word on the record sheet, the token mint, and the pool. It is sent to the program vault and stays there. One edition is made. That edition is the title, and it carries the same meta sheet. The NFT on the chain is the proof. PAR keeps a copy of those proofs."
          : "This step makes the record and one title for one object. The token you named is what a buyer pays. The master holds the sheet picture, the NFT image, and every word on the record sheet. It is sent to the program vault and stays there. One edition is the title. The NFT on the chain is the proof. PAR keeps a copy of those proofs."}
      </p>
        <p className="note">
          {coin
            ? rail === "escrow"
              ? draft.sale === "auction"
                ? "Claim is set to Escrow, and the sale is an auction. These promises say the title is auctioned only through the PAR escrow program, because Escrow is the path selected."
                : "Claim is set to Escrow, and the sale is a fixed price. These promises say the title is sold only through the PAR escrow program, because Escrow is the path selected."
              : "Claim is set to Tensor. The title stays in your wallet. These promises say you will list it through Tensor's marketplace program, because Tensor is the path selected."
            : `The title stays in your wallet. You list it on the sale page through Tensor's marketplace program, at one price in the payment token. A buyer pays that price. Tensor pays you the full price. PAR takes none of that sale. A burn, if you promised one, is your own promise. ${ESCROW_PATH}`}
          {coin && cluster !== "devnet" && rail !== "escrow" ? ` ${ESCROW_PATH}` : ""}
        </p>
      {!finished ? (
        <div className="record-promises">
          <p className="eyebrow">Creator promises</p>
          <p className="note">
            The master is sent to the program vault and stays there. The title is minted as edition 1 of a sealed
            collection of one, and it goes to the {railWords(rail)}. You sign these words with your wallet, and
            the signature is kept on the record sheet.
          </p>
          <ol>
            {previewPromises.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <label className="check">
            <input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} />
            I have read these promises and I will keep them.
          </label>
        </div>
      ) : null}
      {!plan && !finished ? (
        <button type="button" className="solid" disabled={busy || !agreed} onClick={() => void review()}>
          {busy ? "Checking…" : "Review create"}
        </button>
      ) : null}
      {plan ? (
        <>
          <ul className="record-lines">
            {plan.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="asset-nav">
            <ReviewFile
              text={reviewText(coin ? "Token, record, and title" : "Record and title", plan.lines)}
              filename="par-record-review.txt"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setGateOpen(false);
                setPlan(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="solid"
              disabled={busy}
              onClick={() => {
                if (cluster === "devnet") void run();
                else setGateOpen(true);
              }}
            >
              {busy ? "Creating…" : "Sign and create"}
            </button>
          </div>
        </>
      ) : null}
      {progress.length > 0 ? (
        <ol className="record-progress">
          {progress.map((item) => (
            <li key={item.label}>
              {item.link ? (
                <a href={item.link} target="_blank" rel="noreferrer">
                  {item.label}
                </a>
              ) : (
                item.label
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {finished ? (
        <p className="note">
          {finished.pool !== "none" ? (
            <>
              <Link href={poolPath(finished.pool, cluster)}>Open the pool page</Link>.{" "}
            </>
          ) : null}
          <Link href={salePath(finished.title, cluster)}>Open the sale page</Link>.{" "}
          <a href={explorerAccount(finished.record, cluster)} target="_blank" rel="noreferrer">
            See the record on the explorer
          </a>
          .{" "}
          <a href={explorerAccount(finished.title, cluster)} target="_blank" rel="noreferrer">
            See the title on the explorer
          </a>
          .
        </p>
      ) : null}
      {finished ? <HandoffDesk cluster={cluster} title={finished.title} mailOnly /> : null}
      {error ? <p className="error">{error}</p> : null}
      {gateOpen && plan ? (
        <MainnetGate
          title="Create this record on Solana Mainnet?"
          lines={plan.lines}
          note="Nothing is written until you confirm. The lines below are what this confirmation writes."
          filename="par-record-review.txt"
          confirmLabel="Open wallet"
          onCancel={() => setGateOpen(false)}
          onConfirm={() => {
            setGateOpen(false);
            void run();
          }}
        />
      ) : null}
    </section>
  );
}
