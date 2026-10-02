"use client";

import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { useEffect, useState, type FormEvent } from "react";
import { ListingActions } from "@/components/ListingActions";
import { MainnetGate } from "@/components/MainnetGate";
import { useCluster } from "@/lib/cluster";
import {
  ENDS_AT,
  FEE_SCHEDULER,
  OPENS_AT,
  PRESETS,
  configPublicKey,
  quoteMintAddress,
  type ClusterName,
  type PresetId,
} from "@/lib/constants";
import { bpsToPercent, formatLamports, formatUsdc } from "@/lib/format";
import { loadPool } from "@/lib/load-pool";
import { prepareTransaction, sendPrepared, type PreparedTransaction } from "@/lib/send";

type Remembered = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  preset: PresetId;
  cluster: ClusterName;
};

type PendingCreate = {
  prepared: PreparedTransaction;
  lines: string[];
  poolAddress: string;
  name: string;
  symbol: string;
  mint: string;
  preset: PresetId;
};

type CardListing = {
  pool: string;
  name: string;
  symbol: string;
  mint: string;
  filling: boolean;
  percent: number;
  fullAt: string;
};

const STORAGE_KEY = "par.listings.v1";

function readRemembered(): Remembered[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as Remembered[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function remember(listing: Remembered) {
  const next = [listing, ...readRemembered().filter((item) => item.pool !== listing.pool)].slice(0, 24);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function symbolFromName(name: string): string {
  const compact = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.slice(0, 10) || "TOKEN";
}

function fullAtFor(threshold: BN, preset?: PresetId): string {
  if (threshold.eq(new BN(PRESETS.par.migrationQuoteThreshold))) return PRESETS.par.cardFull;
  if (preset && PRESETS[preset]) return PRESETS[preset].cardFull;
  return `${formatUsdc(threshold)} USDC`;
}

export function Desk() {
  const { cluster, setCluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [preset, setPreset] = useState<PresetId>("par");
  const [name, setName] = useState("");
  const [cards, setCards] = useState<CardListing[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCreate | null>(null);

  const spec = PRESETS[preset];
  const config = configPublicKey(cluster, preset);
  const symbol = symbolFromName(name);

  useEffect(() => {
    if (cluster !== "devnet" && preset === "demo") setPreset("par");
  }, [cluster, preset]);

  useEffect(() => {
    let cancelled = false;
    const presets: PresetId[] = cluster === "devnet" ? ["par", "demo"] : ["par"];
    const client = DynamicBondingCurveClient.create(connection, "confirmed");
    const remembered = readRemembered().filter((item) => item.cluster === cluster);

    async function load() {
      const seeds = new Map<string, { preset?: PresetId; name: string; symbol: string; mint: string }>();
      for (const item of remembered) {
        seeds.set(item.pool, {
          preset: item.preset,
          name: item.name,
          symbol: item.symbol,
          mint: item.mint || "",
        });
      }
      await Promise.all(
        presets.map(async (id) => {
          const key = configPublicKey(cluster, id);
          if (!key) return;
          try {
            const pools = await client.state.getPoolsByConfig(key);
            for (const pool of pools) {
              const address = pool.publicKey.toBase58();
              const existing = seeds.get(address);
              seeds.set(address, {
                preset: id,
                name: existing?.name || "Listing",
                symbol: existing?.symbol || "",
                mint: existing?.mint || "",
              });
            }
          } catch {
            // A missing config or a quiet RPC leaves the remembered rows in place.
          }
        }),
      );

      const loaded = await Promise.all(
        [...seeds.entries()].slice(0, 24).map(async ([pool, seed]) => {
          try {
            const snapshot = await loadPool(connection, pool);
            return {
              pool,
              name: snapshot.name || seed.name,
              symbol: snapshot.symbol || seed.symbol,
              mint: snapshot.baseMint,
              filling: !snapshot.isMigrated,
              percent: snapshot.percent,
              fullAt: fullAtFor(snapshot.threshold, seed.preset),
            } satisfies CardListing;
          } catch {
            return {
              pool,
              name: seed.name,
              symbol: seed.symbol,
              mint: seed.mint,
              filling: true,
              percent: 0,
              fullAt: seed.preset ? PRESETS[seed.preset].cardFull : PRESETS.par.cardFull,
            } satisfies CardListing;
          }
        }),
      );
      if (!cancelled) setCards(loaded);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [cluster, connection, message]);

  async function finish(next: PendingCreate) {
    if (!signTransaction) throw new Error("This wallet cannot sign transactions.");
    const signature = await sendPrepared(connection, next.prepared, signTransaction);
    remember({
      pool: next.poolAddress,
      name: next.name,
      symbol: next.symbol,
      mint: next.mint,
      preset: next.preset,
      cluster,
    });
    setMessage(`Pool created. Signature ${signature}`);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (preset === "demo" && cluster !== "devnet") {
      setError("The demo config stays on devnet.");
      return;
    }
    if (!publicKey || !signTransaction) {
      setError("Connect a wallet to sign createPool.");
      return;
    }
    const configKey = configPublicKey(cluster, preset);
    if (!configKey) {
      setError("This preset has no on-chain config yet. Run npm run create-config for it.");
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 32) {
      setError("Name must be 1 to 32 characters.");
      return;
    }
    const trimmedSymbol = symbolFromName(trimmedName);
    const trimmedUri = `${window.location.origin}/metadata.json`;

    setBusy(true);
    try {
      const baseMint = Keypair.generate();
      const client = DynamicBondingCurveClient.create(connection, "confirmed");
      const transaction = await client.creator.createPool({
        baseMint: baseMint.publicKey,
        config: configKey,
        name: trimmedName,
        symbol: trimmedSymbol,
        uri: trimmedUri,
        payer: publicKey,
        poolCreator: publicKey,
      });
      const prepared = await prepareTransaction(connection, publicKey, transaction, [baseMint]);
      const poolAddress = deriveDbcPoolAddress(
        quoteMintAddress(cluster),
        baseMint.publicKey,
        configKey,
      ).toBase58();
      const next: PendingCreate = {
        prepared,
        poolAddress,
        name: trimmedName,
        symbol: trimmedSymbol,
        mint: baseMint.publicKey.toBase58(),
        preset,
        lines: [
          `Action: createPool`,
          `Network: ${cluster}`,
          `Name: ${trimmedName}`,
          `Symbol: ${trimmedSymbol}`,
          `Config: ${configKey.toBase58()}`,
          `Base mint: ${baseMint.publicKey.toBase58()}`,
          `Pool: ${poolAddress}`,
          `Quote mint: USDC (${quoteMintAddress(cluster).toBase58()})`,
          `Opens at ${OPENS_AT}, ends at ${ENDS_AT}, full at ${spec.cardFull}`,
          `Pool creation fee: 0 lamports`,
          `USDC spent: 0`,
          `Network fee: ${formatLamports(prepared.feeLamports)}`,
          "Rent for the new mint, metadata, pool, and token vaults is charged in addition to that network fee.",
        ],
      };
      if (cluster === "mainnet-beta") {
        setPending(next);
        return;
      }
      await finish(next);
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the pool.");
    } finally {
      setBusy(false);
    }
  }

  const filling = cards.filter((card) => card.filling);
  const trading = cards.filter((card) => !card.filling);
  const quote = quoteMintAddress(cluster).toBase58();

  return (
    <div className="desk">
      <section className="lede">
        <p className="eyebrow">One rule</p>
        <h1>Name a token. It fills at $750.</h1>
        <p>
          Buyers trade a calm curve. It opens at {OPENS_AT}, ends at {ENDS_AT}, and at 750 USDC of buys
          Meteora opens a DAMM v2 pool. The fee starts at {bpsToPercent(FEE_SCHEDULER.startingFeeBps)} and
          decays to {bpsToPercent(FEE_SCHEDULER.endingFeeBps)}. There is no rate limiter.
        </p>
      </section>

      <form className="launch" onSubmit={onCreate}>
        <label>
          Token name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={32}
            placeholder="Name"
            required
          />
        </label>
        <p className="note">Symbol {symbol}. The wallet signs createPool. No USDC moves.</p>
        {cluster === "devnet" ? (
          <div className="segmented" role="group" aria-label="Preset">
            <button type="button" aria-pressed={preset === "par"} onClick={() => setPreset("par")}>
              Par · {PRESETS.par.cardFull}
            </button>
            <button type="button" aria-pressed={preset === "demo"} onClick={() => setPreset("demo")}>
              Demo · {PRESETS.demo.cardFull}
            </button>
          </div>
        ) : null}
        <button className="solid" type="submit" disabled={busy || !config || name.trim().length === 0}>
          {busy ? "Building…" : "Sign"}
        </button>
        {!config ? (
          <p className="note">
            Run <code>npm run create-config -- --preset {preset} --cluster devnet --payer keys/payer.json</code>{" "}
            before the first pool.
            {cluster === "mainnet-beta" ? " Mainnet config creation is a separate confirmation." : ""}
          </p>
        ) : null}
      </form>

      <section className="rows">
        <div>
          <h2>Filling</h2>
          {filling.length === 0 ? <p className="note">No curve is filling.</p> : null}
          <div className="card-grid">
            {filling.map((card) => (
              <ListingCard key={card.pool} card={card} quoteMint={quote} />
            ))}
          </div>
        </div>
        <div>
          <h2>Trading</h2>
          {trading.length === 0 ? <p className="note">Nothing has graduated yet.</p> : null}
          <div className="card-grid">
            {trading.map((card) => (
              <ListingCard key={card.pool} card={card} quoteMint={quote} />
            ))}
          </div>
        </div>
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="status">{message}</p> : null}
      {cluster === "devnet" ? (
        <p className="note">
          The demo uses the same curve and fills at {PRESETS.demo.thresholdLabel}, so one sitting can create,
          buy, complete, and migrate. It needs devnet USDC from the{" "}
          <a href="https://faucet.circle.com/">Circle faucet</a> and devnet SOL from the{" "}
          <a href="https://faucet.solana.com/">Solana faucet</a>. The opening fee is{" "}
          {bpsToPercent(FEE_SCHEDULER.startingFeeBps)}, so a completing buy sends more USDC than the threshold.
        </p>
      ) : (
        <p className="note">
          Mainnet uses the Par rule only.{" "}
          <button type="button" className="text" onClick={() => setCluster("devnet")}>
            Use devnet
          </button>
        </p>
      )}

      {pending ? (
        <MainnetGate
          title="Create this pool on mainnet?"
          lines={pending.lines}
          confirmLabel="Sign createPool"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const next = pending;
            setPending(null);
            setBusy(true);
            finish(next)
              .then(() => setName(""))
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not create the pool.");
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}

function ListingCard({ card, quoteMint }: { card: CardListing; quoteMint: string }) {
  const sharePath = `/pool/${card.pool}`;
  return (
    <article className="card">
      <h3>
        {card.name} {card.symbol ? <span>{card.symbol}</span> : null}
      </h3>
      <p className="rule">
        opens at {OPENS_AT}, ends at {ENDS_AT}, full at {card.fullAt}
      </p>
      {card.filling ? (
        <p className="note">{card.percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% to graduation</p>
      ) : (
        <p className="note">Trading on DAMM v2</p>
      )}
      <ListingActions
        name={card.name}
        mint={card.mint}
        fullAt={card.fullAt}
        viewHref={sharePath}
        sharePath={sharePath}
        quoteMint={quoteMint}
      />
    </article>
  );
}
