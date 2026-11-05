# noid-trade

The browser trade engine behind `public/noid-trade.wasm`. It lets the built-in
wallet trade Parano1d native tokens without any key leaving the device.

Parano1d has no signatures: a spend carries a zero-knowledge proof that the
sender knows the secret behind the address. For one trade:

1. The node prepares an unsigned plan for the wallet's address
   (`paranoid_prepareNativeIntent`, relayed by `/api/swap/intent`).
2. `noid_trade_review` checks the plan before anything is proven: the chain is
   mainnet, the parent block and plan ID hash match, the request is exactly
   what the user typed (the wallet builds it from the inputs, not from the
   server), the minimum output respects the slippage, the fee is within the cap
   shown, and the output goes back to the user's own address.
3. `noid_trade_authorize` derives the spend secret for the address index, checks
   it owns the plan's address, and runs the owner proof locally (prepare, begin,
   prove, finish). `finish` runs the chain's own verifier, and the result is
   verified again as a complete intent before it is returned.
4. The wallet posts the finished intent to `/api/swap-submit`, which relays it
   to `paranoid_submitTxIntent`.

It runs in `public/trade-worker.js`, a fresh worker per call that is terminated
afterwards. A proof takes about 7 seconds in desktop Chromium and needs about
8 MB of memory.

## Source

- [`ignotusnemo/parano1d-sdk`](https://github.com/ignotusnemo/parano1d-sdk) at
  `6ecef54d`, Apache-2.0. Its `vendor/` tree is Parano1d Core **v2.1.0**
  (`848209d5`): all 148 files pinned in `vendor/upstream.json` match the Core tag
  byte for byte. The SDK adds three modules and nothing else: the staged browser
  proving adapters (`noid_gkr/.../zk_authorization/web3.rs`,
  `noid_fri_binius/.../zk_capsule_pcs/web3.rs`) and a software multiply for
  wasm (`noid_core/.../hardware/web3_soft.rs`), each wired in by a one-line hook.
- Address derivation copies Core's `noid_node/src/wallet/keystore.rs`
  (`derive_spend_secret`). The tests check it against `public/noid-wallet.wasm`.
- Mainnet chain ID is Core's `native_chain_id()`, the genesis header hash
  (block 0: `860e7045…d610`). It is pinned in `public/wallet.js`.

## ABI

No wasm-bindgen. Every call returns a pointer to `[status u32][len u32][bytes]`
(0 = ok, 1 = error text); free it with `noid_free(ptr, 8 + len)`, which wipes it.

| Export | Input | Output |
|---|---|---|
| `noid_alloc(len)` / `noid_free(ptr, len)` | | buffer |
| `noid_trade_address(master32, index)` | seed bytes | `o1…` address |
| `noid_trade_review(json, len)` | plan JSON | review JSON |
| `noid_trade_authorize(master32, index, json, len)` | seed, index, plan JSON | authorized intent hex |
| `noid_trade_selftest()` | | proves a random throwaway statement |

The plan JSON is the SDK's `NativeOperationPlan`:
`{ native_plan, expected_request, expected_chain, expected_parent_hash, maximum_fee_micronoid }`.
The one import is `env.noid_random(ptr, len)`, filled from `crypto.getRandomValues`.

## Build

```sh
cd wasm/noid-trade
cargo build --release --target wasm32-unknown-unknown   # toolchain pinned in rust-toolchain.toml
cp target/wasm32-unknown-unknown/release/noid_trade.wasm ../../public/noid-trade.wasm
```

Bump `?v=` on `/noid-trade.wasm` in `public/trade-worker.js` and on
`/trade-worker.js` in `public/wallet.js` when the binary changes, so browsers
fetch the new one.
