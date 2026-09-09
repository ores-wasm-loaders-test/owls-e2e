import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const loaderPath = fileURLToPath(new URL(
  '../zed_modules/ores-wasm-loaders/owls-web-loader/index.mjs',
  import.meta.url,
));
const interfacesPath = fileURLToPath(new URL(
  '../zed_modules/ores-wasm-loaders/owls-interfaces/index.mjs',
  import.meta.url,
));
const dioxusFixtureUrl = new URL(
  '../zed_modules/ores-wasm-loaders/owls-interfaces/fixtures/valid/dioxus.json',
  import.meta.url,
);

const loader = await import(pathToFileURL(loaderPath).href);
const interfaces = await import(pathToFileURL(interfacesPath).href);
const {
  dependencyClosureForRoute,
  parseRelease,
  prefetchRoute,
  releaseKey,
  releaseSchema,
} = loader;

const fixture = JSON.parse(await readFile(dioxusFixtureUrl, 'utf8'));
const origin = new URL(fixture.assets[0].url).origin;

test('external Dioxus fixture preserves the admitted dependency DAG in Schema A and host parsing', () => {
  assert.deepEqual(interfaces.validateAgainst(fixture, releaseSchema), []);
  const release = parseRelease(fixture, [origin], releaseSchema);
  const reports = release.assets.find((asset) => asset.id === 'chunks-reports.wasm');
  assert.deepEqual(reports.dependencies, ['chunks-app.wasm']);
  assert.ok(Object.isFrozen(release));
  assert.ok(Object.isFrozen(reports.dependencies));
  assert.deepEqual(
    dependencyClosureForRoute(release, '/app/reports').map((asset) => asset.id),
    ['chunks-app.wasm', 'chunks-reports.wasm'],
  );
});

test('external route preparation requests the admitted dependency closure in dependency-first order', async () => {
  const release = parseRelease(fixture, [origin], releaseSchema);
  const requested = [];
  const coordinator = {
    policy: {
      maxPrepareBytes: 2_000_000,
      maxAssetBytes: 1_000_000,
      timeoutMs: 1_000,
      allowPreparation: () => true,
    },
    get(key) {
      assert.equal(key, releaseKey(release));
      return release;
    },
    async bytes(subject, id, signal) {
      assert.strictEqual(subject, release);
      signal.throwIfAborted();
      requested.push(id);
      return new Uint8Array(0);
    },
  };

  const result = await prefetchRoute(
    coordinator,
    releaseKey(release),
    '/app/reports',
  );
  assert.equal(result.status, 'warmed');
  assert.equal(result.ready, true);
  assert.deepEqual(result.prepared, ['chunks-app.wasm', 'chunks-reports.wasm']);
  assert.deepEqual(requested, ['chunks-app.wasm', 'chunks-reports.wasm']);
});
