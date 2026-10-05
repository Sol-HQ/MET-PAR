# PAR

PAR is a Meteora Dynamic Bonding Curve launch where most tokens sold to buyers stay within 10% of one price. You set that price. A buyer now and a buyer later can pay nearly the same. The shelf is a share of the sale, and it lasts until those tokens are bought. The trading fee can fall over 1 hour, 6 hours, 12 hours, 24 hours, 48 hours, or 7 days, so a rush at the open costs more while the price is still near par. The last slice of the sale walks the price to the pool you set. The pool locks. Later buys can move the price higher, and later sells can move it lower.

Leave PAR off and the price climbs from the first token to the last.

The curve program is `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`. The app is [Meteora](https://app.meteora.ag). The curve docs are [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc).

A real-world asset is a separate page. It adds one master, sent to the program vault, and one edition, which is the title. The coin is a payment token and a meme. It pays for the title. The meme is the joy and heart of the object. It is not a share, and it pays nothing. After graduation the coin trades for a set number of days, and the creator lists the title through Tensor. PAR keeps a copy of the proofs. The NFT on the chain is the proof. The escrow path can be tested on the practice network by the platform wallets. It is not a mainnet option.

## Launches

Starter, Solid, and Deep use 1,000,000,000 tokens. With PAR off and USDC as the quote, they lock about $10,000, $25,000, and $50,000. 800,000,000 tokens are sold and 200,000,000 migrate. Thin test locks about $750 USDC. On the real network, $750 is the smallest USDC curve Meteora opens by itself. A larger USDC curve is opened the same way once it fills. With PAR on, those cards do not set the quote amount. The prices do.

Par fixed is only the shelf. It uses 1,000,000,000 tokens, opens at $0.00005, and the pool locks at $0.00006. About 466,589,438 tokens and about $27,995 USDC lock together.

Custom takes a supply and two prices. Turn PAR on for the shelf. The share of the supply that migrates fills in from those prices, as a percent and as a token count. Type either one and the other follows. The pool price moves with it. Par stays.

With PAR on, the pool price has to sit above the 10% shelf and at or under twice par. That band locks about 35% to 48% of the supply. The buttons are 35%, 40%, 45%, and 48%. At par $1, a pool of $1.20 locks 46.7%, which is 466,589,438 tokens. 35% is the low end, with the pool almost double par. 48% is the high end, just above the 10% shelf. A climb with PAR off still migrates at least 20%. On one billion tokens that is 200,000,000.

The quote is USDC or SOL. On a SOL curve, 0.002 and 0.0002 are fractions of one SOL, and a buyer can type ten dollars and PAR spends the SOL that ten dollars buys at the live price. USDC cards lock about $10,000, $25,000, $50,000, and $750. SOL cards lock 10 SOL, 25 SOL, 50 SOL, and 1 SOL. On the real network, Meteora opens a SOL curve by itself at 10 SOL. A 1 SOL curve is small enough to fill on the practice network, and someone signs once to open its trading pool. With PAR on, a price of 1 means 1 USDC or 1 SOL per token, and that lock is large. The creator chooses a falling fee or a flat fee, from 0.25% to 99%. A falling fee opens at the typed percent and falls to the settled fee over 1 hour, 6 hours, 12 hours, 24 hours, 48 hours, or 7 days. A flat fee stays at the typed percent on every trade until migration, and the clock is ignored. Of that fee, Meteora keeps 20%, the platform keeps the saved platform percent (20 unless an admin changes it), and the token creator receives the rest. Fees wait until they are claimed.

Before the curve fills, trading happens on this site. There is no Meteora trading pool yet. After the curve fills, the trading pool is on Meteora: app.meteora.ag on the real network, and devnet.meteora.ag on the practice network. Practice tokens do not show on Jupiter. Fun Launch is a starter for building a launch page. It is not a public list of these tokens.

After the curve fills, the creator chooses the pool fee: 0.25% (the default), 0.30%, 1%, 2%, 4%, or 6%. That fee is split the same way. Locked tokens and locked USDC stay in the pool. The claim buttons on this site withdraw the curve fee from before migration. A token already created keeps the split, the prices, the curve fee, and the pool fee written into its template.

## Run

```bash
npm install
npm run dev
```

Devnet is the default. A mainnet create shows the SOL rent and 0 of the quote token before the wallet opens. Devnet USDC comes from the Circle faucet, which sends about $20. Devnet SOL comes from the Solana faucet, so a 1 SOL practice curve can be filled and graduated.
