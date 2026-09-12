# owls_e2e_consumer (Dart / Flutter)

An external organization's package. It depends on the **installed** packages
(`../zed_modules/ores-wasm-loaders/owls-flutter` and
`../zed_modules/ores-wasm-loaders/owls-interfaces/dart`) exactly as
owls-docs/docs/installation.md documents, including the `dependency_overrides`
entry for `owls_interfaces`. Paths carry one extra `../` because `zed_modules/`
is installed at the repository root while this package lives in `dart/`.

**Neither the Dart nor the Flutter SDK exists in the authoring sandbox, so
nothing here has been analyzed or run. It is gated on the consuming machine.**

`owls_flutter` depends on the Flutter SDK, so this is a Flutter package and its
tests run under `flutter test`, not `dart test` — even though `test/corpus_test.dart`
itself imports nothing from `package:flutter`.

## Running it

```sh
# from the repository root, after `zed install --frozen --install-mode copy`
cd dart
flutter pub get              # first time; commit the resulting pubspec.lock
flutter analyze
flutter test                 # CI adds: flutter pub get --enforce-lockfile
```

`pubspec.lock` is intentionally not committed by the authoring sandbox because it
could not be generated honestly there. Generate it on the first machine with a
Flutter SDK, review it, and commit it.

## What it proves once it runs

- `owls_flutter`'s `parseRelease` returns the same verdict for every case in
  `../corpus/release-corpus.json` as the TypeScript and Rust hosts do, including
  which layer does the rejecting and which host invariant fires.
- An organization-supplied `AssetTransport` and `ByteStore` drive the stock
  `WasmHost` unmodified: verified bytes are reused, a `Cancellation` reaches the
  transport and is recorded, a corrupted cache entry is ignored and refetched, an
  unverifiable response never reaches the cache, budget checks run before the
  network, and preparation never reaches a `WasmAdapter`.
