import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.crypto ??= webcrypto;

const LOADER_PATH = fileURLToPath(new URL(
  '../zed_modules/ores-wasm-loaders/owls-web-loader/index.mjs',
  import.meta.url,
));
const INTERFACES_PATH = fileURLToPath(new URL(
  '../zed_modules/ores-wasm-loaders/owls-interfaces/index.mjs',
  import.meta.url,
));

assert.ok(existsSync(LOADER_PATH), `missing external loader checkout: ${LOADER_PATH}`);
assert.ok(existsSync(INTERFACES_PATH), `missing external interface checkout: ${INTERFACES_PATH}`);

const loader = await import(pathToFileURL(LOADER_PATH).href);
const interfaces = await import(pathToFileURL(INTERFACES_PATH).href);
const {
  Coordinator,
  LoaderError,
  MemoryStore,
  RawWasmAdapter,
  browserPolicy,
  parseRelease,
  releaseKey,
  releaseSchema,
} = loader;
const { validateAgainst } = interfaces;

const CORPUS_PATH = fileURLToPath(new URL('../corpus/release-corpus.json', import.meta.url));
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
assert.equal(corpus.schemaVersion, 1, 'unsupported external corpus schema');

function parseCase(item) {
  return parseRelease(item.release, item.origins, releaseSchema);
}

test('all 54 cases agree with the independently authored schema lane and host lane', () => {
  assert.equal(corpus.cases.length, 54);
  const counts = { valid: 0, schema: 0, host: 0 };
  for (const item of corpus.cases) {
    counts[item.expect] += 1;
    const structural = validateAgainst(item.release, releaseSchema);
    if (item.expect === 'valid') {
      assert.deepEqual(structural, [], `${item.name}: schema rejected a valid release`);
      const parsed = parseCase(item);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), item.release, `${item.name}: parse changed the release`);
      assert.ok(Object.isFrozen(parsed), `${item.name}: parsed release is mutable`);
      continue;
    }
    if (item.expect === 'schema') {
      assert.ok(structural.length > 0, `${item.name}: schema lane accepted a schema-negative case`);
      assert.throws(() => parseCase(item), (error) => error instanceof LoaderError && error.code === 'manifest');
      continue;
    }
    assert.deepEqual(structural, [], `${item.name}: host-negative case is actually a schema failure`);
    assert.throws(() => parseCase(item), (error) => {
      assert.ok(error instanceof LoaderError, `${item.name}: leaked ${error?.constructor?.name ?? typeof error}`);
      if (item.code) assert.equal(error.code, item.code, `${item.name}: wrong host error code`);
      return true;
    });
  }
  assert.deepEqual(counts, { valid: 8, schema: 28, host: 18 });
});

const ORIGIN = 'https://assets.example';
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const DIGEST = createHash('sha256').update(WASM).digest('hex');

function manifest(release = '2026.09.06-e2e') {
  return {
    schemaVersion: 1,
    appId: 'external-consumer',
    release,
    runtime: 'raw-wasm',
    entrypoint: 'engine',
    assets: [{
      id: 'engine',
      url: `${ORIGIN}/engine.wasm`,
      kind: 'wasm',
      bytes: WASM.length,
      sha256: DIGEST,
      prepare: true,
    }],
  };
}

function policy(overrides = {}) {
  return browserPolicy([ORIGIN], {
    maxPrepareBytes: 1024,
    maxAssetBytes: 1024,
    concurrency: 1,
    timeoutMs: 1_000,
    activationJoinMs: 10,
    allowPreparation: () => true,
    ...overrides,
  });
}

class ExternalTransport {
  calls = 0;
  aborts = 0;
  delay = 0;

  fetch = (_asset, signal) => {
    this.calls += 1;
    if (!this.delay) {
      signal.throwIfAborted();
      return Promise.resolve(WASM.slice());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(WASM.slice()), this.delay);
      const abort = () => {
        clearTimeout(timer);
        this.aborts += 1;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
}

test('fetch-only preparation and activation share verified bytes without duplicate startup', async () => {
  const transport = new ExternalTransport();
  const coordinator = new Coordinator(policy(), {
    transport: transport.fetch,
    store: new MemoryStore(),
  });
  const key = releaseKey(coordinator.register(manifest()));

  const receipt = await coordinator.prefetch(key);
  assert.equal(receipt.status, 'warmed');
  assert.deepEqual(receipt.prepared, ['engine']);
  assert.equal(transport.calls, 1);

  const adapter = new RawWasmAdapter();
  const first = coordinator.activate(key, adapter);
  const second = coordinator.activate(key, adapter);
  assert.strictEqual(first, second, 'concurrent activation callers must share one promise');
  assert.ok(await first instanceof WebAssembly.Instance);
  assert.equal(transport.calls, 1, 'activation refetched verified prepared bytes');
});

test('reference-counted intent leases share work and one release cannot cancel another', async () => {
  const transport = new ExternalTransport();
  transport.delay = 25;
  const coordinator = new Coordinator(policy(), { transport: transport.fetch });
  const key = releaseKey(coordinator.register(manifest('2026.09.06-leases')));
  const first = coordinator.prepare(key);
  const second = coordinator.prepare(key);
  first.release();
  assert.equal((await second.promise).status, 'warmed');
  second.release();
  assert.equal(transport.calls, 1);
  assert.equal(transport.aborts, 0);
});

test('caller cancellation reports skipped work, aborts unowned transport, and does not poison cold activation', async () => {
  const transport = new ExternalTransport();
  transport.delay = 10_000;
  const coordinator = new Coordinator(policy(), { transport: transport.fetch });
  const key = releaseKey(coordinator.register(manifest('2026.09.06-cancel')));
  const controller = new AbortController();
  const pending = coordinator.prefetch(key, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('navigation changed'));

  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.skipped.map((item) => item.id), ['engine']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.aborts, 1);

  transport.delay = 0;
  assert.ok(await coordinator.activate(key, new RawWasmAdapter()) instanceof WebAssembly.Instance);
  assert.equal(transport.calls, 2);
});
