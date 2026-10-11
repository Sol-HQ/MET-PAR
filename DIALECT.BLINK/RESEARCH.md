# PAR RWA Tensor sale Blink — research and implementation plan

**Research date:** 2026-10-10  
**Scope:** Project/protocol research and design baseline. The subsequent local implementation is tracked in [IMPLEMENTATION.md](IMPLEMENTATION.md); those routes remain disabled until migration, network tests, and explicit enablement.

## Executive summary

This is feasible as a **buy-now Blink for the single PAR title NFT already listed on Tensor**. The creator would continue using PAR's existing create/list flow; the Blink would let a buyer preview the live listing and request a wallet-signable Tensor purchase transaction. It should not mint, relist, change price, or custody assets.

A Solana Action is the API that returns metadata (`GET`) and an unsigned transaction (`POST`); a Blink is the shareable URL/client experience consuming that API. The transaction executes on Solana and Tensor—not in X or Discord. Users still need a compatible wallet/client and must explicitly review and sign. In unsupported apps the URL must fall back to the normal PAR sale page.

**Confirmed product semantics:** each Blink is for one specific RWA title NFT and one live Tensor listing. “10” means a price of 10 units in the currency of that listing—not ten copies. Currency is per listing: it may be the RWA's attached token (the usual case), USDC, native SOL, or another currency the listing/program supports. The Blink must discover and present that exact on-chain listing currency and its correct unit/decimals; it must never assume the RWA's attached token is the payment currency. Each other RWA/title gets its own item-specific listing/Blink state. The current product creates a one-of-one title: Core Master Edition `maxSupply: 1`, `numMinted: 1`, and edition 1. Tensor lists that one title, not ten copies.

**Where PAR captures it:** on the **No coin** RWA path, the Price step explicitly lets the creator choose USDC, “SOL,” or read another ordinary SPL token. The selected payment mint is carried into the review/sheet as `record.token.mint` and `record.title.sale.payIn`, alongside its token name, symbol, and decimals. This is distinct from `record.token.quote`/`quoteMint`: those fields describe the attached coin's Meteora curve quote and are not the Tensor title's currency. On the **coin attached** path, the attached coin itself pays for the title; the coin's SOL/USDC curve quote is not the Tensor purchase currency. Each title's own full sheet and on-chain record/title link provide the item-specific source of truth. Relevant implementation: `src/components/AssetDesk.tsx`, `src/components/RecordCreate.tsx`, `src/lib/record.ts`, and `src/lib/title.ts`.

**Live example confirmed 2026-10-10:** the production page for title `FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL` (PZ-4CO w/autograph) states that it has no paired coin, that a buyer pays in SOL, and that the Tensor listing is **0.3 SOL** with **0.306 SOL** shown as the buyer total. The current live page reports the listing is for sale. This is direct evidence for the user's described per-RWA currency behavior; older `PAR-MEMORY.md` notes saying it was not listed are a prior snapshot and are now stale.

**SOL implementation nuance:** PAR correctly presents the selected currency as **SOL** in the review/sheet and live sale page. Under the hood, the “SOL” choice resolves to the wrapped-SOL mint (`So11111111111111111111111111111111111111112`), which is an SPL token representing SOL, not native SOL lamports. The existing Tensor buy path is the SPL-currency Core instruction and creates the buyer's WSOL associated token account idempotently. It does not itself wrap native SOL into that account. A buyer with only native SOL may therefore need a wallet-side wrap or a separate explicit wrap instruction/UX; test this end to end and disclose the actual transaction. This distinction does not invalidate the product's SOL-denominated listing; it is a transaction-construction detail for Blink buyers. USDC and other ordinary SPL payment mints also use SPL-token instructions, with mint-specific decimals and account checks.

**Current implementation caveat:** the existing PAR Tensor listing builder serializes an SPL currency mint. The no-coin path sets it to the user's selected payment token (including WSOL for the SOL choice); the attached-coin path uses the attached mint. Do not infer the title currency from a bonding-curve quote or blindly from an assumed default; resolve the exact title-specific payment mint from the signed sheet and verify it against the live Tensor listing. Native SOL lamport settlement (as opposed to the product's SOL/WSOL currency) is not established by the current builder. Do not make a currency appear supported merely by changing Blink metadata.

## What the project does today

### Create and issue

- The RWA wizard and transaction flow are in `src/components/AssetDesk.tsx` and `src/components/RecordCreate.tsx`.
- A master record is created as a Metaplex Core asset owned by the configured vault; its attributes bind the record to the title, creator, payment token, and proof/sheet.
- The Tensor/creator rail creates a Core collection with Master Edition `maxSupply: 1`, then one Core title asset with Edition number 1. The collection is sealed. Relevant source: `src/lib/record.ts` and `src/lib/title.ts`.
- The title—not the master record and not the fungible payment token—is the item sold on Tensor. It is a claim/title NFT whose associated sheet and promises describe the real-world handoff. The Blink must not overstate what NFT ownership proves legally.

### List and buy

- The sale UI is `src/components/SaleTrade.tsx`; the sale details page is `src/app/t/[title]/page.tsx`.
- The creator sets a token-denominated price and signs a Tensor listing. The current UI contains business eligibility checks (for attached-coin RWA, graduation plus the configured waiting period). Standalone/no-coin listings have a different gate.
- The on-chain integration and listing-state reader are in `src/lib/tensor-sale.ts` and `src/lib/title.ts`. `titleStatus()` cross-checks the record/title and reports listing state, seller, currency, and title ownership. Current custom instruction constants include `LIST_CORE`, `BUY_CORE_SPL`, and `DELIST_CORE`; the buy transaction creates the buyer's associated token account idempotently and purchases the title.
- Tensor holds the Core title in its listing until purchase or delisting. There is no quantity-10 field in the visible sale builder. In the list instruction's encoded arguments, the byte at offset 17 is the `Some(currency)` option tag, followed by the SPL mint bytes—not a quantity. This agrees with Tensor's published Core listing instruction serialization.
- The app currently builds Tensor instructions by hand rather than depending on a Tensor SDK. The instruction discriminator, marketplace program address, Core account flow, and SPL buy account ordering align with the public `tensor-foundation/marketplace` generated client/source (`listCore`, `buyCoreSpl`). This is a useful corroboration, not a substitute for devnet and production-network tests.
- The current app's displayed buyer fee calculation is 2% above the seller's listed amount. Tensor's public marketplace docs describe a max 2% taker fee; royalties, currency-specific fees, or protocol changes must be checked against the actual Core asset/program terms rather than assumed away.

### Existing sale page / sharing fallback

- The sale page already creates dynamic Open Graph and X metadata from the title and RWA sheet in `src/app/t/[title]/page.tsx`, and the project has an X-sharing component (`src/components/ShareOnX.tsx`). These provide a useful ordinary-link preview/fallback; they do not by themselves make the URL an Action/Blink.
- The project public origin is configured in `src/lib/record.ts` (`PUBLIC_ORIGIN`). The site is documented as `www.meteora.surf` in `README.md`.
- No existing `actions.json` or Solana Action endpoint was found in `src`. `DIALECT.BLINK/` was empty when inspected.

## Recommended experience and API shape

### Purchase only, price and asset fixed by chain state

Use the sale-page URL as the canonical share target, mapped to an Action API by root `actions.json`. This lets ordinary social clients retain PAR's normal preview while Action-aware clients can discover the buy action. A direct `solana-action:` URL or Dialect interstitial can be a useful test/fallback, but a plain canonical HTTPS sale URL is easier to trust, read, and share.

Suggested logical route: `GET/POST /api/actions/title/{titleAddress}`. It should be derived from the sale address, not accept an arbitrary RPC URL, mint, seller, or transaction instructions from the caller.

**GET (public, read-only):**

1. Validate the title address and resolve only the configured production cluster/RPC.
2. Re-read the record, Core title, sealed collection/edition, creator, payment mint/decimals, current owner, and Tensor listing from chain. Verify the listing belongs to the declared creator and is priced in the record's payment token.
3. Mirror the existing product's sale-open rules, including graduation/delay where applicable. The Blink must not bypass a UI-only restriction: where the underlying Tensor program does not enforce that PAR rule, the API must refuse to offer or construct a buy transaction before the configured opening time.
4. Return Actions JSON with the RWA name/image, factual description, exact current price/currency, compact statement of the purchase/fee and that title ownership transfers. Offer one fixed buy action; do not accept a client-chosen price.
5. If the title is unlisted, already sold, delisted, invalid, or not yet eligible, return a disabled response or a specification-shaped error explaining the state. Avoid stale cache that continues to show a buy button after the listing changes.

**POST (wallet identified, unsigned transaction only):**

1. Parse and validate the request account as a Solana public key. Treat all request data as untrusted; only the account address and title path are user-supplied.
2. Repeat all chain and sale-eligibility checks immediately before construction. Fetch the listing price, currency and seller again; never trust values from the earlier GET or the POST query string.
3. Create the buyer ATA idempotently, then build the Tensor Core/SPL purchase instruction for that exact title, listing PDA, seller, currency mint, and buyer. Set a defensible maximum spend (price plus exact applicable taker fee/royalty margin), based on the official program's semantics. The transaction must require only the requesting buyer's signature; the server must never ask for a seed phrase or sign as the buyer/seller.
4. Set the buyer as fee payer, use a fresh confirmed blockhash, serialize as base64 in the Actions response, and return a clear `message` describing the title, seller's price, extra fees, and asset transfer. Consider simulation as an early failure check, not a guarantee that the listing remains unchanged by signing time.
5. Return JSON `ActionError` responses with appropriate status codes, CORS headers, and safe user-facing messages. Never expose RPC credentials or internal errors.

Solana transactions are atomic: if another buyer takes the listing first, the purchase should fail rather than charge for a second copy. The Blink UI/API should refresh after that error. Do not implement a backend reservation/custody layer.

## Standards, discovery, and social-platform reality

- The official Actions flow is `OPTIONS` for CORS preflight, `GET` for action metadata, then `POST` with `{ account }` for a base64 serialized transaction. The action must have an absolute HTTPS icon URL, meaningful title/description/button text, JSON content type, and standard CORS headers. Include `x-blockchain-ids` and `x-action-version` as applicable to the current Actions SDK/spec.
- Root `https://<domain>/actions.json` is the discovery mapping from the human-facing sale URL path to the Action API path; it also needs CORS/OPTIONS. Add it once and map only the title-sale path, not a broad catch-all that unintentionally declares unrelated routes as actions.
- Dialect's registry is separate from implementing the protocol. Dialect's current provider docs describe manual registration by email to `hello@dialect.to`, after a working action, clear description, thorough testing, secure implementation, and valid contact information. The registry status affects clients that suppress unregistered actions; registration is not a guarantee that every platform will render it.
- **Do not promise universal native unfurling.** Solana's official docs explicitly say each client chooses which Actions it supports and whether to require an allowlist. Dialect's docs specifically say registered actions can unfurl on social media such as X, while Discord may need an Action-aware bot/client; an ordinary Discord link remains a normal link. Facebook, X, and Discord can alter rendering/policies independently. Test the actual current clients at launch.
- The standard fallback is the existing ordinary PAR sale page. The underlying page should continue to show the same NFT, proofs, seller/listing status and purchase method if a social client has no Blink support. A wallet can still open the transaction in its native app.
- Existing OG/Twitter card metadata is valuable but not equivalent to a Blink registry entry. Dialect's `dial.to` interstitial is a quick prototype path; a hosted Action endpoint plus canonical sale-page mapping is the durable owned integration.

## Folder boundary and integration decision

The desired feature implementation can be kept **mostly** in `DIALECT.BLINK/`: provider domain logic, schemas, fixtures, tests, deployment notes, registration material, and this research. However, if Actions are to attach to the existing `www.meteora.surf/t/{title}` links, the running Next.js app also needs a very small route adapter under `src/app/api/...` and the root `actions.json` response under `src/app/actions.json/route.ts` (or equivalent static route with CORS). An isolated directory is not automatically served by Next.js.

Preferred compromise: keep all substantive feature code and tests inside `DIALECT.BLINK/`, with minimal app-router adapters that import it and a narrowly scoped `actions.json` mapping. Before choosing this, verify the Vercel build-root/tracing can include sibling-folder imports. A fully separate deployment rooted in `DIALECT.BLINK/` maximizes isolation but requires a separate domain/subdomain, independent data/chain validation and duplicated/shared logic; do not choose it just to avoid tiny route adapters.

No package install is needed for the research. At implementation time, evaluate `@solana/actions` for typed spec/CORS helpers. Tensor's current official Marketplace JS client is generated for the newer web3.js 2-style interfaces, whereas this app uses `@solana/web3.js` 1.x. Avoid a broad client migration solely for the Blink; either retain a verified instruction adapter or isolate a compatibility wrapper, pin the protocol/IDL version, and test that exact adapter. Do not add Dialect's client UI SDK to the PAR page just to make shared links: social clients consume the provider endpoint; embedding a Dialect client is a separate optional product feature.

## Original implementation phases

These were the research recommendations before implementation began. Current code and release gates are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

1. **Confirm remaining product choices:** “One item, price 10 in the live listing's currency” is confirmed. Decide whether the first release is buy-only, which network(s), sale timing policy, fee/royalty disclosures, and whether to share the canonical sale URL or a dedicated Blink URL. The no-coin creation flow already allows selection of USDC, wrapped SOL (presented as “SOL”), or another ordinary SPL token; validate that selected mint against the saved sheet and live listing for every title. If native SOL rather than WSOL is required, treat that as additional protocol/UX work.
2. **Protocol compatibility gate:** Record the production Tensor Marketplace program deployment/version and inspect the target title/listing/collection on that cluster. Compare current listing, buy, delist, fee, currency and royalty instruction layouts against the official Tensor program/client at the pinned revision. Confirm Vercel's production RPC supports Core and Tensor reads/simulation. Do not rely on stale docs/readme deployment dates as live-chain proof.
3. **Build isolated provider core in `DIALECT.BLINK/`:** title/listing resolver, eligibility policy, Actions JSON construction, purchase transaction builder adapter, API errors, tests/fixtures. Keep public RPC selection server-configured and fail closed if unavailable.
4. **Add thin Next route and discovery mapping:** Wire the Actions `GET`, `POST`, and `OPTIONS` through the existing Next app; add the exact-path `actions.json` mapping and retain the sale page's OG fallback. Ensure no secrets are included in public responses.
5. **Test before registering:** Unit-test parsing, eligibility, stale/unlisted/sold listings, decimals, fee ceiling, ATA creation, collection account, and malformed inputs. Test Actions Inspector/dial.to, CORS from a different origin, root actions.json, and normal OG scraping. On devnet, perform a real list/buy/delist cycle with test wallets and verify seller payment, buyer title ownership, and no unintended transfers. On mainnet, start with simulation/read-only validation and a deliberately controlled low-value listing only after protocol and operational approval.
6. **Operational/security rollout:** Add rate limiting and bounded RPC work; no user-controlled fetches/SSRF; log route/version and transaction outcomes without secrets; alert on RPC/program errors; document rollback/disable switch. Submit provider URL, source/domain proof, accurate disclosure and contacts to Dialect; re-test registry state and X/Discord clients before launch.

## Acceptance checklist

- [ ] “one title / one buyer” and interpretation of “10” approved.
- [ ] GET reads current mainnet listing and shows correct item, price, currency, network and fees.
- [ ] POST constructs only the fixed intended Tensor purchase; request account is the only required signer.
- [ ] Sale delay and all PAR safety gates are enforced server-side as well as in the UI.
- [ ] Tensor program/client version and mainnet deployment verified against a live account/program, not inferred from a program ID alone.
- [ ] Competing purchase, price/listing change, delist, wrong seller/currency, unsupported title, and expired state fail safely.
- [ ] Correct ATA, SPL decimals, taker fee, royalties and creator payout validated on chain.
- [ ] `OPTIONS`, GET, POST and `/actions.json` pass spec/CORS checks; no caching of transactional state.
- [ ] The ordinary PAR sale URL and rich metadata still work on clients without Blink support.
- [ ] Dialect registration is approved (if desired) and X/Discord/Facebook behavior is tested; no universal platform support claim.

## Research sources

### Project sources

- `src/components/AssetDesk.tsx`, `src/components/RecordCreate.tsx` — RWA creation UI and transaction orchestration.
- `src/lib/record.ts`, `src/lib/title.ts` — master/title creation, collection and edition checks, sale URL and Tensor state reads.
- `src/components/SaleTrade.tsx`, `src/lib/tensor-sale.ts` — current creator listing, buyer purchase and delist flow.
- `src/app/t/[title]/page.tsx` — buyer page, sale gates and OG/X metadata.
- `src/components/ShareOnX.tsx` — current X share affordance.
- `README.md` — product and title description.

### Official protocol/vendor sources

- [Solana Actions and Blinks specification](https://solana.com/docs/tools/actions) — lifecycle, endpoint/response requirements, CORS, actions.json, Blink URL and registry/client caveats.
- [Dialect: Build your first Blink](https://docs.dialect.to/blinks/blinks-provider/build-your-first-blink.md) — Next.js provider routes, `@solana/actions`, `OPTIONS`, GET/POST and fallback pattern.
- [Dialect: Register your Blink](https://docs.dialect.to/blinks/blinks-provider/blink-registry.md) — registry status, current submission process and client behavior.
- [Dialect: Fallbacks](https://docs.dialect.to/blinks/blinks-provider/fallbacks.md) — hosted fallback and dial.to interstitial tradeoffs.
- [Dialect: Error handling](https://docs.dialect.to/blinks/blinks-provider/advanced/error-handling.md) — input validation and `ActionError` response guidance.
- [Dialect: Track transactions](https://docs.dialect.to/blinks/blinks-provider/advanced/track-tx.md) — optional provider attribution/analytics references; not required for the first buy-only Blink.
- [Tensor: Sell or List](https://docs.tensor.trade/trade/get-started-with-tensors-amm/sell-or-list.md) and [Fees & Royalties](https://docs.tensor.trade/trade/fees-and-royalties.md) — listing, fees and royalty concepts.
- [Tensor: API & SDK](https://docs.tensor.trade/trade/api-and-sdk.md) — public API/SDK entry points; legacy market data API access is gated.
- [Tensor Foundation Marketplace source](https://github.com/tensor-foundation/marketplace) — current public Core instruction/client definitions; generated `listCore`, `buyCoreSpl`, and Core tests corroborate the instruction path and currency semantics. Mainnet program deployment and compatibility still require live verification.
- [TensorSwap SDK](https://github.com/tensor-foundation/tensorswap-sdk) — older SDK reference; do not conflate the legacy AMM SDK with the Core Marketplace client.

## Purchase-to-handoff fit and production reliability

### What already works conceptually

The Blink should submit the **same on-chain Tensor purchase** as PAR's website, not a different marketplace, escrow, or off-chain checkout. Tensor transfers the Core title to the buyer. The existing site reads the current title owner/listing from Solana on each dynamic sale-page request, so the chain—not a Blink-side database flag—is authoritative. Once the buyer owns the title, a newly loaded/refreshed sale page can show the completed/claimed state. The `HandoffDesk` also polls `/api/handoff` every 20 seconds, and that endpoint rereads the title owner and processes a new holder. Thus the Blink does not need to separately mutate the PAR item row to make a later page read the sale correctly.

The RWA creation route validates the record and title, saves the indexed title/sheet to Supabase, then requests that the Helius hook be synchronized. The mainnet hook is configured for successful `ANY` transactions touching indexed title accounts. A Tensor purchase includes the title account; the webhook then looks up the indexed title, rereads its current chain owner, creates a handoff hold, and attempts seller email. That same ownership transition is the signal for a Blink purchase, a PAR-site purchase, or a Tensor-site purchase. Handoff is based on current title ownership, not on where the buyer clicked.

### Conditions and gaps that matter

- **Seller email is conditional.** The creator must have subscribed a sale email. If they have not, the handoff is recorded in a waiting state; subscribing later can trigger delivery. Resend credentials and sender configuration must be present. The buyer is not automatically emailed just for buying: they visit the PAR sale page, connect/sign as the wallet holding the title, and may submit their contact details through the existing handoff desk. Keep this opt-in/signature-gated behavior; do not collect buyer email in the Blink.
- **Off-chain email cannot be atomic with the NFT purchase.** The sale can finalize even if Helius, Supabase, RPC, or Resend is unavailable. Present purchase success only after chain confirmation; describe handoff as following on PAR, not as already delivered. Link directly to the canonical sale page for handoff.
- **Helius synchronization has a new-title edge case.** `syncHeliusHook()` skips an update if the existing hook was refreshed within 10 minutes, without first comparing its address list to the newly indexed titles. A just-created title may therefore be missing from the hook during that window. Fix hook membership refresh so a newly indexed title is registered promptly (or enforce a safe, deduplicated background reconciliation) before calling notifications production-reliable.
- **There is no complete missed-event reconciliation today.** The handoff GET on the sale page can discover an owner change when someone opens that page, but a Blink-only buyer need not open it. The handoff cron currently processes titles with existing open reminder holds; it does not scan every indexed title for an initial purchase it missed. Helius is the primary event trigger. Add a scheduled bounded reconciliation over indexed titles (or a durable purchase-event queue) so a lost webhook does not strand seller mail. The session notes say the external handoff cron was not set up at the last recorded check; verify the current deployment rather than assuming it runs.
- **Duplicate notifications can race.** Both the Helius callback and a page's `/api/handoff` poll can call `noteHolder()` at once. The current insert/mark pattern can let two requests both observe a pending mail and send duplicates before either marks it sent. Add a durable unique event key and atomic claim/outbox state (and use the mail provider's idempotency feature if available). Keep retryable failure states; test that retries eventually send once and that repeat webhooks do not create duplicate letters.
- **The observed holder is not proof of a Tensor sale.** The current system classifies any non-creator/non-listing title owner as a holder and can call the event a purchase. That suits the existing page's transfer-based sale model but can mislabel a gift or another transfer. For this Blink, validate the successful transaction's Tensor program/listing/title/accounts and confirm the resulting owner before showing a purchase-specific success. Keep the normal handoff flow based on title possession.
- **UI freshness differs from backend freshness.** A full new page request reads current chain state. A tab that was already open does not automatically rerender its server-rendered sale heading just because a separate Blink confirmed; its handoff panel polls independently. Blink success should offer one clear “Open PAR handoff” link to the canonical page. Do not create a second persisted “sold” flag or claim the website was synchronously updated in the same transaction.
- **Eligibility must match the website.** For a no-coin RWA such as the live PZ-4CO example, listing opens when the creator lists it. For an attached-coin title, PAR applies the graduation plus delay gate. Mirror the relevant current UI gate in the Action API's GET and POST; recheck it immediately before transaction construction. Tensor itself may not enforce PAR's policy.
- **Currency presentation and buyer funds:** read the payment mint and exact amount from the sealed item sheet and current Tensor listing, check they agree, and display the buyer total. For a listing displayed as SOL, test a buyer with only native SOL: PAR currently represents SOL with WSOL and the existing buy builder only creates the WSOL ATA; it does not wrap native SOL. Either implement and test a safe funding/wrapping path without disturbing existing WSOL balances, use the native-SOL Tensor variant if that is the listing's actual currency, or clearly disable the Blink for wallets that cannot fund the listed currency. Never show a working Buy button if its transaction will predictably fail for the ordinary target wallet.

### Minimal, clean presentation

One image, one accurate item title, one compact fact line for edition/claim context, and one buy action. For the live PZ-4CO listing, suitable copy would be: **“PZ-4CO w/autograph title · Edition 1”**, **“0.3 SOL listed · 0.306 SOL total, including Tensor’s fee”**, then a short disclosure: **“You receive the title NFT. Physical handoff is arranged on PAR.”** Button: **“Buy title”**. Link the item name or a single secondary link to the PAR page, where the full sheet and handoff terms live. Keep the copy factual—no investment/price claims, urgency, redundant blockchain explanations, or invented guarantees. When sold or ineligible, replace the action with a concise unavailable state and a link to the sale page.

### Go/no-go

**Feasible and real:** a buyer who signs the returned Tensor transaction can purchase the actual listed title from the Blink. A fresh PAR page read will then derive the changed state from chain, and the existing handoff machinery can recognize the new holder.

**Not yet “solid” enough to promise hands-off production reliability without work:** promptly update Helius hook membership for each new title; add missed-webhook reconciliation and idempotent email delivery; verify seller subscription/mail readiness; mirror sale eligibility; and prove the SOL/WSOL buyer funding path. These are tractable, testable tasks—not reasons the Blink concept cannot work.

Release tests should include: buy the exact title through the Blink on devnet; assert the signed transaction matches the website's Tensor instruction and the buyer becomes Core owner; load/refresh the PAR page and assert its status changes; assert the indexed item remains intact; deliver one seller email to a subscribed test address; open `/api/handoff` as the new holder and complete the existing signed contact flow; replay and race webhook/page events and assert no duplicate email; simulate a dropped webhook then verify scheduled reconciliation; test a buyer with only native SOL and one with WSOL; and confirm a losing concurrent purchase fails without partial payment. Production deployment should follow these tests, then a low-risk live transaction and monitoring—not be inferred from a successful metadata preview.
