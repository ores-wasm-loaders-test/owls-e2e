# owls-e2e

An **external organization's** test suite for the OWLS release contract.

This repository belongs to a different GitHub organization than the packages it
tests. It consumes them the way any customer would: through `zed install`, from
`zed_modules/`, at pinned versions. Nothing here imports a `../sibling` source
directory, and nothing here forks coordinator internals — every extension point it
uses is a published interface.

It exists to answer two questions that no single package's own tests can answer:

1. **Do the three language hosts agree?** One JSON corpus,
   [`corpus/release-corpus.json`](corpus/release-corpus.json), is fed to the
   TypeScript, Rust and Dart hosts, and to the JSON Schema alone. All four must
   reach the same verdict on all **54** cases.
2. **Can an organization supply its own plumbing?** Each language suite injects
   its own transport, byte store and policy into the stock coordinator and shows
   the result still behaves.

## What this repository proves

- The release JSON Schema and the host-invariant layer are two distinct layers,
  and each case in the corpus is attributed to exactly one of them. A case
  labelled `host` is *verified with an independent validator* to pass the schema
  first, so it cannot silently be a schema failure in disguise.
- `parseRelease` in TypeScript, `owls_runtime::parse_release`, and Dart's
  `parseRelease` accept and reject the same releases for the same reasons: origin
  allowlisting, canonical-URL rejection (query, fragment, userinfo, uppercase
  host, explicit `:443`), duplicate asset id/URL, unknown entrypoint, and
  entrypoint-kind-vs-runtime mismatch across all three runtimes.
- An organization-supplied transport and byte store drive the stock coordinator
  in all three languages: verified bytes are reused, cancellation reaches the
  transport, a corrupted cached entry is evicted (or ignored) and refetched, an
  unverifiable response never reaches the cache, and budget checks run before the
  network does.
- Preparation performs no activation. The Node suite proves this with entrypoint
  bytes that verify correctly but can never compile: `prefetch` succeeds anyway,
  and the subsequent `activate` fails — which is what gives the first assertion
  its teeth.
- Release identity is content identity: re-registering `appId@release` with
  different asset bytes is a `release-conflict`, and a rebuild needs a new
  release ID.

## What this repository does **not** prove

- **Nothing in `rust/` or `dart/` has been compiled or run by the author.**
  crates.io and pub.dev were unreachable and no Dart/Flutter SDK was available in
  the authoring sandbox. Both are written against the real published signatures
  and are gated on the consuming machine. `rust/Cargo.lock` and `dart/pubspec.lock`
  are deliberately absent for the same reason — generate and commit them on the
  first machine that can.
- **Nothing in `browser/` has been executed.** It runs only against real
  `wasm-pack`/`flutter build web --wasm` output supplied by an operator and skips
  loudly otherwise. See [browser/README.md](browser/README.md).
- No claim about the real network: every transport in this repository is
  in-memory or a local fixture server. HTTP redirect handling, TLS, CORS and CDN
  behaviour are not exercised.
- No claim about actual framework execution in the Node suite. Compiling an
  8-byte WebAssembly preamble is not running a Leptos, Dioxus or Flutter app;
  that is the browser harness's job, and it has not been run.
- URL canonicalization is only compared on cases where all three URL parsers are
  expected to agree. Dot-segment normalization (`/a/../b`) and percent-encoding
  case normalization are deliberately **not** in the corpus: WHATWG URL (Node,
  Rust `url`) normalizes them and Dart's RFC 3986 `Uri` does not, so a shared
  corpus case would encode a divergence rather than a contract. See
  *Findings* below.

## The corpus

`corpus/release-corpus.json` is the shared authority. Every case is
`{name, expect, reason, origins, release}` plus an optional `code` (the
host-layer error class it expects) and an optional `deviation` (hosts where the
rejection is known not to carry the declared error type).

| `expect` | Meaning | Count |
| --- | --- | --- |
| `valid` | Passes the JSON Schema **and** every host invariant | 8 |
| `schema` | Rejected by `release.schema.json` itself | 28 |
| `host` | Passes the JSON Schema, rejected by a host invariant | 18 |
| | **Total** | **54** |

The eight valid releases cover all three runtimes (`raw-wasm`, `wasm-bindgen`,
`flutter-web`), a release carrying `extensions`, a multi-origin multi-asset
release, and both `bytes` boundaries (1 and 268435456).

SHA-256 values in the corpus are real lowercase 64-hex digests computed over a
deterministic label; no parse-level check hashes payload bytes, so the corpus does
not ship megabytes of fixture content. Where real bytes are needed — the Node,
Rust and Dart transport suites — the digests are computed at runtime from the
actual fixture bytes.

## Running each layer

```sh
# 0. Install the published packages (see owls-docs/docs/installation.md)
bash /path/to/owls-docs/scripts/registry.sh
export ZED_PKG_REGISTRY="file:///path/to/owls-docs/.registry/registry"
zed install --frozen --install-mode copy --adapter node

# 1. Corpus vs. JSON Schema — the self-proving step
python3 -m pip install 'jsonschema>=4.20'
python3 tools/validate_corpus.py
python3 tools/validate_corpus.py --schema /some/other/release.schema.json   # override

# 2. TypeScript host (zero npm dependencies)
node --test node/consumer.test.mjs
OWLS_WEB_LOADER=/path/to/owls-web-loader/dist/index.js node --test node/consumer.test.mjs

# 3. Rust host — see rust/README.md
cd rust && cargo generate-lockfile && cargo test --locked

# 4. Dart host — see dart/README.md
cd dart && flutter pub get && flutter analyze && flutter test

# 5. Browser fixtures — see browser/README.md
OWLS_BINDGEN_DIR=… OWLS_FLUTTER_DIR=… node browser/run.mjs --require
```

Every suite **skips loudly** rather than passing silently when its input is
missing: the Node suite reports the resolution it attempted, the browser harness
prints a SKIP banner, and CI annotates skipped jobs as skips in the run summary.

## Findings

- **A schema-passing but unparseable URL is a host-layer rejection, not a schema
  one.** `https://[/…` matches the schema's loose `^https://[^\s]+$` pattern, so
  every host must catch its own URL parser failing. All three now do: Rust maps it
  to `Error::Manifest("invalid URL")`, `owls-web-loader` wraps `new URL()` and
  `owls-flutter` wraps `Uri.parse()`, each reporting the declared `origin` code.
  Case `host-url-unparseable-authority` pins that agreement from outside the
  packages; it was a real divergence in Node and Dart until it was fixed upstream.
- **URL canonicalization is defined by each language's URL parser, not by the
  contract.** WHATWG parsers (Node, Rust `url`) resolve dot segments; Dart's `Uri`
  does not normalize them on parse. Publishers should emit already-canonical URLs;
  a manifest producer that emits `/a/../b` would be accepted by the Dart host and
  rejected by the other two.

## Layout

```
corpus/release-corpus.json   the shared authority — 54 cases
tools/validate_corpus.py     proves the corpus's schema-level labels are true
node/consumer.test.mjs       TypeScript host + organization transport/store
rust/                        Rust host + organization Transport/ByteStore
dart/                        Dart host + organization AssetTransport/ByteStore
browser/                     Chromium fixture harness (real framework builds only)
.github/workflows/e2e.yml    CI: pinned Zed CLI, install, then all four layers
```
