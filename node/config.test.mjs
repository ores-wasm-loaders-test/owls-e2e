import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOADER_PATH = join(ROOT, 'zed_modules/ores-wasm-loaders/owls-web-loader/index.mjs');
const INTERFACES_PATH = join(ROOT, 'zed_modules/ores-wasm-loaders/owls-interfaces/index.mjs');
assert.ok(existsSync(LOADER_PATH), `missing external loader checkout: ${LOADER_PATH}`);
assert.ok(existsSync(INTERFACES_PATH), `missing external interface checkout: ${INTERFACES_PATH}`);

const loader = await import(pathToFileURL(LOADER_PATH).href);
const interfaces = await import(pathToFileURL(INTERFACES_PATH).href);
const configSource = await readFile(join(ROOT, '.ores-wasm.toml'), 'utf8');

test('external repo config resolves a checked-in release manifest through admitted interfaces', async () => {
  const config = loader.parseOresWasmToml(configSource);
  assert.equal(config.enabled, true);
  assert.equal(config.hosts.external.kind, 'browser');
  assert.equal(config.hosts.external.releaseManifest, 'config/release.json');
  assert.deepEqual(config.hosts.external.allowedOrigins, ['https://assets.example']);
  assert.ok(Object.isFrozen(config));

  const manifestPath = join(ROOT, config.hosts.external.releaseManifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const release = loader.parseRelease(manifest, config.hosts.external.allowedOrigins, loader.releaseSchema);
  assert.equal(release.appId, 'external-config-consumer');
  assert.equal(release.assets[0].sha256, '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476');

  const structural = interfaces.validateAgainst(config, interfaces.configSchema);
  assert.deepEqual(structural, []);
});

test('external flags-2-env seam applies typed overrides without rewriting TOML', () => {
  const resolved = loader.resolveOresWasmToml(configSource, {
    ORES_WASM_E2E_PREPARE_BYTES: '4096',
    ORES_WASM_E2E_METADATA: '{"source":"argv","cohort":"external"}',
  });
  assert.equal(resolved.hosts.external.prepare.maxBytes, 4096);
  assert.deepEqual(resolved.extensions.externalMetadata, {
    source: 'argv',
    cohort: 'external',
  });
  assert.ok(!configSource.includes('4096'));
  assert.ok(!configSource.includes('argv'));
});

test('external consumer observes fail-closed env coercion from the real loader', () => {
  assert.throws(
    () => loader.resolveOresWasmToml(configSource, { ORES_WASM_E2E_PREPARE_BYTES: '4.5' }),
    (error) => error instanceof loader.LoaderError && error.code === 'config-env',
  );
});
