"use client";

import { useWallet, type WalletContextState } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { useMemo } from "react";
import { useCluster } from "./cluster";
import { walletChain, type ClusterName } from "./constants";

type AnyTransaction = Transaction | VersionedTransaction;
type SignOne = <T extends AnyTransaction>(transaction: T) => Promise<T>;
type SignMany = <T extends AnyTransaction>(transactions: T[]) => Promise<T[]>;

/** The parts of a Wallet Standard wallet this file reads. See @solana/wallet-standard-features signTransaction.ts. */
type StandardAccount = { address: string; chains?: readonly string[]; features?: readonly string[] };
type StandardSignInput = { account: StandardAccount; transaction: Uint8Array; chain?: string };
type StandardWallet = {
  accounts: readonly StandardAccount[];
  features: Record<string, unknown> & {
    "solana:signTransaction"?: {
      signTransaction: (...inputs: StandardSignInput[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
    };
  };
};

/** A Wallet Standard adapter (how Solflare, Phantom, and Backpack extensions show up in @solana/wallet-adapter-react). */
export function standardWalletOf(adapter: Adapter | null | undefined): StandardWallet | null {
  if (!adapter || !("standard" in adapter) || (adapter as { standard?: unknown }).standard !== true) return null;
  const wallet = (adapter as unknown as { wallet?: StandardWallet }).wallet;
  return wallet && wallet.features && "solana:signTransaction" in wallet.features ? wallet : null;
}

function bytesOf(transaction: AnyTransaction): Uint8Array {
  return transaction instanceof VersionedTransaction
    ? transaction.serialize()
    : new Uint8Array(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function sameKind<T extends AnyTransaction>(original: T, signed: Uint8Array): T {
  return (original instanceof VersionedTransaction ? VersionedTransaction.deserialize(signed) : Transaction.from(signed)) as T;
}

/** Wallets reject with plain objects such as { code: 4001, message }. send.ts reads Error.message, so keep the words. */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const message = cause && typeof cause === "object" && "message" in cause ? String((cause as { message?: unknown }).message) : "";
  return Object.assign(new Error(message || "The wallet did not sign this transaction."), { cause });
}

function standardAccount(wallet: StandardWallet, adapter: Adapter, cluster: ClusterName): StandardAccount {
  const address = adapter.publicKey?.toBase58();
  const account = wallet.accounts.find((item) => item.address === address);
  if (!address || !account) throw new Error("Connect the wallet again. Nothing was signed.");
  if (account.features?.length && !account.features.includes("solana:signTransaction")) {
    throw new Error("This wallet account cannot sign transactions. Nothing was signed.");
  }
  const chain = walletChain(cluster);
  // Only devnet reaches this. A wallet account that says it cannot sign on devnet is refused before it is asked.
  if (account.chains?.length && !account.chains.includes(chain)) {
    throw new Error("This wallet account does not offer Solana Devnet. Switch the wallet to Devnet or use a wallet that supports it. Nothing was signed.");
  }
  return account;
}

/**
 * signTransaction that names the network. @solana/wallet-standard-wallet-adapter-base's StandardWalletAdapter passes
 * `chain` only on sendTransaction, never on signTransaction, so a wallet asked to sign has to guess the network from
 * the blockhash. This passes `chain` ("solana:devnet" or "solana:mainnet") on every signature request. Wallets that are
 * not Wallet Standard (the Solflare SDK adapter, which is built with the network in Providers) are called as before.
 * Mainnet calls the adapter's own signTransaction unchanged, so a mainnet signature request is byte-for-byte what it
 * was before; it is only tagged with its cluster so send.ts can refuse a page and wallet request that disagree.
 */
export function clusterSignTransaction(adapter: Adapter | null | undefined, cluster: ClusterName, fallback?: SignOne) {
  const wallet = standardWalletOf(adapter);
  const feature = wallet?.features["solana:signTransaction"];
  let sign: SignOne | undefined;
  if (cluster === "devnet" && wallet && feature && adapter) {
    sign = async <T extends AnyTransaction>(transaction: T): Promise<T> => {
      const account = standardAccount(wallet, adapter, cluster);
      const [output] = await feature
        .signTransaction({ account, transaction: bytesOf(transaction), chain: walletChain(cluster) })
        .catch((cause: unknown) => {
          throw asError(cause);
        });
      if (!output?.signedTransaction) throw new Error("The wallet did not sign this transaction. It was not sent.");
      return sameKind(transaction, output.signedTransaction);
    };
  } else if (fallback) {
    sign = (transaction) => fallback(transaction);
  }
  return sign ? Object.assign(sign, { cluster }) : undefined;
}

export function clusterSignAllTransactions(adapter: Adapter | null | undefined, cluster: ClusterName, fallback?: SignMany) {
  const wallet = standardWalletOf(adapter);
  const feature = wallet?.features["solana:signTransaction"];
  let sign: SignMany | undefined;
  if (cluster === "devnet" && wallet && feature && adapter) {
    sign = async <T extends AnyTransaction>(transactions: T[]): Promise<T[]> => {
      const account = standardAccount(wallet, adapter, cluster);
      const chain = walletChain(cluster);
      const outputs = await feature
        .signTransaction(...transactions.map((transaction) => ({ account, transaction: bytesOf(transaction), chain })))
        .catch((cause: unknown) => {
          throw asError(cause);
        });
      if (outputs.length !== transactions.length) throw new Error("The wallet did not sign every transaction. Nothing was sent.");
      return transactions.map((transaction, index) => sameKind(transaction, outputs[index].signedTransaction));
    };
  } else if (fallback) {
    sign = (transactions) => fallback(transactions);
  }
  return sign ? Object.assign(sign, { cluster }) : undefined;
}

export type ClusterWallet = Omit<WalletContextState, "signTransaction" | "signAllTransactions"> & {
  signTransaction: (SignOne & { cluster: ClusterName }) | undefined;
  signAllTransactions: (SignMany & { cluster: ClusterName }) | undefined;
  cluster: ClusterName;
};

/** useWallet, with every signature request carrying the header toggle's network. */
export function useClusterWallet(): ClusterWallet {
  const wallet = useWallet();
  const { cluster } = useCluster();
  const adapter = wallet.wallet?.adapter;
  const { signTransaction, signAllTransactions, publicKey } = wallet;
  const signOne = useMemo(
    () => (signTransaction ? clusterSignTransaction(adapter, cluster, signTransaction) : undefined),
    // publicKey is listed so the account lookup follows an account switch inside the wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter, cluster, signTransaction, publicKey],
  );
  const signMany = useMemo(
    () => (signAllTransactions ? clusterSignAllTransactions(adapter, cluster, signAllTransactions) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter, cluster, signAllTransactions, publicKey],
  );
  return { ...wallet, signTransaction: signOne, signAllTransactions: signMany, cluster };
}

/**
 * ArDrive Turbo pays for uploads on Solana mainnet only (its default Solana gateway is api.mainnet-beta.solana.com,
 * @ardrive/turbo-sdk utils/common.js defaultProdGatewayUrls). PAR keeps uploads under the free limit and Turbo signs
 * them with signMessage. On devnet a Turbo payment transaction would be a mainnet payment, so it is refused here.
 */
export function turboSignTransaction<T>(cluster: ClusterName, signTransaction: T): T {
  if (cluster !== "devnet") return signTransaction;
  return (async () => {
    throw new Error("Arweave uploads are paid on Solana mainnet. On Devnet PAR only stores files under the free upload limit. Nothing was signed.");
  }) as unknown as T;
}
