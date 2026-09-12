# owls-e2e-consumer (Rust)

An external organization's crate. It depends on the **installed** package
(`../zed_modules/ores-wasm-loaders/owls-runtime`) exactly as
[owls-docs/docs/installation.md](https://github.com/ores-wasm-loaders/owls-docs/blob/main/docs/installation.md#3-connect-each-language)
documents, never on a sibling source checkout. The paths carry one extra `../`
because `zed_modules/` is installed at the repository root while this crate lives
in `rust/`.

**This crate is unbuilt in the authoring sandbox and is gated on the consuming
machine: crates.io is unreachable there, so `cargo` could not resolve, compile or
run any of it.** Every claim below is a claim about source that has been written
against the real published signatures in `owls-runtime` — not about a test run.

## What it proves once it runs

| Test file | Claim |
| --- | --- |
| `tests/corpus.rs` | `owls_runtime::parse_release` returns the same verdict for every case in `../corpus/release-corpus.json` as the TypeScript and Dart hosts do — including which layer (JSON Schema vs. host invariant) does the rejecting, and which host invariant. Valid releases also survive a serde round-trip unchanged. |
| `tests/transport.rs` | An organization-supplied `Transport` and `ByteStore` over in-memory maps drive the stock `Host` unmodified: verified bytes are reused, cancellation through the caller's `AtomicBool` stops work both before and during a fetch, a corrupted cache entry is ignored and refetched, an unverifiable response never reaches the cache, and budget checks run before the network does. |

## Running it

```sh
# from the repository root, after `zed install --frozen --install-mode copy`
cd rust
cargo generate-lockfile   # first time only; commit the resulting Cargo.lock
cargo test --locked
```

`Cargo.lock` is intentionally **not** committed by the authoring sandbox because
it could not be generated honestly there. Generate it on the first machine that
has crates.io access, review it, and commit it; CI then runs `cargo test --locked`
and fails loudly if the lock is missing or stale.

## Notes

- `[workspace]` is declared empty so this crate is its own workspace root. That
  matters: `[patch.crates-io]` only takes effect from the consumer root, and
  `owls-runtime`'s own patch table does not apply to a crate that depends on it.
- `owls-runtime` is edition 2024, so a Rust toolchain of 1.85 or newer is required
  even though this crate is edition 2021.
