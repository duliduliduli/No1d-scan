# Handoff: trading tokens with the built-in wallet

Last updated 2026-11-05. Repo `duliduliduli/No1d-scan`. Every push to `main` runs the
tests and deploys to the droplet behind https://parano1d-scan.com about a minute later.

## Goal

A user with the built-in browser wallet opens a token page, presses **Trade**, and buys
or sells on Parano1d's native DEX (v2.1 native assets). No key ever leaves the browser.

## Status

| Piece | State |
|---|---|
| Trade card on the token page (`mountTrade`) | **Live.** Shows Buy/Sell, amount, slippage, Review, Confirm. |
| Phone **Trade** button | **Fixed** in `ea85b16` (see "Bugs found"). It now scrolls to the live card. |
| Native trading switch on the server | **On by default** (`intent.js`). `SWAP_ENABLED=false` in `/etc/noid-scan.env` turns it off. |
| Live node prepares real plans | **Verified** (`paranoid_prepareNativeIntent` returns a plan for any real address). |
| Wallet's engine checks a real live plan | **Verified**: accepts it, refuses a different amount, a lower fee cap and another chain. Run `scripts/check-trade-plan.mjs` to repeat. |
| Ownership proof in the browser | **Verified** with a throwaway key: passes the chain's verifier in Node and in Chromium, ~7 s on desktop, ~8 MB. |
| **A real trade, proven with a funded wallet and accepted by the node** | **Not done yet.** Needs the owner's funded wallet; nobody has pressed Confirm on a real trade. This is the next step. |

## Why trading never worked before

1. **No prover.** Parano1d has no signatures. A spend carries a zero-knowledge proof that
   the sender knows the secret behind the address, made on the user's device. The old
   wallet (`noid-wallet.wasm`) only derives addresses. Its source (`~/noid-wallet-wasm` on
   another machine) was never pushed and is lost; `duliduliduli/noid-wallet-` holds only a
   README. `signAndSubmit` threw on purpose.
2. **Server switch off.** `SWAP_ENABLED` was unset on the droplet, so `/api/swap/intent`
   answered "trading is off". The agent has no SSH access to the droplet, only the deploy
   pipeline, so the default was flipped in code instead.
3. **Token page never got the trade flag** (fixed last). See "Bugs found".

## How a trade works now

```
token page (mountTrade) ──► No1dWallet.prepareTrade ──► GET /api/swap/intent ──► node: prepareNativeIntent
                                     │                         (intent.js)          (unsigned plan)
                                     ▼
                       trade-worker.js: noid_trade_review   ← checks the plan, nothing proven yet
                                     │
             user presses Confirm (passphrase if locked)
                                     ▼
                       trade-worker.js: noid_trade_authorize ← derive secret, prove, verify (on device)
                                     │
                                     ▼
                      POST /api/swap-submit ──► node: submitTxIntent
```

- `wallet.js` builds the request from what the user typed, **not** from the server's copy,
  so a server that changed the trade would be refused.
- The engine refuses a plan unless all of these hold: chain is mainnet (genesis hash
  `860e7045…d610`, pinned in `wallet.js`), the parent header and plan ID hash match, the
  request matches exactly, minimum output respects the slippage, fee ≤ fee limit ≤ the cap
  shown, output goes to the owner's own address, funding comes from the owner.
- `authorize` also checks the derived address equals the plan's owner, and verifies the
  finished intent once more before returning it.
- A plan is valid for 3 blocks (`valid_until = candidate + 3`, about 90 s).

## Files

| File | What it is |
|---|---|
| `wasm/noid-trade/` | Rust source of the engine. README has provenance, ABI and build steps. `Cargo.lock` is committed. |
| `public/noid-trade.wasm` | Built engine (1.3 MB). Must be rebuilt from `wasm/noid-trade` when the source changes. |
| `public/trade-worker.js` | Runs the engine in a fresh Web Worker per call, terminated afterwards. |
| `public/wallet.js` | `prepareTrade`, `confirmTrade`, `unlock`, `tradeRows`, `selftest` on `window.No1dWallet`; also the wallet page's own trade panel. |
| `public/index.html` | `mountTrade(d, id)` (live card); `mountSwap` is only the `?demo=1` sample card now. |
| `intent.js` | `/api/swap/intent` (prepare) and `/api/swap-submit` (relay). Named RPC params, which the node accepts. |
| `server.js` | Static routes for the engine and worker; `withIntent` on `/api/tokens/:id`. |
| `scripts/check-trade-plan.mjs` | Live, read-only check: fetches a real plan and runs the engine's review on it. |
| `test.js`, `test-promote.js` | Engine vs wallet addresses, self-proof, malformed plan refused, full-size intent relays, token route carries the flag. |

Engine source: official SDK `ignotusnemo/parano1d-sdk` at `6ecef54d` (Apache-2.0). Its
`vendor/` is Parano1d Core v2.1.0 (`848209d5`): all 148 files pinned in
`vendor/upstream.json` were checked byte for byte against the Core tag. The SDK only adds
three browser-proving modules. Seed → secret derivation copies Core's
`noid_node/src/wallet/keystore.rs` and was checked against the production wallet engine on
1,050 random seed/index pairs (0 mismatches).

## Bugs found along the way

1. **Trade button did nothing on token pages (the issue in the screenshot).** The page loads
   `/api/tokens/:id`; only the unused `/api/token/:id` route added `swap.intent`, so
   `tradeOn` was false and the page rendered the locked "Buy and sell open here soon" card.
   The phone Trade button scrolls to that card, so it looked dead. Fixed by wrapping the
   `tokens` route in `withIntent`. **Lesson:** the earlier browser test injected
   `swap.intent.enabled` itself and hid this; the new test reads the real route. Don't
   fake server fields in UI tests.
2. **Submit size limits too small** for a proven intent (~77 KB authorization bundle). Raised
   to 4 MB hex and a 4.2 MB request body.
3. Test artifact, not a bug: Playwright's `route.fetch()` drops `sec-fetch-site`, and the
   server then demands an API key. Pass the header through when intercepting.

## What to do next

1. **One real trade.** The owner opens https://parano1d-scan.com/wallet, unlocks or creates
   the wallet, funds it with a little NOID, opens a token (NEMO is the most active:
   `/token/26dd19b5a9c4431ede91f25ed1fb7df69ae85f77eab2b8d3c87e83dd9b58ff0a`), presses
   Trade → Review trade → Confirm buy, and reports the transaction ID or the exact error.
2. If it fails, the likely places, in order:
   - **Plan expires before submit.** Valid ~90 s. Proving is ~7 s on desktop Chromium;
     phones are unmeasured and could be 20–40 s, plus PBKDF2 (600k rounds) on unlock. The
     wallet's error mentions "a new block arrived" for state/parent errors; re-review fixes it.
   - **`submitTxIntent` response shape.** `confirmTrade` reads `result` as a string or
     `result.txid` / `result.intent_id`. If the node returns something else, the trade may
     succeed but show no ID.
   - **Wrong address index.** Trades use the index in `no1d_wallet_identity_v1`
     (the receive index last shown on the wallet page). If funds sit at a different index,
     the node plans an unfunded trade. One owner per transaction is a consensus rule.
   - **Node rejects the intent.** The error text is passed straight to the UI.
   - **iOS Safari.** Workers and wasm should work but are untested on a real iPhone.
3. Repeat the live engine check any time:
   `node scripts/check-trade-plan.mjs <any real o1 address>`.
   It prints the plan's numbers and confirms tampered plans are refused. Behind a proxy,
   Node needs `NODE_USE_ENV_PROXY=1`.

## Decisions left to the owner

- **No explorer fee on native trades.** The v2.1 request has no fee output; `SWAP_FEE_BPS` /
  `SWAP_FEE_ADDRESS` only apply to the old quote/build path, which the v2.1 node does not
  support. Charging a fee would need a separate payment step.
- **Plain NOID sends** are not built. The engine supports payments (`WalletOperation::Spend`);
  only the send screen is missing.

## Constraints for the next agent

- No SSH to the droplet. Server settings live in `/etc/noid-scan.env`, edited by the owner.
- Never move real funds, run payments or edit the production database without the owner's
  explicit approval (HANDOFF.md, rules).
- Rebuilding the engine runs third-party Rust code, which the session's Auto permission mode
  blocks; the owner switched to Accept edits to allow it.
- The general project handoff is `HANDOFF.md` (section 14 covers this feature; section 13
  covers native token names and logos).
