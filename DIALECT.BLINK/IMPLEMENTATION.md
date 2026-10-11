# PAR Tensor Blink — implementation and release runbook

**Current status: implemented locally; not enabled, deployed, or transaction-tested.** The Action routes fail closed unless the network-specific feature flag is explicitly set. The regular PAR/Tensor sale path has not been altered.

## What is implemented

- `provider.ts` resolves an item-specific listing by verifying the live Core title, sealed one-of-one collection/edition, immutable master record, record/title/index identity, exact sheet SHA-256, signed `payIn` mint, current Tensor listing seller/price/currency, and PAR sale-opening policy.
- The Action `GET` returns one clean fixed-price “Buy title” action. The price/total comes from the current Tensor listing; a disabled/stale/not-yet-open state fails closed with a concise JSON error.
- `POST` accepts only a wallet account, repeats all checks, and returns an unsigned legacy Solana transaction using PAR’s current Tensor Core/SPL purchase instruction. It requires the buyer as its only signer and is capped at 1,232 bytes. For SOL-denominated listings, “SOL” means the listing’s WSOL SPL mint; the transaction wraps only the buyer’s shortfall and leaves any existing WSOL intact.
- GET and POST use a Supabase atomic per-client rate limit keyed by an HMAC digest; raw IP and wallet addresses are not stored in the counter table. If the rate-limit database function or server configuration is unavailable, the Action fails closed.
- A per-network environment kill switch defaults to off. Neither devnet nor mainnet actions are exposed until explicitly enabled.
- `actions.json` maps only the existing `/t/{title}` URLs to their Action endpoints and supplies CORS. The existing sale page and OG fallback remain unchanged.
- The Handoff pipeline now refreshes a Helius hook immediately when its indexed title-address set changes, even during the old ten-minute refresh window. Seller sale mail uses an atomic database claim plus Resend’s idempotency header so concurrent/retried webhook and page requests do not normally send duplicate notices.

## Changed implementation files

- `DIALECT.BLINK/policy.ts`, `DIALECT.BLINK/transaction.ts` — isolated sale gate and buyer-only transaction builder.
- `DIALECT.BLINK/provider.ts` — live chain/sheet verification, Action JSON, rate limiting, POST transaction response.
- `DIALECT.BLINK/policy.test.ts`, `DIALECT.BLINK/transaction.test.ts` — policy, transaction signer/layout, WSOL funding, and size tests.
- `src/app/api/actions/title/[title]/route.ts`, `src/app/api/actions/icon/route.ts`, `src/app/actions.json/route.ts` — minimal Next route and discovery adapters.
- `src/lib/store.ts`, `src/lib/handoff-server.ts` — rate-limit and atomic mail-claim helpers; prompt Helius hook membership refresh; Resend idempotency.
- `supabase/migrations/0007_blink_rate_limit.sql` — private rate counters, atomic request-limit and sale-email-claim functions, plus Helius membership fingerprint.

## Mandatory database step before enabling

Apply `supabase/migrations/0007_blink_rate_limit.sql` to the project’s Supabase database **before deploying or setting either Blink flag to true**. The migration adds a private rate counter and two service-role-only functions, adds `addresses_sha256` to hook bookkeeping, and adds a stale-claim recovery timestamp/state to handoff rows. It keeps RLS on and revokes anonymous/authenticated access. Do not enable the Action if the migration has not been applied successfully.

## Local/devnet acceptance

1. Apply the migration to the intended Supabase project and verify `allow_blink_request` and `claim_handoff_sale_mail` work only with the service role. Verify anon/authenticated cannot select or execute them.
2. Set `PAR_BLINK_DEVNET_ENABLED=true` only in the local test environment. Leave `PAR_BLINK_MAINNET_ENABLED` unset/false. Existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and devnet RPC variables stay server-side.
3. Use a PAR-indexed Devnet title that is actively listed through Tensor and whose sheet/title/master validate. `GET /api/actions/title/{title}?c=devnet` must return the current currency and exact total. An unlisted title, changed payment mint, mismatched hash, missing collection, unopened attached-coin sale, or unknown coin status must return an error and no transaction.
4. POST a Devnet buyer wallet. Decode the base64 response and inspect every instruction. It must contain the idempotent buyer ATA instruction, only a WSOL shortfall wrap if needed, and the current Tensor purchase instruction. Confirm the only signer is the requesting buyer and no seller/server signer is required.
5. Run a real Devnet purchase only with a test title and buyer wallet after inspecting the wallet preview. Confirm title owner becomes that buyer, listing closes, seller receives the listing price, and only the expected fee is charged.
6. Open the canonical `/t/{title}?c=devnet` page afresh. Confirm it derives sold/claimed state from chain, the RWA sheet is intact, and the handoff desk recognizes the holder. For mail, use an explicitly subscribed test seller address; replay the webhook and race a handoff poll and confirm a single seller notice. Verify the buyer's signed handoff/contact flow and no email is sent merely from the Blink POST.
7. Test no-coin SOL/WSOL with wallets holding (a) enough WSOL already and (b) only native SOL, plus USDC and one ordinary SPL token if those listing cases exist. Confirm the wallet preview shows the exact maximum total and the transaction does not wrap extra SOL. Competing purchases should fail atomically without partial payment.
8. Test `OPTIONS`, GET/POST CORS from another origin, `/actions.json`, `Retry-After`, size limits, malformed wallet addresses, generic errors, canonical X/OG page fallback, and the Dialect/Solana Blink Inspector.

## Mainnet release gates

Mainnet is **not enabled by default and must stay off** until every item is checked:

- Apply and verify migration 0007 in the production Supabase project.
- Verify current live Tensor Marketplace deployment and the current listing decoder/instruction arguments against official program/client source and a live program/account. Confirm collection account, Core ownership transfer, current taker-fee maximum, royalty/plugin rules, and WSOL semantics. Existing source hand-packs Tensor instructions; this must not be accepted solely because TypeScript compiles.
- Confirm the production `MAINNET_RPC_URL`, Supabase service-role access, Helius key/webhook secret, and Resend sender credentials are present without printing their values. Verify the production Helius hook includes this title and `syncHeliusHook` can update it.
- Verify the seller subscription and email sending/claim retry path with a controlled test (do not contact a real seller without approval). Set up and verify the existing authenticated handoff reminder cron operationally; a cron is not declared in `vercel.json`.
- Complete the Devnet acceptance checklist above. Then inspect a mainnet GET-only response while the mainnet switch remains off from purchase (the current kill switch disables GET too; use source/chain review or a separately controlled preview environment rather than opening a live purchase action prematurely).
- For a real live buy test, agree on the exact title, maximum price, buyer wallet, and timing first. A Blink POST returns a real mainnet transaction once the mainnet flag is enabled. Treat activation and purchase as explicit operational steps; this local edit does not enable or deploy them.
- After rollout, monitor Action errors, Helius delivery/retries, handoff holds, and Resend outcomes. Keep `PAR_BLINK_MAINNET_ENABLED=false` as the immediate stop switch if anything disagrees.

## Verification performed in this workspace

- `npm exec tsc -- --noEmit --allowImportingTsExtensions` — passed.
- Focused policy tests — 4 passed.
- Focused transaction invariant tests — 5 passed, including the buyer-only signer check and WSOL wrapping cases.
- `npm run build` compiled the application routes successfully, then failed at type-check because the repository's pre-existing ignored `scripts/_mock-nft.ts` imports `.ts` paths while `allowImportingTsExtensions` is off for Next's build. The user-maintained ignored script was not modified. A direct workspace type-check with the explicit existing command above passed.
- Snyk Code scan could not complete: the installed Snyk service returned `SNYK-0003 / 400 Bad Request` for both a workspace scan and targeted `DIALECT.BLINK` scan. No clean Snyk result is claimed.
- No SQL migration was applied, no devnet transaction was signed, no production deployment was made, and no live mainnet action was enabled.
