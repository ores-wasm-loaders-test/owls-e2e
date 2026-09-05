# Chromium fixture harness

**None of these checks has been run. They have never been executed against a real
`wasm-pack` or `flutter build web --wasm` output.** The authoring sandbox has no
Chromium, no Rust toolchain, no Flutter SDK and no network, so this directory
ships as *source to be run by an operator who has those things*. Treat every
statement below as a description of what the harness will check, not as a result.

The harness refuses to fake its inputs. There is no stub wasm-bindgen bundle and
no simulated Flutter engine. If the build directories are absent it prints a SKIP
banner and says plainly that nothing was checked.

## Producing the inputs

Two real framework builds, produced by the frameworks' own tools:

```sh
# wasm-bindgen (any crate with #[wasm_bindgen] exports, e.g. a Leptos or Dioxus app)
cd path/to/your-crate
wasm-pack build --target web --release --out-dir pkg
export OWLS_BINDGEN_DIR="$PWD/pkg"          # contains <name>.js and <name>_bg.wasm

# Flutter, WebAssembly renderer
cd path/to/your-flutter-app
flutter build web --wasm --release
export OWLS_FLUTTER_DIR="$PWD/build/web"    # contains flutter_bootstrap.js
```

`--target web` matters: the harness imports the glue as an ES module and calls its
default export with bytes it fetched itself, which is only how the `web` target
behaves. `--wasm` matters: the two-view check exercises the WebAssembly renderer's
multi-view path.

## Running it

```sh
node browser/run.mjs                 # skips loudly for any input you did not supply
node browser/run.mjs --require       # a skip is a failure — use this where the inputs must exist
OWLS_BROWSER_VERBOSE=1 node browser/run.mjs   # forward Chromium's stderr
```

| Variable | Meaning |
| --- | --- |
| `OWLS_BINDGEN_DIR` | `wasm-pack build --target web` output directory |
| `OWLS_FLUTTER_DIR` | `flutter build web --wasm` output directory |
| `OWLS_CHROME` | Chromium/Chrome binary (otherwise the usual Linux/macOS paths are probed) |
| `OWLS_FIXTURE_PORT` | fixture server port, default `8642` |
| `OWLS_FIXTURE_CERT` / `OWLS_FIXTURE_KEY` | serve HTTPS with this certificate instead of HTTP |
| `OWLS_BROWSER_REQUIRE=1` | same as `--require` |
| `OWLS_CHROME_SANDBOX=1` | keep Chromium's sandbox (the default adds `--no-sandbox` for CI containers) |

### HTTP vs HTTPS

The fixture server binds `127.0.0.1`. That is a *trustworthy origin* in Chromium,
so `CacheStorage`, `crypto.subtle` and cross-origin isolation behave exactly as
they do under HTTPS — no certificate needed. Supply `OWLS_FIXTURE_CERT` and
`OWLS_FIXTURE_KEY` if you want the TLS path itself in the picture; the runner then
adds `--ignore-certificate-errors` for the self-signed case.

### What the server does, and why it is part of the test

- `application/wasm` for `.wasm`, a JavaScript MIME type for `.js`/`.mjs`.
  `WebAssembly.compileStreaming` rejects anything else, and an ES module import
  rejects a non-JavaScript MIME type, so serving these correctly is a precondition
  the harness asserts rather than assumes.
- `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; …`
  — WebAssembly compilation is permitted, JavaScript `eval` is not. Note the
  consequence: **inline `<script>` is blocked**, so all harness code lives in
  external modules. If a framework's bootstrap needs `'unsafe-eval'` or inline
  script, that is a finding, and it will show up as a failing check here rather
  than as a note in a document.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
  require-corp`, so the cross-origin-isolated features some Flutter WASM builds
  need are available.
- `X-Content-Type-Options: nosniff`, sorted directory listings, content-addressed
  ETags and a pinned port, so a run either reproduces or names the byte that moved.

## What each check proves

| Check | Proves |
| --- | --- |
| `csp-permits-wasm-but-not-eval` | The document compiles WebAssembly while `new Function()` throws. Shipping WASM never requires relaxing `script-src` to `'unsafe-eval'`. |
| `wasm-served-as-application-wasm` | The real `_bg.wasm` compiles through `WebAssembly.compileStreaming` from a response whose `Content-Type` is exactly `application/wasm`. |
| `bindgen-glue-initializes-from-supplied-bytes` | The organization fetches the binary itself and hands the bytes to the generated glue's default export — the same division of labour as `BindgenAdapter`, where only the exact build's glue knows its imports and start function. The loader never fetches on the glue's behalf. |
| `flutter-two-views-one-engine` | Two embedded Flutter views can live in one document on **one** engine: the loader yields a single entrypoint, `initializeEngine` runs once, `addView` returns two distinct view ids, and `removeView` tears one down without disturbing the other. This is the check that a product embedding Flutter beside existing DOM UI actually depends on. |
| `cachestorage-survives-navigation` | Bytes written to `CacheStorage` in one document are still present, byte-identical and still compilable as WebAssembly, in a **new document reached by a full navigation** (`location.assign`, not a history entry or an SPA route change). This is what makes a returning user's second load start from cache instead of the network. |

## Known fragility

The Flutter bootstrap API (`_flutter.loader.load`, `onEntrypointLoaded`,
`initializeEngine`, `runApp`, `addView`/`removeView`) is version-dependent and is
not covered by the release schema or by any package in this organization. The
check is written against the multi-view API as of the Flutter 3.2x line. If it
fails on your pinned Flutter, read the failure detail before assuming a loader
bug — and pin the Flutter version alongside the release, since generated Flutter
bootstrap is release-specific by design.
