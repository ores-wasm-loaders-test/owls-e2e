// External-consumer test suite for @ores-wasm-loaders/owls-web-loader.
//
// This file is deliberately dependency-free (`node --test`, no npm packages) and
// imports the loader the way a consuming organization does: from the package that
// `zed install` copied into zed_modules/, never from a sibling source checkout.
//
// It covers two things the upstream unit tests cannot cover:
//   1. the shared cross-language corpus (corpus/release-corpus.json) drives
//      parseRelease, so the TypeScript host is held to the same verdicts as the
//      Rust and Dart hosts;
//   2. an organization supplies its own transport, byte store and policy and gets
//      the stock Coordinator to work unmodified.

import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath, pathToFileURL} from "node:url";

// ---------------------------------------------------------------- loader ----
// Resolution order: explicit env override, then the installed package, then skip.
const INSTALLED = fileURLToPath(
  new URL("../zed_modules/ores-wasm-loaders/owls-web-loader/dist/index.js", import.meta.url));

function resolveLoader() {
  const override = process.env.OWLS_WEB_LOADER;
  if (override) {
    if (!existsSync(override))
      return {skip: `OWLS_WEB_LOADER=${override} does not exist.`};
    return {path: override};
  }
  if (existsSync(INSTALLED)) return {path: INSTALLED};
  return {skip: `owls-web-loader is not installed at ${INSTALLED}. ` +
    "Run `npm ci` (if this repo grows Node deps) then " +
    "`zed install --frozen --install-mode copy --adapter node`, " +
    "or point OWLS_WEB_LOADER at a built dist/index.js."};
}

const resolved = resolveLoader();
const skip = resolved.skip ?? false;
const loader = resolved.path
  ? await import(pathToFileURL(resolved.path).href)
  : {};

const {Coordinator, LoaderError, MemoryStore, RawWasmAdapter, parseRelease, releaseKey} = loader;

// ---------------------------------------------------------------- corpus ----
const CORPUS_PATH = fileURLToPath(new URL("../corpus/release-corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
assert.equal(corpus.schemaVersion, 1, "unsupported corpus schemaVersion");
const cases = corpus.cases;
const deviates = c => Array.isArray(c.deviation?.hosts) && c.deviation.hosts.includes("node");

test("corpus: every 'valid' case parses and returns a frozen snapshot", {skip}, () => {
  const valid = cases.filter(c => c.expect === "valid");
  assert.ok(valid.length >= 5, "corpus must carry at least five valid releases");
  for (const c of valid) {
    const r = parseRelease(c.release, c.origins);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), c.release, `${c.name}: round-trip changed the release`);
    assert.ok(Object.isFrozen(r), `${c.name}: release snapshot is not frozen`);
    assert.ok(Object.isFrozen(r.assets), `${c.name}: asset list is not frozen`);
    assert.throws(() => { r.assets[0].url = "https://evil.example/x"; },
      `${c.name}: assets must be immutable`);
  }
  const runtimes = new Set(valid.map(c => c.release.runtime));
  for (const runtime of ["raw-wasm", "wasm-bindgen", "flutter-web"])
    assert.ok(runtimes.has(runtime), `corpus lacks a valid ${runtime} release`);
});

test("corpus: every 'schema' case is rejected as a manifest violation", {skip}, () => {
  const rejected = cases.filter(c => c.expect === "schema");
  assert.ok(rejected.length > 0);
  for (const c of rejected) {
    assert.throws(() => parseRelease(c.release, c.origins),
      error => {
        assert.ok(error instanceof LoaderError, `${c.name}: expected LoaderError, got ${error}`);
        assert.equal(error.code, "manifest", `${c.name}: ${c.reason}`);
        return true;
      });
  }
});

test("corpus: every 'host' case passes JSON Schema but fails a host invariant", {skip}, () => {
  const rejected = cases.filter(c => c.expect === "host");
  assert.ok(rejected.length > 0);
  for (const c of rejected) {
    assert.throws(() => parseRelease(c.release, c.origins),
      error => {
        if (deviates(c)) return true;               // see the pinned-deviation test below
        assert.ok(error instanceof LoaderError, `${c.name}: expected LoaderError, got ${error}`);
        assert.notEqual(error.code, "manifest",
          `${c.name}: rejected by the schema layer, so it is mislabelled expect=host`);
        if (c.code) assert.equal(error.code, c.code, `${c.name}: ${c.reason}`);
        return true;
      },
      `${c.name}: ${c.reason}`);
  }
});

test("corpus: an unparseable asset URL is rejected as a declared LoaderError", {skip}, () => {
  // A schema-passing but unparseable URL (e.g. "https://[") must not leak the URL
  // parser's TypeError to the caller. owls-web-loader wraps the parse and reports
  // LoaderError("origin"); this pins that contract from outside the package.
  const c = cases.find(x => x.name === "host-url-unparseable-authority");
  assert.ok(c, "the corpus must keep an unparseable-URL case");
  assert.throws(() => parseRelease(c.release, c.origins),
    error => error instanceof LoaderError && error.code === "origin",
    `${c.name}: expected LoaderError("origin")`);
});

// -------------------------------------------------------------- fixtures ----
const sha256 = data => createHash("sha256").update(data).digest("hex");

// A minimal but real WebAssembly module: the 8-byte magic + version preamble.
const GOOD_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
// Same magic, impossible version. Verifiable bytes that can never be compiled.
const UNCOMPILABLE_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x7f, 0x00, 0x00, 0x00]);

const ORIGIN = "https://assets.example";
const assetFor = (id, data, prepare = true) => ({
  id, url: `${ORIGIN}/${id}.wasm`, kind: "wasm",
  bytes: data.length, sha256: sha256(data), prepare,
});
const manifestFor = (data, overrides = {}) => ({
  schemaVersion: 1, appId: "acme-consumer", release: "2026.09.05-e2e",
  runtime: "raw-wasm", entrypoint: "engine",
  assets: [assetFor("engine", data)], ...overrides,
});
const policy = (overrides = {}) => ({
  origins: [ORIGIN],
  maxPrepareBytes: 1024 * 1024, maxAssetBytes: 1024 * 1024,
  concurrency: 2, timeoutMs: 5000,
  allowPreparation: () => true,
  ...overrides,
});

// An organization's own CDN transport: serves from a private map, honours the
// abort signal, and records what it was asked to do.
class OrgTransport {
  constructor(bodies) { this.bodies = new Map(bodies); this.requested = []; this.cancelled = []; this.holdMs = 0; }
  fetchAsset = (asset, signal) => {
    this.requested.push(asset.id);
    const body = this.bodies.get(asset.url);
    if (!body) return Promise.reject(new Error(`no such object: ${asset.url}`));
    if (!this.holdMs) {
      signal.throwIfAborted();
      return Promise.resolve(body.slice());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(body.slice()), this.holdMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.cancelled.push(asset.id);   // the organization's own cancellation accounting
        reject(signal.reason);
      }, {once: true});
    });
  };
}

// An organization's own byte store: same three-method contract, different backing.
class OrgStore {
  constructor() { this.entries = new Map(); this.ops = []; }
  async get(key) { this.ops.push(["get", key]); const v = this.entries.get(key); return v ? v.slice() : undefined; }
  async put(key, bytes) { this.ops.push(["put", key]); this.entries.set(key, bytes.slice()); }
  async delete(key) { this.ops.push(["delete", key]); this.entries.delete(key); }
  corrupt(key) { const v = this.entries.get(key); v[v.length - 1] ^= 0xff; }
  count(op) { return this.ops.filter(([o]) => o === op).length; }
}

// ------------------------------------------------ organization extensions ----
test("an organization-supplied transport serves the stock Coordinator unchanged", {skip}, async () => {
  const transport = new OrgTransport([[`${ORIGIN}/engine.wasm`, GOOD_WASM]]);
  const c = new Coordinator(policy(), transport.fetchAsset);
  const release = c.register(manifestFor(GOOD_WASM));

  await c.prefetch(releaseKey(release));
  assert.deepEqual(transport.requested, ["engine"]);
  assert.deepEqual(transport.cancelled, []);

  const instance = await c.activate(releaseKey(release), new RawWasmAdapter());
  assert.ok(instance instanceof WebAssembly.Instance);
  assert.deepEqual(transport.requested, ["engine"], "verified bytes were reused, not refetched");
});

test("a caller-owned abort reaches the organization transport and is recorded", {skip}, async () => {
  const transport = new OrgTransport([[`${ORIGIN}/engine.wasm`, GOOD_WASM]]);
  transport.holdMs = 10_000;
  const c = new Coordinator(policy(), transport.fetchAsset);
  const key = releaseKey(c.register(manifestFor(GOOD_WASM)));

  const abort = new AbortController();
  const pending = c.prefetch(key, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error("navigating away"));

  await assert.rejects(pending, /navigating away/);
  assert.deepEqual(transport.cancelled, ["engine"], "the transport was told to stop");

  // Cancellation must not poison the coordinator: a fresh attempt still works.
  transport.holdMs = 0;
  await c.prefetch(key);
  assert.equal(transport.requested.length, 2);
});

test("an organization-supplied ByteStore satisfies the put/get/delete contract", {skip}, async () => {
  const store = new OrgStore();
  assert.equal(await store.get("absent"), undefined);
  await store.put("k", GOOD_WASM);
  assert.deepEqual(await store.get("k"), GOOD_WASM);
  const handed = await store.get("k");
  handed[0] = 0xff;
  assert.deepEqual(await store.get("k"), GOOD_WASM, "the store must hand out copies, not its own buffer");
  await store.delete("k");
  assert.equal(await store.get("k"), undefined);
  await store.delete("k");   // deleting an absent key is not an error
});

test("a corrupted entry in the organization store is evicted and refetched", {skip}, async () => {
  const transport = new OrgTransport([[`${ORIGIN}/engine.wasm`, GOOD_WASM]]);
  const store = new OrgStore();
  const c = new Coordinator(policy(), transport.fetchAsset, store);
  const key = releaseKey(c.register(manifestFor(GOOD_WASM)));

  await c.prefetch(key);
  assert.equal(transport.requested.length, 1);
  assert.equal(store.count("put"), 1);

  const [cacheKey] = [...store.entries.keys()];
  assert.match(cacheKey, /^https:\/\/assets\.example\/engine\.wasm#[0-9a-f]{64}$/,
    "cache keys are content-addressed by URL and digest");
  store.corrupt(cacheKey);

  await c.prefetch(key);
  assert.equal(store.count("delete"), 1, "the failing entry was evicted");
  assert.equal(transport.requested.length, 2, "and the asset was refetched");
  assert.deepEqual(store.entries.get(cacheKey), GOOD_WASM, "the good bytes replaced the bad ones");
});

test("preparation never activates: unusable entrypoint bytes still prefetch cleanly", {skip}, async () => {
  const transport = new OrgTransport([[`${ORIGIN}/engine.wasm`, UNCOMPILABLE_WASM]]);
  const c = new Coordinator(policy(), transport.fetchAsset);
  const key = releaseKey(c.register(manifestFor(UNCOMPILABLE_WASM)));

  let activations = 0;
  const adapter = {activate: ctx => { activations++; return new RawWasmAdapter().activate(ctx); }};

  await c.prefetch(key);                       // must not compile, instantiate or import
  assert.equal(activations, 0, "preparation must not reach an adapter");
  assert.equal(transport.requested.length, 1);

  // Proof the fixture really is un-instantiable, i.e. the assertion above had teeth.
  await assert.rejects(c.activate(key, adapter), e => e instanceof WebAssembly.CompileError);
  assert.equal(activations, 1);
});

test("release identity is content identity: same appId@release, different bytes, is a conflict", {skip}, async () => {
  const c = new Coordinator(policy(), new OrgTransport([]).fetchAsset);
  const first = manifestFor(GOOD_WASM);
  c.register(first);
  c.register(structuredClone(first));           // re-registering the same content is idempotent

  const rebuilt = manifestFor(UNCOMPILABLE_WASM);   // same appId@release, different digest
  assert.equal(releaseKey(parseRelease(rebuilt, [ORIGIN])), releaseKey(parseRelease(first, [ORIGIN])));
  assert.throws(() => c.register(rebuilt), {code: "release-conflict"});

  // Adding an asset under the same release ID is the same class of mistake.
  const widened = manifestFor(GOOD_WASM);
  widened.assets.push(assetFor("atlas", UNCOMPILABLE_WASM, false));
  assert.throws(() => c.register(widened), {code: "release-conflict"});

  // A new release ID is how a rebuild is published.
  const next = manifestFor(UNCOMPILABLE_WASM, {release: "2026.09.05-e2e-2"});
  assert.equal(c.register(next).release, "2026.09.05-e2e-2");
});

test("the origin allowlist is the organization's decision, not the loader's", {skip}, () => {
  const c = cases.find(x => x.name === "host-origin-sibling-subdomain");
  assert.ok(c, "corpus case host-origin-sibling-subdomain is missing");
  assert.throws(() => parseRelease(c.release, c.origins), {code: "origin"});
  const widened = [...c.origins, "https://cdn.assets.example"];
  assert.equal(parseRelease(c.release, widened).appId, c.release.appId);
});

test("the stock MemoryStore and an organization store are interchangeable", {skip}, async () => {
  for (const store of [new MemoryStore(1024 * 1024), new OrgStore()]) {
    const transport = new OrgTransport([[`${ORIGIN}/engine.wasm`, GOOD_WASM]]);
    const c = new Coordinator(policy(), transport.fetchAsset, store);
    const key = releaseKey(c.register(manifestFor(GOOD_WASM)));
    await c.prefetch(key);
    assert.ok(await c.activate(key, new RawWasmAdapter()) instanceof WebAssembly.Instance);
    assert.equal(transport.requested.length, 1);
  }
});
