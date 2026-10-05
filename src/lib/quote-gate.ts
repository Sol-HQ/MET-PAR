import { DynamicBondingCurveClient, deriveTokenBadgeAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  getMint,
  getTokenMetadata,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { USDC_DEVNET, USDC_MAINNET, WSOL } from "./constants";

export const METEORA_DISCORD = "https://discord.gg/meteo";
export const DBC_BADGE_DOCS = "https://docs.meteora.ag/core-products/dbc/token-2022-support";
/** This form is for a DAMM v2 or DLMM badge. It does not create a DBC quote badge. */
export const DAMM_BADGE_FORM = "https://forms.gle/59n3zDiGS2C6qMfd7";

const ALLOWED_EXTENSIONS = new Set<number>([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function readBorshString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset, true);
  const start = offset + 4;
  return {
    value: new TextDecoder().decode(bytes.subarray(start, start + length)).replaceAll("\0", "").trim(),
    next: start + length,
  };
}

async function quoteSymbol(connection: Connection, mint: PublicKey): Promise<string> {
  const [metadata] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  );
  const account = await connection.getAccountInfo(metadata, "confirmed");
  if (account) {
    try {
      const name = readBorshString(account.data, 65);
      const symbol = readBorshString(account.data, name.next);
      if (symbol.value) return symbol.value;
    } catch {
      // Token-2022 metadata lives on the mint when Metaplex metadata is absent.
    }
  }
  try {
    const metadata = await getTokenMetadata(connection, mint, "confirmed");
    return metadata?.symbol?.replaceAll("\0", "").trim() || "quote";
  } catch {
    return "quote";
  }
}

export type QuoteCheck = {
  ok: boolean;
  mint: string;
  decimals: number;
  symbol: string;
  /** Set when Meteora has already badged this quote. Pass it on create. */
  badge: string | null;
  /** stock means keepers can open it around $750. open means no badge was required. */
  path: "open" | "badge" | "blocked";
  message: string;
};

function blocked(mint: string, message: string): QuoteCheck {
  return { ok: false, mint, decimals: 0, symbol: "", badge: null, path: "blocked", message };
}

export async function checkQuoteMint(connection: Connection, mintText: string): Promise<QuoteCheck> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText.trim());
  } catch {
    return blocked("", "Paste the quote mint address.");
  }
  const address = mint.toBase58();
  if (address === USDC_MAINNET || address === USDC_DEVNET) {
    return blocked(address, "That mint is USDC. Use the USDC button.");
  }
  if (address === WSOL) {
    return blocked(address, "That mint is wrapped SOL. Use the SOL button.");
  }
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    return blocked(address, "That mint is not on this network. Stock badges live on the real network.");
  }
  const owner = info.owner.toBase58();
  if (owner === TOKEN_PROGRAM_ID.toBase58()) {
    const spl = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
    return {
      ok: true,
      mint: address,
      decimals: spl.decimals,
      symbol: await quoteSymbol(connection, mint),
      badge: null,
      path: "open",
      message:
        "This is a standard token. A launch can use it as the quote. No badge is required. On the real network, Meteora opens it by itself only if the token is on their keeper list, or Jupiter has verified it with an organic score above 50 and the raise is worth more than $750. Otherwise someone signs once on the token page.",
    };
  }
  if (owner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
    return blocked(address, "That account is not a token mint.");
  }
  const mintAccount = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mintAccount);
  const feeBps = fee
    ? Math.max(fee.newerTransferFee.transferFeeBasisPoints, fee.olderTransferFee.transferFeeBasisPoints)
    : 0;
  if (feeBps > 0) {
    return blocked(
      address,
      "This quote charges a transfer fee. Meteora rejects that on a bonding curve, even after a badge. The fee has to be zero.",
    );
  }
  const extensions = mintAccount.tlvData ? getExtensionTypes(mintAccount.tlvData) : [];
  const needsBadge = extensions.some((extension) => !ALLOWED_EXTENSIONS.has(extension));
  if (!needsBadge) {
    return {
      ok: true,
      mint: address,
      decimals: mintAccount.decimals,
      symbol: await quoteSymbol(connection, mint),
      badge: null,
      path: "open",
      message:
        "This Token-2022 quote only uses metadata, and its transfer fee is zero. A launch can use it. No badge is required.",
    };
  }
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const badge = await client.state.getTokenBadge(mint).catch(() => null);
  if (!badge) {
    return blocked(
      address,
      `Meteora has not badged this quote. Stock tokens and other Token-2022 quotes with extra extensions need that badge before a launch can use them. PAR cannot create it. A Meteora operator creates it. Ask in the Meteora Discord and send this mint. Say you need a DBC token badge for a quote. The DAMM and DLMM badge form is a different badge and does not unlock this launch.`,
    );
  }
  return {
    ok: true,
    mint: address,
    decimals: mintAccount.decimals,
    symbol: await quoteSymbol(connection, mint),
    badge: deriveTokenBadgeAddress(mint).toBase58(),
    path: "badge",
    message:
      "Meteora has badged this quote for the bonding curve. A launch can use it. On the real network, Meteora opens a stock quote by itself once the quote collected is worth at least $750. Graduation does not need a second DAMM badge. Their migration config already allows a badged quote.",
  };
}
