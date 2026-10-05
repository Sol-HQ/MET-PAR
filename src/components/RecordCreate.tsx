"use client";

import { deriveDbcPoolAddress, DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useState } from "react";
import { launchChoice, type Draft } from "@/components/AssetDesk";
import { PLATFORM_FEE_CLAIMER } from "@/lib/admins";
import { useCluster } from "@/lib/cluster";
import { DEFAULT_FEE_DECAY_SECONDS, explorerAccount, explorerTx, quoteMintAddress } from "@/lib/constants";
import { readCurveShape, type CurveShape } from "@/lib/curve";
import { bpsToPercent, formatLamports } from "@/lib/format";
import { buildLaunchConfig } from "@/lib/launch";
import { assertCurveFee, parseFeePercent, type PlatformSettings } from "@/lib/platform";
import {
  FREE_UPLOAD_BYTES,
  PUBLIC_ORIGIN,
  RECORD_KIND,
  RECORD_VAULT,
  arweaveUrl,
  recordAttributes,
  recordInstruction,
  recordTokenUri,
  sha256Hex,
} from "@/lib/record";
import { prepareTransaction, sendPrepared } from "@/lib/send";
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
  SALE_BURN_PERCENT,
  SALE_PROGRAM_FEE_PERCENT,
  creatorSalePercent,
  saleUrl,
  saleVenueWords,
  CREATOR_BURN_DAYS,
  ESCROW_COMING,
  TENSOR_MARKETPLACE,
  TITLE_KIND,
  titleAttributes,
  titleInstructions,
  type TitleRail,
} from "@/lib/title";

type Keys = { baseMint: Keypair; config: Keypair; record: Keypair; title: Keypair };

type Plan = {
  keys: Keys;
  pool: string;
  tokenUri: string;
  openingBps: number;
  endingBps: number;
  migrationFeeBps: number;
  shape: CurveShape;
  platformFeePercent: number;
  rail: TitleRail;
  venue: string;
  promises: string[];
  lines: string[];
};

type Promise_ = { message: string; signature: string };

const TOKEN_DECIMALS = 6;

/** The first escrow price, in the token's smallest unit. After the burn and the program fee, the creator receives the declared value at par. The creator can reprice later. */
function openingEscrowPrice(declared: string, par: string): bigint {
  const tokens = (Number(declared) * 100) / creatorSalePercent() / Number(par);
  const units = Math.min(Math.ceil(tokens * 10 ** TOKEN_DECIMALS), 1_000_000_000 * 10 ** TOKEN_DECIMALS);
  if (!Number.isFinite(units) || units <= 0) throw new Error("The declared value and par do not give a title price.");
  return BigInt(units);
}

function titleName(assetName: string): string {
  return `${assetName} title`;
}

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
  promise: Promise_;
}): string {
  const { draft, plan } = input;
  const mint = plan.keys.baseMint.publicKey.toBase58();
  const symbol = draft.symbol.trim().toUpperCase();
  return JSON.stringify(
    {
      name: draft.assetName,
      description: draft.story,
      image: input.image.arweave,
      external_url: `${PUBLIC_ORIGIN}/pool/${plan.pool}`,
      attributes: [
        { trait_type: "Record", value: RECORD_KIND },
        { trait_type: "Token", value: symbol },
        { trait_type: "Title", value: plan.keys.title.publicKey.toBase58() },
        { trait_type: "Declared value", value: `${draft.declared} ${draft.quote}` },
      ],
      properties: {
        category: "image",
        files: [
          { uri: input.image.arweave, type: "image/jpeg" },
          { uri: input.image.copy, type: "image/jpeg" },
        ],
      },
      record: {
        kind: RECORD_KIND,
        network: input.cluster,
        address: plan.keys.record.publicKey.toBase58(),
        vault: input.vault,
        creator: input.creator,
        token: {
          mint: plan.keys.baseMint.publicKey.toBase58(),
          name: draft.tokenName,
          symbol,
          uri: plan.tokenUri,
          pool: plan.pool,
          config: plan.keys.config.publicKey.toBase58(),
          quote: draft.quote,
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
          declaredUnit: draft.quote,
          ifClaimGoesWrong: draft.terms,
        },
        curve: {
          par: draft.par,
          poolPrice: draft.pool,
          supply: "1000000000",
          valueAtPar: `${draft.value} ${draft.quote}`,
          locked: input.curveLines,
          openingFee: bpsToPercent(plan.openingBps),
          endingFee: bpsToPercent(plan.endingBps),
          feeDecaySeconds: plan.openingBps === plan.endingBps ? 0 : DEFAULT_FEE_DECAY_SECONDS,
          migrationFeeBps: plan.shape.compound ? plan.shape.compound.poolFeeBps : plan.migrationFeeBps,
          platformFeePercent: plan.platformFeePercent,
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
            opensDaysAfterGraduation: Number(draft.saleDays),
            burnPercent: SALE_BURN_PERCENT,
            creatorPercent: plan.rail === "escrow" ? creatorSalePercent() : 100 - SALE_BURN_PERCENT,
            programPercent: plan.rail === "escrow" ? SALE_PROGRAM_FEE_PERCENT : 0,
            price: "Set by the creator in dollars and paid in this token.",
            burnedBy: plan.rail === "escrow" ? "the escrow program, at the sale" : `the creator, within ${CREATOR_BURN_DAYS} days of the sale`,
            auction:
              plan.rail === "escrow" && draft.sale === "auction"
                ? {
                    clockStarts: "on the first bid at or above the reserve",
                    hours: AUCTION_HOURS,
                    extendHours: AUCTION_EXTEND_HOURS,
                    sitDaysWithoutBid: AUCTION_SIT_DAYS,
                    finish: "The PAR watcher sends the finish when the clock ends. The creator and the bidder do not send it.",
                  }
                : null,
          },
          promises: plan.promises,
          promise: { signedBy: input.creator, message: input.promise.message, signatureBase64: input.promise.signature },
        },
        sheet: input.rows.map(([title, body]) => ({ title, body })),
        image: input.image,
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
  problem,
  platform,
  curveLines,
}: {
  draft: Draft;
  rows: [string, string][];
  picture: Blob | null;
  pictureCopy: string;
  problem: string;
  platform: PlatformSettings;
  curveLines: string;
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
  const vault = RECORD_VAULT[cluster];
  const rail = chosenRail(cluster, escrowDepositAllowed(cluster, wallet.publicKey?.toBase58()) ? draft.hold : "wallet");
  const previewPromises = creatorPromises({
    rail,
    delayDays: Number(draft.saleDays),
    burnPercent: SALE_BURN_PERCENT,
    handoffDays: draft.shipDays,
    venue: "the sale page named on this record sheet",
    sale: draft.sale,
    shortClock: cluster === "devnet" && rail === "escrow",
  });

  useEffect(() => {
    setPlan(null);
    setAgreed(false);
  }, [draft, picture, cluster, platform]);

  function mark(label: string, link?: string) {
    setProgress((current) => [...current, { label, done: true, link }]);
  }

  async function review() {
    setError("");
    setFinished(null);
    setProgress([]);
    if (problem) {
      setError(problem);
      return;
    }
    if (!vault) {
      setError("The real network vault is not set yet. Records are made on the practice network only.");
      return;
    }
    if (!picture || !pictureCopy) {
      setError("Add a picture of the asset on the Object step.");
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
      const openingBps = parseFeePercent(draft.feeOpen);
      assertCurveFee(openingBps);
      const endingBps = draft.fee === "flat" ? openingBps : parseFeePercent(draft.feeEnd);
      if (endingBps > openingBps) throw new Error("The ending fee has to be at or under the opening fee.");
      const shapeRead = readCurveShape({
        straightFall: draft.straightFall,
        dynamicFee: draft.dynamicFee,
        compoundOn: draft.compoundOn,
        poolFeePercent: draft.poolFee,
        compoundPercent: draft.compoundShare,
      });
      if (shapeRead.error) throw new Error(shapeRead.error);
      const migrationFeeBps = draft.poolFeeBps;
      const platformFeePercent = platform.platformFeePercent ?? 20;
      const quoteKind = draft.quote === "SOL" ? "sol" : "usdc";
      const quoteMint = quoteMintAddress(cluster, quoteKind);
      buildLaunchConfig(
        launchChoice(draft),
        openingBps,
        endingBps,
        platformFeePercent,
        DEFAULT_FEE_DECAY_SECONDS,
        migrationFeeBps,
        quoteKind,
        undefined,
        undefined,
        shapeRead.shape,
      );
      const keys: Keys = {
        baseMint: Keypair.generate(),
        config: Keypair.generate(),
        record: Keypair.generate(),
        title: Keypair.generate(),
      };
      const mint = keys.baseMint.publicKey.toBase58();
      const record = keys.record.publicKey.toBase58();
      const title = keys.title.publicKey.toBase58();
      const creator = wallet.publicKey.toBase58();
      const pool = deriveDbcPoolAddress(quoteMint, keys.baseMint.publicKey, keys.config.publicKey).toBase58();
      const tokenUri = recordTokenUri(record, mint, cluster);
      if (tokenUri.length > 200) throw new Error("The token link is over 200 characters.");
      const venue = saleUrl(title, cluster);
      const promises = creatorPromises({
        rail,
        delayDays: Number(draft.saleDays),
        burnPercent: SALE_BURN_PERCENT,
        handoffDays: draft.shipDays,
        venue,
        sale: draft.sale,
        shortClock: cluster === "devnet" && rail === "escrow",
      });
      if (rail === "escrow") openingEscrowPrice(draft.declared, draft.par);

      const draftPlan: Plan = { keys, pool, tokenUri, openingBps, endingBps, migrationFeeBps, shape: shapeRead.shape, platformFeePercent, rail, venue, promises, lines: [] };
      const sampleMessage = promiseMessage({ promises, record, title, mint, creator });
      const sample = sheetJson({
        promise: { message: sampleMessage, signature: "A".repeat(88) },
        draft,
        rows,
        plan: draftPlan,
        cluster,
        creator: wallet.publicKey.toBase58(),
        vault,
        quoteMint: quoteMint.toBase58(),
        curveLines,
        image: { arweave: arweaveUrl("x".repeat(43)), copy: pictureCopy, sha256: "0".repeat(64) },
      });
      const sheetBytes = new TextEncoder().encode(sample).length;
      if (sheetBytes > FREE_UPLOAD_BYTES) throw new Error("Your record sheet is over 105 KiB. Shorten the longest fields.");

      const recordTx = new Transaction().add(
        ...recordInstruction({
          endpoint: connection.rpcEndpoint,
          asset: keys.record,
          payer: wallet.publicKey,
          vault: new PublicKey(vault),
          name: draft.assetName,
          uri: arweaveUrl("x".repeat(43)),
          attributes: recordAttributes({
            mint,
            pool,
            vault,
            creator: wallet.publicKey.toBase58(),
            symbol: draft.symbol.trim().toUpperCase(),
            quote: draft.quote,
            par: draft.par,
            poolPrice: draft.pool,
            handoffDays: draft.shipDays,
            declared: draft.declared,
            sheetSha256: "0".repeat(64),
            imageSha256: "0".repeat(64),
            title,
            titleHeldBy: railWords(rail),
            serial: draft.serial,
            makerName: draft.makerName,
            escrowProgram: rail === "escrow" ? ESCROW_PROGRAM[cluster] : undefined,
          }),
        }),
      );
      const recordPrepared = await prepareTransaction(connection, wallet.publicKey, recordTx, [keys.record]);
      const recordBytes = recordPrepared.transaction.serialize({ requireAllSignatures: false }).length;
      const simulated = await connection.simulateTransaction(recordPrepared.transaction, undefined, [keys.record.publicKey]);
      if (simulated.value.err) throw new Error(`The record would fail: ${JSON.stringify(simulated.value.err)}`);
      const recordRent = simulated.value.accounts?.[0]?.lamports ?? 0;

      const titleTx = new Transaction().add(
        ...titleInstructions({
          endpoint: connection.rpcEndpoint,
          asset: keys.title,
          creator: wallet.publicKey,
          name: titleName(draft.assetName),
          uri: arweaveUrl("x".repeat(43)),
          attributes: titleAttributes({ record, mint, pool, creator, rail, delayDays: Number(draft.saleDays), burnPercent: SALE_BURN_PERCENT, venue, program: ESCROW_PROGRAM[cluster], sale: draft.sale, shortClock: cluster === "devnet" && rail === "escrow" }),
        }),
      );
      const titlePrepared = await prepareTransaction(connection, wallet.publicKey, titleTx, [keys.title]);
      const titleBytes = titlePrepared.transaction.serialize({ requireAllSignatures: false }).length;
      const titleSimulated = await connection.simulateTransaction(titlePrepared.transaction, undefined, [keys.title.publicKey]);
      if (titleSimulated.value.err) throw new Error(`The title would fail: ${JSON.stringify(titleSimulated.value.err)}`);
      const titleRent = titleSimulated.value.accounts?.[0]?.lamports ?? 0;

      const walletOpens = rail === "escrow" ? "eight" : "seven";
      draftPlan.lines = [
        `Network: ${cluster === "devnet" ? "practice network" : "real network"}`,
        `Order: you sign the promises, your record sheet and picture go to Arweave, then the template, the token, the record, and the title${rail === "escrow" ? ", then the title goes into the escrow" : ""}.`,
        `The wallet opens ${walletOpens} times: the promises, two upload signatures, the template, the token, the record, the title${rail === "escrow" ? ", and the escrow deposit" : ""}.`,
        `Token: ${draft.tokenName} (${draft.symbol.trim().toUpperCase()})`,
        `Token mint: ${mint}`,
        `Pool: ${pool}`,
        `Template: ${keys.config.publicKey.toBase58()}`,
        `Record: ${record}`,
        `Title: ${title}`,
        `Platform vault: ${vault}`,
        `The title goes to the ${railWords(rail)}${rail === "creator" ? ` (${creator})` : ""}. It is sold through the ${saleVenueWords(rail)}. PAR tracks it at ${venue}`,
        rail === "escrow"
          ? `The sale opens ${draft.saleDays} days after graduation. It is paid in ${draft.symbol.trim().toUpperCase()} only: ${SALE_BURN_PERCENT}% is burned, ${creatorSalePercent()}% goes to you, and ${SALE_PROGRAM_FEE_PERCENT}% goes to the PAR program.`
          : `The sale opens ${draft.saleDays} days after graduation. It is paid in ${draft.symbol.trim().toUpperCase()} only: ${SALE_BURN_PERCENT}% is burned, ${100 - SALE_BURN_PERCENT}% goes to you.`,
        `Token link, frozen at creation: ${tokenUri}`,
        `Picture: ${(picture.size / 1024).toFixed(1)} KiB. Record sheet: ${(sheetBytes / 1024).toFixed(1)} KiB. Arweave stores each without payment under 105 KiB. Arweave copies are permanent, even for a practice record.`,
        `Par ${draft.par} ${draft.quote}. Pool price ${draft.pool} ${draft.quote}. ${curveLines}`,
        `Curve fee: ${openingBps === endingBps ? `${bpsToPercent(openingBps)} until graduation` : `${bpsToPercent(openingBps)} falling to ${bpsToPercent(endingBps)}`}.`,
        "Template rent: about 0.005984 SOL.",
        "Token rent for the mint, metadata, pool, and vaults: about 0.021 SOL. The wallet shows the exact amount.",
        `Record rent: ${formatLamports(recordRent)}. Record network fee: ${formatLamports(recordPrepared.feeLamports)}. Record transaction: ${recordBytes} of 1232 bytes.`,
        `Title rent: ${formatLamports(titleRent)}. Title network fee: ${formatLamports(titlePrepared.feeLamports)}. Title transaction: ${titleBytes} of 1232 bytes.`,
        "The record locks at creation. Its name, link, and attributes cannot be changed, and no plugin can be added. The vault never burns it.",
        "The title locks at creation too. Nobody can change its name, link, or attributes. It can only be moved by whoever holds it.",
      ];
      setPlan(draftPlan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not plan the record.");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!plan || !picture || !wallet.publicKey || !wallet.signTransaction || !wallet.signMessage) return;
    const { keys, pool, tokenUri } = plan;
    const payer = wallet.publicKey;
    const signTransaction = wallet.signTransaction;
    const signMessage = wallet.signMessage;
    setBusy(true);
    setError("");
    setProgress([]);
    try {
      const recordAddress = keys.record.publicKey.toBase58();
      const titleAddress = keys.title.publicKey.toBase58();
      const mint = keys.baseMint.publicKey.toBase58();
      const message = promiseMessage({ promises: plan.promises, record: recordAddress, title: titleAddress, mint, creator: payer.toBase58() });
      const signed = await signMessage(new TextEncoder().encode(message));
      const promise: Promise_ = { message, signature: Buffer.from(signed).toString("base64") };
      mark("Promises signed by your wallet");

      const { TurboFactory } = await import("@ardrive/turbo-sdk/web");
      const turbo = TurboFactory.authenticated({
        token: "solana",
        walletAdapter: { publicKey: payer, signMessage, signTransaction },
      });
      const pictureBytes = new Uint8Array(await picture.arrayBuffer());
      const imageSha256 = await sha256Hex(pictureBytes);
      const imageUpload = await turbo.upload({
        data: pictureBytes,
        dataItemOpts: { tags: [{ name: "Content-Type", value: "image/jpeg" }] },
      });
      const imageArweave = arweaveUrl(imageUpload.id);
      mark("Picture stored on Arweave", imageArweave);

      const quoteKind = draft.quote === "SOL" ? "sol" : "usdc";
      const quoteMint = quoteMintAddress(cluster, quoteKind);
      const sheet = sheetJson({
        draft,
        rows,
        plan,
        cluster,
        creator: payer.toBase58(),
        vault,
        quoteMint: quoteMint.toBase58(),
        curveLines,
        image: { arweave: imageArweave, copy: pictureCopy, sha256: imageSha256 },
        promise,
      });
      const sheetSha256 = await sha256Hex(new TextEncoder().encode(sheet));
      const sheetUpload = await turbo.upload({
        data: sheet,
        dataItemOpts: { tags: [{ name: "Content-Type", value: "application/json" }] },
      });
      const sheetArweave = arweaveUrl(sheetUpload.id);
      mark("Record sheet stored on Arweave", sheetArweave);

      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const configTx = await client.partner.createConfig({
        ...buildLaunchConfig(
          launchChoice(draft),
          plan.openingBps,
          plan.endingBps,
          plan.platformFeePercent,
          DEFAULT_FEE_DECAY_SECONDS,
          plan.migrationFeeBps,
          quoteKind,
          undefined,
          undefined,
          plan.shape,
        ),
        config: keys.config.publicKey,
        feeClaimer: new PublicKey(PLATFORM_FEE_CLAIMER),
        leftoverReceiver: new PublicKey(PLATFORM_FEE_CLAIMER),
        payer,
        quoteMint,
      });
      const configSig = await sendPrepared(connection, await prepareTransaction(connection, payer, configTx, [keys.config]), signTransaction);
      mark("Template created", explorerTx(configSig, cluster));
      await waitForAccount(connection, keys.config.publicKey);

      let poolTx: Transaction | null = null;
      for (let attempt = 0; attempt < 8 && !poolTx; attempt += 1) {
        try {
          poolTx = await client.creator.createPool({
            baseMint: keys.baseMint.publicKey,
            config: keys.config.publicKey,
            name: draft.tokenName,
            symbol: draft.symbol.trim().toUpperCase(),
            uri: tokenUri,
            payer,
            poolCreator: payer,
          });
        } catch (cause) {
          if (!/config not found/i.test(cause instanceof Error ? cause.message : "")) throw cause;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!poolTx) throw new Error("The new template was not visible yet.");
      const poolSig = await sendPrepared(connection, await prepareTransaction(connection, payer, poolTx, [keys.baseMint]), signTransaction);
      mark("Token created. Its link names the record.", explorerTx(poolSig, cluster));

      const recordTx = new Transaction().add(
        ...recordInstruction({
          endpoint: connection.rpcEndpoint,
          asset: keys.record,
          payer,
          vault: new PublicKey(vault),
          name: draft.assetName,
          uri: sheetArweave,
          attributes: recordAttributes({
            mint: keys.baseMint.publicKey.toBase58(),
            pool,
            vault,
            creator: payer.toBase58(),
            symbol: draft.symbol.trim().toUpperCase(),
            quote: draft.quote,
            par: draft.par,
            poolPrice: draft.pool,
            handoffDays: draft.shipDays,
            declared: draft.declared,
            sheetSha256,
            imageSha256,
            title: titleAddress,
            titleHeldBy: railWords(plan.rail),
            serial: draft.serial,
            makerName: draft.makerName,
            escrowProgram: plan.rail === "escrow" ? ESCROW_PROGRAM[cluster] : undefined,
          }),
        }),
      );
      const recordSig = await sendPrepared(connection, await prepareTransaction(connection, payer, recordTx, [keys.record]), signTransaction);
      mark("Master sent to the program vault", explorerTx(recordSig, cluster));

      const titleTx = new Transaction().add(
        ...titleInstructions({
          endpoint: connection.rpcEndpoint,
          asset: keys.title,
          creator: payer,
          name: titleName(draft.assetName),
          uri: sheetArweave,
          attributes: titleAttributes({
            record: recordAddress,
            mint,
            pool,
            creator: payer.toBase58(),
            rail: plan.rail,
            delayDays: Number(draft.saleDays),
            burnPercent: SALE_BURN_PERCENT,
            venue: plan.venue,
            program: ESCROW_PROGRAM[cluster],
            sale: draft.sale,
            shortClock: cluster === "devnet" && plan.rail === "escrow",
          }),
        }),
      );
      const titleSig = await sendPrepared(connection, await prepareTransaction(connection, payer, titleTx, [keys.title]), signTransaction);
      mark(`Title minted to your wallet${plan.rail === "creator" ? ". It stays there until the sale" : ""}`, explorerTx(titleSig, cluster));

      let depositSig: string | undefined;
      if (plan.rail === "escrow") {
        if (!escrowDepositAllowed(cluster, payer.toBase58())) {
          throw new Error("The escrow path is not available on this network.");
        }
        await waitForAccount(connection, keys.title.publicKey);
        const depositTx = new Transaction().add(
          escrowDepositInstruction({
            program: new PublicKey(ESCROW_PROGRAM[cluster]),
            creator: payer,
            title: keys.title.publicKey,
            record: keys.record.publicKey,
            mint: keys.baseMint.publicKey,
            pool: new PublicKey(pool),
            price: openingEscrowPrice(draft.declared, draft.par),
            delayDays: Number(draft.saleDays),
            burnPercent: SALE_BURN_PERCENT,
            sale: draft.sale,
          }),
        );
        depositSig = await sendPrepared(connection, await prepareTransaction(connection, payer, depositTx, []), signTransaction);
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
      void fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool, cluster }),
      }).catch(() => undefined);
      setFinished({ pool, record: recordAddress, title: titleAddress });
      setPlan(null);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "The create stopped."} Steps marked done are already stored. Press Review create to start fresh.`,
      );
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card record-create">
      <p className="eyebrow">Create</p>
      <h2>Token, record, and title</h2>
      <p className="note">
        The coin, the record, and the title are one asset. The coin is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share, and it pays nothing. The coin trades.
        The master holds the picture, every word on the record sheet, the token mint, and the pool. It is sent to
        the program vault and stays there. One edition is made. That edition is the title, and it carries the same
        meta sheet. The NFT on the chain is the proof. PAR keeps a copy of those proofs.
      </p>
      <p className="note">
        The Tensor path keeps the title in your wallet. When the sale opens, you list it on its PAR sale page. That
        page uses Tensor&apos;s program, and the listing may also show on Tensor&apos;s own site. The escrow path
        puts the title into the PAR escrow. A buyer calls that program. It pays you, burns the share, and hands
        over the title. {ESCROW_COMING}
      </p>
      {cluster !== "devnet" ? (
        <p className="error">Records are made on the practice network only until the real network vault is set.</p>
      ) : null}
      {!finished ? (
        <div className="record-promises">
          <p className="eyebrow">Creator promises</p>
          <p className="note">
            Two NFTs are made. The master is sent to the program vault and stays there. One edition is made. That
            edition is the title, and it goes to the {railWords(rail)}. You sign these words with your wallet, and
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
        <button type="button" className="solid" disabled={busy || !agreed || cluster !== "devnet"} onClick={() => void review()}>
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
            <button type="button" disabled={busy} onClick={() => setPlan(null)}>
              Cancel
            </button>
            <button type="button" className="solid" disabled={busy} onClick={() => void run()}>
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
          <Link href={`/pool/${finished.pool}`}>Open the pool page</Link>.{" "}
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
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
