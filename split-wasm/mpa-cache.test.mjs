import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ComposedWasmAdapter,
  Coordinator,
  MemoryStore,
  browserPolicy,
} from '../_upstream/owls-web-loader/index.mjs';

const ORIGIN = 'https://assets.ores-wasm-loaders.test';
const VENDOR_URL = `${ORIGIN}/shared/vendor-core.7f.wasm`;
const HOME_URL = `${ORIGIN}/releases/site-r1/page-home.3c.wasm`;
const SETTINGS_URL = `${ORIGIN}/releases/site-r2/page-settings.91.wasm`;

// (module (func (export "add1") (param i32) (result i32)
//   local.get 0 i32.const 1 i32.add))
const VENDOR = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 6, 1, 96, 1, 127, 1, 127,
  3, 2, 1, 0,
  7, 8, 1, 4, 97, 100, 100, 49, 0, 0,
  10, 9, 1, 7, 0, 32, 0, 65, 1, 106, 11,
]);

function pageModule(constant) {
  // Imports vendor-core.add1 and exports run() -> add1(constant).
  return Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 10, 2, 96, 1, 127, 1, 127, 96, 0, 1, 127,
    2, 20, 1, 11, 118, 101, 110, 100, 111, 114, 45, 99, 111, 114, 101,
    4, 97, 100, 100, 49, 0, 0,
    3, 2, 1, 1,
    7, 7, 1, 3, 114, 117, 110, 0, 1,
    10, 8, 1, 6, 0, 65, constant, 16, 0, 11,
  ]);
}

const HOME = pageModule(41);
const SETTINGS = pageModule(42);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function asset(id, url, bytes, role, dependencies = []) {
  return {
    id,
    url,
    kind: 'wasm',
    role,
    stage: 'critical',
    dependencies,
    bytes: bytes.length,
    sha256: sha256(bytes),
    prepare: true,
  };
}

function release(releaseId, pageId, pageUrl, pageBytes) {
  return {
    schemaVersion: 2,
    appId: 'split-mpa',
    release: releaseId,
    runtime: 'raw-wasm',
    entrypoint: pageId,
    assets: [
      asset('vendor-core', VENDOR_URL, VENDOR, 'module'),
      asset(pageId, pageUrl, pageBytes, 'chunk', ['vendor-core']),
    ],
    prepareBudget: {
      maxBytes: 1024 * 1024,
      maxConcurrency: 2,
      furthestStage: 'fetch',
    },
  };
}

test('a second MPA document reuses shared vendor Wasm and fetches only its page chunk', async () => {
  assert.equal(WebAssembly.validate(VENDOR), true);
  assert.equal(WebAssembly.validate(HOME), true);
  assert.equal(WebAssembly.validate(SETTINGS), true);

  // MemoryStore stands in for the same persistent CacheStorage namespace shared by two
  // independent documents. Each Coordinator is fresh, so no Coordinator/application state
  // crosses the navigation boundary.
  const navigationStore = new MemoryStore();
  const bodies = new Map([
    [VENDOR_URL, VENDOR],
    [HOME_URL, HOME],
    [SETTINGS_URL, SETTINGS],
  ]);
  const network = [];
  const transport = async (declared) => {
    network.push(declared.url);
    const bytes = bodies.get(declared.url);
    assert.ok(bytes, `unexpected asset request: ${declared.url}`);
    return Uint8Array.from(bytes);
  };
  const policy = browserPolicy([ORIGIN], { concurrency: 2 });

  const homeDocument = new Coordinator(policy, { transport, store: navigationStore });
  const homeRelease = homeDocument.register(release('site-r1', 'page-home', HOME_URL, HOME));
  const homeKey = `${homeRelease.appId}@${homeRelease.release}`;
  const homePrepared = await homeDocument.prefetch(homeKey);
  assert.equal(homePrepared.status, 'warmed');
  assert.equal(network.filter((url) => url === VENDOR_URL).length, 1);
  assert.equal(network.filter((url) => url === HOME_URL).length, 1);
  const homeRuntime = await homeDocument.activate(homeKey, new ComposedWasmAdapter());
  assert.equal(homeRuntime.instance.exports.run(), 42);

  // A normal MPA navigation creates a fresh loader/coordinator. Only the persistent verified
  // asset cache survives. The vendor URL + SHA-256 are identical, so it must not hit transport.
  const settingsDocument = new Coordinator(policy, { transport, store: navigationStore });
  const settingsRelease = settingsDocument.register(
    release('site-r2', 'page-settings', SETTINGS_URL, SETTINGS),
  );
  const settingsKey = `${settingsRelease.appId}@${settingsRelease.release}`;
  const settingsPrepared = await settingsDocument.prefetch(settingsKey);
  assert.equal(settingsPrepared.status, 'warmed');
  assert.equal(network.filter((url) => url === VENDOR_URL).length, 1, 'vendor must not be downloaded twice');
  assert.equal(network.filter((url) => url === HOME_URL).length, 1);
  assert.equal(network.filter((url) => url === SETTINGS_URL).length, 1, 'only the new page chunk is fetched');

  const settingsRuntime = await settingsDocument.activate(settingsKey, new ComposedWasmAdapter());
  assert.equal(settingsRuntime.instance.exports.run(), 43);
});
