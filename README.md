# PAR

PAR is a one-rule launchpad for [Meteora’s Dynamic Bonding Curve](https://docs.meteora.ag/core-products/dbc/what-is-dbc). A creator names a token and signs `createPool`. Buyers trade on the PAR page. At 750 USDC of buys, Meteora opens a DAMM v2 pool. Jupiter can route that pool once it is indexed. The home page rows are Filling and Trading.

Built for the [Superteam Earn listing](https://superteam.fun/earn/listing/meteora-dbc/). Deadline 13 October 2026, 06:59 UTC. Prize pool 20,000 USDC (10,000 / 5,000 / 3,000 / 1,500 / 500).

The desk uses Meteora’s program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`. It does not ship a custom program, a PAR token, a DLMM maker, chat, points, a config marketplace, or an oracle.

## The curve

Both presets are one segment. The quote is USDC. The chain opens at 0.999669023512 USDC and ends at 1.149619377038 USDC, a 1.15× multiple. Those prices round to $1.00 and $1.15, and the Par threshold is exactly 750 USDC (`750000000` base units). Migration is DAMM v2 at 25 bps, config `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd`. The base fee is an exponential scheduler from 50% to 1% over 60 periods and 60 minutes. Dynamic fees and the rate limiter are off. Graduated liquidity is permanently locked. Pool creation fee is 0.

| Preset | Graduation threshold | Where |
| --- | --- | --- |
| Par | 750 USDC | Meteora’s USDC keeper threshold |
| Demo | 1.109466 USDC | Devnet only, same curve, so one sitting can create, buy, complete, and migrate |

`npm run print-curve` rebuilds both configs with `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` and checks the segment count, price multiple, threshold, fee mode, and DAMM config.

## Why the quote is USDC

SPL quotes need no token badge. A Token-2022 stock quote with an extension such as a permanent delegate needs a TokenBadge, and only a Meteora operator with `CreateTokenBadge` can create one. If that badge already exists it can be passed as `tokenBadge`. If it does not, the mint has to be badged in [t.me/meteora_dev](https://t.me/meteora_dev). Transfer fee must be 0. USDC Par ships either way. See [DBC Token 2022 support](https://docs.meteora.ag/core-products/dbc/token-2022-support).

## Devnet first

```bash
npm install
npm run print-curve
npm run dev
```

Create the on-chain configs with a devnet keypair that holds SOL. This does not move USDC. The payer becomes the fee claimer and leftover receiver.

```bash
npm run create-config -- --preset par --cluster devnet --payer keys/payer.json
npm run create-config -- --preset demo --cluster devnet --payer keys/payer.json
```

Add `--dry-run` to print the amounts and network fee without sending. The script writes the public config address to `configs/published.json`. Secret keys stay in `keys/`, which is gitignored.

Demo buys need [devnet SOL](https://faucet.solana.com/) and [devnet USDC](https://faucet.circle.com/) (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). The opening fee is 50%, so filling the 1.109466 USDC demo curve takes about 2 USDC. Use “Size completing buy”, preview the quote, then sign. When the curve completes, sign `migrateToDammV2`. On mainnet, Meteora’s keepers migrate a USDC pool that reached 750 USDC.

## Mainnet

The app defaults to devnet. Choosing mainnet shows the exact amounts and waits for a second confirmation before the wallet opens. The config script refuses mainnet unless you have already read that printout and set `PAR_CONFIRM_MAINNET=yes`. The demo preset cannot be created on mainnet.

```bash
npm run create-config -- --preset par --cluster mainnet-beta --payer keys/payer.json --dry-run
```

Do not export `PAR_CONFIRM_MAINNET` until that dry run’s amounts are the ones you mean to sign.
