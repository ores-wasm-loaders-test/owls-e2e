// Independent public-API certification: real browser fetch + real HTTPS + real Coordinator.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, webkit } from 'playwright';

const source = fileURLToPath(new URL('../../package-src/', import.meta.url));
const engines = { chromium, firefox, webkit };
const engine = process.env.OWLS_BROWSER ?? 'chromium';
assert.ok(Object.hasOwn(engines, engine), 'OWLS_BROWSER must name a supported engine');
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const digest = createHash('sha256').update(wasm).digest('hex');
const scenarios = new Map();
let browser, server, origin, temporary, sequence = 0;

const pageModule = `
globalThis.__OWLS_INTERFACES_URL__ = '/interfaces/index.mjs';
const { Coordinator, browserPolicy } = await import('/loader/src/coordinator.mjs');
const { installMarketingIntentLoader } = await import('/loader/src/marketing.mjs');
globalThis.outcomes = [];
globalThis.errors = [];
globalThis.unhandled = [];
globalThis.manifestFetches = [];
addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
const coordinator = new Coordinator(browserPolicy([location.origin]));
const fetcher = (url, options) => {
  const request = { url, aborted: false };
  manifestFetches.push(request);
  options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
  return fetch(url, options);
};
globalThis.installation = installMarketingIntentLoader({
  coordinator, fetcher, dwellMs: 0, exitGraceMs: 0,
  onOutcome: ({outcome}) => outcomes.push(outcome),
  onError: ({error}) => errors.push(String(error)),
});
globalThis.ready = true;
`;

async function serve(req, res) {
  const url = new URL(req.url, origin);
  const parts = url.pathname.split('/');
  const state = parts[1] === 'scenario' ? scenarios.get(parts[2]) : null;
  res.setHeader('Cache-Control', 'no-store');
  if (state && parts[3] === 'page') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>OWLS manifest ownership</title>
      <a id="first" href="/destination" data-owls-manifest="/scenario/${state.id}/manifest.json">Open app</a>
      <a id="second" href="/destination" data-owls-manifest="/scenario/${state.id}/manifest.json">Open same app</a>
      <script type="module" src="/page.mjs"></script>`);
  } else if (state && parts[3] === 'manifest.json') {
    const request = { response: res, cancelled: false, closed: false };
    state.manifests.push(request);
    res.on('close', () => {
      request.closed = true;
      request.cancelled = !res.writableEnded;
    });
    res.setHeader('Content-Type', 'application/json');
    if (!state.stallHeaders) res.flushHeaders();
    // The test owns completion. No timers are left running after cancellation.
  } else if (state && parts[3] === 'app.wasm') {
    state.assets += 1;
    res.setHeader('Content-Type', 'application/wasm');
    res.end(wasm);
  } else if (url.pathname === '/page.mjs') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(pageModule);
  } else if (url.pathname === '/destination') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Destination</title><p id="destination">Ordinary navigation</p>');
  } else if (['loader', 'interfaces'].includes(parts[1])) {
    const root = resolve(source, parts[1] === 'loader' ? 'owls-web-loader' : 'owls-interfaces');
    const path = resolve(root, parts.slice(2).join('/'));
    if (!path.startsWith(root + sep) || !['.mjs', '.json'].includes(extname(path))) {
      res.writeHead(404).end(); return;
    }
    res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'text/javascript');
    res.end(await readFile(path));
  } else res.writeHead(404).end();
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'owls-manifest-browser-'));
  const key = join(temporary, 'key.pem'), cert = join(temporary, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    void serve(req, res).catch((error) => {
      console.error(error);
      res.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `https://127.0.0.1:${server.address().port}`;
  browser = await engines[engine].launch({
    headless: true,
    ...(process.env.OWLS_BROWSER_EXECUTABLE ? { executablePath: process.env.OWLS_BROWSER_EXECUTABLE } : {}),
  });
  console.log(`Browser evidence: ${engine} ${browser.version()}`);
});

after(async () => {
  await browser?.close();
  if (server) {
    for (const state of scenarios.values()) for (const request of state.manifests) request.response.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (temporary) await rm(temporary, { recursive: true });
});

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

async function fixture(t, { stallHeaders = false } = {}) {
  const id = String(++sequence);
  const state = { id, manifests: [], assets: 0, stallHeaders };
  scenarios.set(id, state);
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); // fixture TLS only
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  t.after(async () => {
    await context.close();
    for (const request of state.manifests) request.response.destroy();
    assert.deepEqual(failures, [], 'browser module graph must not raise page errors');
  });
  await page.goto(`${origin}/scenario/${id}/page`);
  await page.waitForFunction(() => globalThis.ready === true);
  const press = (selector = '#first') => page.locator(selector).dispatchEvent('pointerdown', { pointerType: 'mouse' });
  const leave = (selector = '#first') => page.locator(selector).dispatchEvent('pointerleave', { pointerType: 'mouse' });
  const complete = (index = 0) => state.manifests[index].response.end(JSON.stringify({
    schemaVersion: 2, appId: 'browser-certification', release: 'v1', runtime: 'raw-wasm',
    entrypoint: 'module',
    assets: [{ id: 'module', url: `${origin}/scenario/${id}/app.wasm`, kind: 'wasm', role: 'module',
      stage: 'critical', bytes: wasm.length, sha256: digest, prepare: true }],
    prepareBudget: { maxBytes: 8, maxConcurrency: 1, furthestStage: 'fetch' },
  }));
  return { page, state, press, leave, complete };
}

for (const stallHeaders of [false, true]) {
  test(`last-owner cancellation stops real HTTPS ${stallHeaders ? 'headers' : 'body'} wait`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { stallHeaders });
    assert.equal(f.state.manifests.length, 0, 'initial page load must not fetch manifests');
    await f.press();
    await until(() => f.state.manifests.length === 1, 'manifest reached server');
    await f.leave();
    await until(() => f.state.manifests[0].cancelled, 'server observed transport cancellation');
    assert.equal(f.state.assets, 0);
    assert.deepEqual(await f.page.evaluate(() => ({ errors, unhandled, outcomes })), { errors: [], unhandled: [], outcomes: [] });
    assert.equal(await f.page.evaluate(() => manifestFetches[0].aborted), true);
  });
}

test('one link can leave while the other completes verified preparation', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.press('#first'); await f.press('#second');
  await until(() => f.state.manifests.length === 1, 'shared request');
  await f.leave('#first');
  await delay(50); // Allow the zero-ms exit grace and ownership microtasks to settle.
  assert.equal(f.state.manifests[0].cancelled, false);
  assert.equal(f.state.manifests.length, 1);
  f.complete();
  await f.page.waitForFunction(() => outcomes.length === 1);
  assert.equal(f.state.assets, 1);
  assert.equal(await f.page.evaluate(() => outcomes[0].status), 'warmed');
  assert.deepEqual(await f.page.evaluate(() => errors), []);
});

test('a fresh intent after abort starts a new real request and prepares successfully', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.press(); await until(() => f.state.manifests.length === 1, 'first request');
  await f.leave(); await until(() => f.state.manifests[0].cancelled, 'first abort');
  await f.press(); await until(() => f.state.manifests.length === 2, 'replacement request');
  f.complete(1);
  await f.page.waitForFunction(() => outcomes.length === 1);
  assert.equal(f.state.assets, 1);
  assert.equal(await f.page.evaluate(() => outcomes[0].bytes), 8);
});

test('disposing while a manifest body stalls closes transport without navigating', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.press(); await until(() => f.state.manifests.length === 1, 'pending request');
  const url = f.page.url();
  await f.page.evaluate(() => { installation.dispose(); installation.dispose(); });
  await until(() => f.state.manifests[0].cancelled, 'dispose abort');
  assert.equal(f.page.url(), url);
  assert.equal(f.state.assets, 0);
  assert.deepEqual(await f.page.evaluate(() => ({ errors, unhandled, outcomes })), { errors: [], unhandled: [], outcomes: [] });
});

test('dispatched pagehide aborts and dispatched pageshow requires fresh intent', { timeout: 15000 }, async t => {
  // Event lifecycle certification, not a claim that the browser admitted this page to BFCache.
  const f = await fixture(t);
  await f.press(); await until(() => f.state.manifests.length === 1, 'pending request');
  await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await until(() => f.state.manifests[0].cancelled, 'pagehide abort');
  await f.press(); await delay(50);
  assert.equal(f.state.manifests.length, 1);
  await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await delay(50);
  assert.equal(f.state.manifests.length, 1, 'pageshow alone must not prepare');
  await f.press(); await until(() => f.state.manifests.length === 2, 'restored intent');
  f.complete(1);
  await f.page.waitForFunction(() => outcomes.length === 1);
});

test('native link navigation still succeeds while the manifest is stalled', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.press(); await until(() => f.state.manifests.length === 1, 'pending request');
  await Promise.all([f.page.waitForURL(`${origin}/destination`), f.page.locator('#first').click()]);
  assert.equal(await f.page.locator('#destination').textContent(), 'Ordinary navigation');
  await until(() => f.state.manifests[0].cancelled, 'navigation cancellation');
  assert.equal(f.state.assets, 0);
});

test('successful manifest reuse preserves a single download and new preparation ownership', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.press(); await until(() => f.state.manifests.length === 1, 'request');
  f.complete(); await f.page.waitForFunction(() => outcomes.length === 1);
  await f.leave(); await delay(50); await f.press();
  await f.page.waitForFunction(() => outcomes.length === 2);
  assert.equal(f.state.manifests.length, 1);
  assert.equal(f.state.assets, 1, 'verified asset bytes remain reusable too');
  assert.deepEqual(await f.page.evaluate(() => outcomes.map(value => value.status)), ['warmed', 'warmed']);
});
