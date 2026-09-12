import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

if (process.argv.length !== 2) throw new Error('This fixture accepts no CLI flags');
const root = dirname(fileURLToPath(import.meta.url));
const input = join(root, 'inputs');
const dioxus = join(input, 'dioxus');
const packagesInput = join(input, 'packages');
const output = join(root, 'evidence', 'dioxus');
const origin = 'https://127.0.0.1:4444';
await mkdir(output, { recursive: true });
for (const path of [join(dioxus, 'manifest.json'), join(dioxus, 'graph.json'), join(dioxus, 'public'), join(packagesInput, 'loader.tgz'), join(packagesInput, 'interfaces.tgz')]) {
  if (!existsSync(path)) throw new Error(`required Dioxus acceptance input missing: ${path}`);
}

const consumer = await mkdtemp(join(tmpdir(), 'owls-dioxus-consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'owls-dioxus-prefetch-consumer', private: true, type: 'module' }));
execFileSync('npm', [
  'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer,
  join(packagesInput, 'loader.tgz'), join(packagesInput, 'interfaces.tgz'),
], { stdio: 'inherit' });
const packageRoot = join(consumer, 'node_modules', '@ores-wasm-loaders');

const cert = await mkdtemp(join(tmpdir(), 'owls-dioxus-tls-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(cert, 'key.pem'),
  '-out', join(cert, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
], { stdio: 'ignore' });

const types = {
  '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.html': 'text/html', '.css': 'text/css',
};
const csp = "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'";
async function sendFile(base, relative, res) {
  if (!relative || decodeURIComponent(relative).split('/').some((part) => part === '..' || part.startsWith('.'))) {
    res.writeHead(404); res.end(); return;
  }
  const baseReal = await realpath(base);
  const file = await realpath(resolve(base, decodeURIComponent(relative)));
  if (!file.startsWith(`${baseReal}${sep}`)) { res.writeHead(403); res.end(); return; }
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.end(await readFile(file));
}

const server = createServer({ key: await readFile(join(cert, 'key.pem')), cert: await readFile(join(cert, 'cert.pem')) }, async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Dioxus prefetch</title></head><body><p id="status">starting</p><script type="module" src="/dioxus-prefetch-page.mjs"></script></body></html>');
      return;
    }
    if (url.pathname === '/manifest/dioxus.json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(await readFile(join(dioxus, 'manifest.json')));
      return;
    }
    if (url.pathname === '/dioxus-prefetch-page.mjs') {
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'no-store');
      res.end(await readFile(join(root, 'dioxus-prefetch-page.mjs')));
      return;
    }
    if (url.pathname.startsWith('/assets/dioxus/r1/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      await sendFile(join(dioxus, 'public'), url.pathname.slice('/assets/dioxus/r1/'.length), res);
      return;
    }
    if (url.pathname.startsWith('/packages/consumer-r1/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      await sendFile(packageRoot, url.pathname.slice('/packages/consumer-r1/'.length), res);
      return;
    }
    res.writeHead(404); res.end();
  } catch (error) {
    res.writeHead(404); res.end(String(error));
  }
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(4444, '127.0.0.1', resolveListen); });

const graph = JSON.parse(await readFile(join(dioxus, 'graph.json'), 'utf8'));
const results = [];
try {
  for (const [browserName, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 600 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const record = { browser: browserName, browserVersion: browser.version(), route: '/child', passed: false };
      try {
        await page.goto(origin);
        await page.waitForFunction(() => globalThis.dioxusPrefetch?.ready, null, { timeout: 60_000 });
        const evidence = await page.evaluate(() => globalThis.dioxusPrefetch);
        assert.equal(await page.locator('#status').textContent(), 'ready');
        assert.equal(evidence.first.status, 'warmed');
        assert.equal(evidence.first.ready, true);
        assert.equal(evidence.second.status, 'warmed');
        assert.equal(evidence.second.ready, true);
        assert.deepEqual(evidence.firstFetches, evidence.expectedPaths, 'first route prefetch must follow admitted dependency-first closure');
        assert.deepEqual(evidence.secondFetches, [], 'second route prefetch must reuse verified cached bytes');
        assert.equal(evidence.noExecution, true, 'route preparation instantiated Wasm');
        assert.equal(evidence.instantiateCalls, 0);
        assert.equal(evidence.instantiateStreamingCalls, 0);
        assert.equal(evidence.expectedPaths.at(-1)?.endsWith(graph.routeModule), true);
        assert.deepEqual(errors, []);
        record.first = evidence.first;
        record.second = evidence.second;
        record.fetches = evidence.firstFetches;
        record.noExecution = evidence.noExecution;
        record.passed = true;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.browserErrors = errors;
        await page.screenshot({ path: join(output, `${browserName}-failure.png`), fullPage: true }).catch(() => {});
      } finally {
        results.push(record);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

const receipt = {
  schema: 'ores-wasm-loaders.real-dioxus-prefetch-browser-receipt/v1',
  scope: 'localhost-lab',
  route: '/child',
  dioxusGraphSha256: graph.sourceSha256,
  productionRolloutAuthorized: false,
  results,
};
await writeFile(join(output, 'browser-prefetch.json'), `${JSON.stringify(receipt, null, 2)}\n`);
const failures = results.filter((record) => !record.passed);
console.log(`${results.length - failures.length}/${results.length} Dioxus route-prefetch browser scenarios passed`);
if (results.length !== 3 || failures.length) process.exitCode = 1;
