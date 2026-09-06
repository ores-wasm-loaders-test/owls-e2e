// Real browsers and generated framework output. No mocked rendering or fabricated field results.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile, writeFile, mkdir, realpath, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

if (process.argv.length !== 2) throw new Error('This fixture accepts no CLI flags');
const root = dirname(fileURLToPath(import.meta.url));
const input = join(root, 'inputs');
const output = join(root, 'evidence');
const origin = 'https://127.0.0.1:4443';
const consumer = join(root, 'consumer');
await mkdir(output, { recursive: true });
await mkdir(consumer, { recursive: true });
await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'owls-isolated-candidate-consumer', private: true, type: 'module' }));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer,
  join(input, 'packages', 'loader.tgz'), join(input, 'packages', 'interfaces.tgz')], { stdio: 'inherit' });
const packages = join(consumer, 'node_modules', '@ores-wasm-loaders');
const interfaces = await import(pathToFileURL(join(packages, 'owls-interfaces', 'index.mjs')).href);
const islandHtml = await readFile(join(input, 'rust', 'island.html'), 'utf8');
assert.match(islandHtml, /<leptos-island/);
const islandNames = [...islandHtml.matchAll(/data-component="([^"]+)"/g)].map((match) => match[1]);
assert.ok(islandNames.length > 0, 'SSR markup must name the generated island exports');
const manifests = {};
for (const framework of ['rust', 'flutter']) {
  const recipe = { root: join(input, framework), base_url: `${origin}/assets/${framework}/r1/`,
    app_id: `${framework}-pilot`, release: 'r1', runtime: framework === 'rust' ? 'wasm-bindgen' : 'flutter-web',
    entrypoint: framework === 'rust' ? 'app.js' : 'flutter_bootstrap.js',
    islands: framework === 'rust' ? islandNames : [],
    toolchain: { fixture: framework === 'rust' ? 'leptos-0.8.2' : 'flutter-3.35.2' },
  };
  const manifest = JSON.parse(execFileSync(join(input, 'packages', 'owls-build-manifest'), [], { input: JSON.stringify(recipe), encoding: 'utf8' }));
  interfaces.parseRelease(manifest, [origin], interfaces.releaseSchema);
  manifests[framework] = manifest;
  await writeFile(join(output, `${framework}-manifest.json`), JSON.stringify(manifest, null, 2));
}
const cert = await mkdtemp(join(tmpdir(), 'owls-local-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(cert, 'key.pem'),
  '-out', join(cert, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";
const types = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer({ key: await readFile(join(cert, 'key.pem')), cert: await readFile(join(cert, 'cert.pem')) }, async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (['/', '/marketing', '/app'].includes(url.pathname)) {
      const framework = url.searchParams.get('framework') ?? 'rust';
      const cohort = url.searchParams.get('cohort') ?? 'A';
      if (!['rust', 'flutter'].includes(framework) || !['A', 'B', 'C', 'D'].includes(cohort)) { res.writeHead(400); res.end(); return; }
      const appPage = url.pathname === '/app';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="en" data-framework="${framework}" data-cohort="${cohort}" data-app-page="${appPage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Real OWLS pilot</title></head><body><header><h1>HTML-first marketing</h1><a id="open" href="/app?framework=${framework}&cohort=${cohort}">Open app</a></header><main id="app" ${appPage ? '' : 'hidden'}>${framework === 'rust' ? islandHtml : '<div id="flutter-host" style="width:640px;max-width:100%;height:400px"></div>'}</main><script type="module" src="/pilot.mjs"></script></body></html>`);
      return;
    }
    if (url.pathname === '/fault/not-json') { res.setHeader('Content-Type', 'text/html'); res.end('{}'); return; }
    const manifestMatch = /^\/manifest\/(rust|flutter)\.json$/.exec(url.pathname);
    if (manifestMatch) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifests[manifestMatch[1]])); return; }
    let base, relative;
    if (url.pathname === '/pilot.mjs') { base = root; relative = 'page.mjs'; }
    else if (url.pathname === '/controls.mjs') { base = dirname(root); relative = 'controls.mjs'; }
    else if (url.pathname.startsWith('/packages/consumer-r1/')) { base = packages; relative = url.pathname.slice('/packages/consumer-r1/'.length); }
    else {
      const match = /^\/assets\/(rust|flutter)\/r1\/(.+)$/.exec(url.pathname);
      if (match) { base = join(input, match[1]); relative = match[2]; }
    }
    if (!base || !relative || decodeURIComponent(relative).split('/').some((p) => p === '..' || p.startsWith('.'))) { res.writeHead(404); res.end(); return; }
    const file = await realpath(resolve(base, decodeURIComponent(relative)));
    if (!file.startsWith((await realpath(base)) + sep)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/packages/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4443, '127.0.0.1', resolve); });
const results = [];
try {
  for (const [browserName, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
    try {
      for (const framework of ['rust', 'flutter']) for (const cohort of ['A', 'B', 'C', 'D']) {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 760 } });
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        const errors = [], requests = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => { if (request.url().startsWith(origin)) requests.push(new URL(request.url()).pathname); });
        const record = { browser: browserName, browserVersion: browser.version(), framework, cohort, scope: 'localhost-lab', passed: false };
        try {
          await page.goto(`${origin}/marketing?framework=${framework}&cohort=${cohort}`);
          await page.waitForFunction(() => globalThis.pilot?.configured);
          assert.equal(await page.locator('h1').textContent(), 'HTML-first marketing');
          const before = await page.evaluate(() => pilot.documentId);
          if (['B', 'D'].includes(cohort)) {
            await page.locator('#open').hover();
            await page.waitForFunction(() => pilot.prepared !== null, null, { timeout: 30000 });
          }
          assert.deepEqual(await page.evaluate(() => [pilot.hydrations, pilot.flutterEvents.length]), [0, 0], 'Preparation must not execute either application');
          const started = performance.now();
          // Keyboard navigation is the correctness path; no mouse-only activation requirement.
          await page.locator('#open').focus();
          await page.locator('#open').press('Enter');
          await page.waitForFunction(() => globalThis.pilot?.ready, null, { timeout: 60000 });
          const after = await page.evaluate(() => pilot.documentId);
          record.documentPersisted = before === after;
          assert.equal(record.documentPersisted, ['C', 'D'].includes(cohort));
          if (framework === 'rust') {
            await page.locator('#rust-inc').click();
            await page.waitForFunction(() => document.querySelector('#rust-count')?.textContent === '1');
            assert.equal(await page.evaluate(() => pilot.hydrations), 1);
          } else {
            await page.getByRole('button', { name: 'Increment Flutter', exact: true }).click();
            await page.waitForFunction(() => pilot.flutterEvents.some((e) => e.phase === 'changed' && e.count === 1));
            assert.equal(await page.evaluate(() => pilot.flutterEvents.filter((e) => e.phase === 'main').length), 1);
          }
          record.clickToVerifiedInteractionMs = performance.now() - started;
          assert.equal(await page.evaluate(() => pilot.checkInvalidManifest()), true);
          assert.equal(await page.evaluate(() => pilot.reuseRuntime()), true);
          if (framework === 'flutter' && ['C', 'D'].includes(cohort)) {
            await page.evaluate(async () => { await pilot.handle.unmount(); const handle = await pilot.start(); await handle.interactive; });
            await page.getByRole('button', { name: 'Increment Flutter', exact: true }).click();
            await page.waitForFunction(() => pilot.flutterEvents.filter((e) => e.phase === 'changed' && e.count === 1).length === 2);
            assert.equal(await page.evaluate(() => pilot.flutterEvents.filter((e) => e.phase === 'main').length), 1, 'Remount must not restart Dart main');
          }
          record.runtimeMode = framework === 'rust' ? 'wasm' : requests.some((path) => path.endsWith('/main.dart.wasm')) ? 'wasm' : requests.some((path) => path.endsWith('/main.dart.js')) ? 'javascript' : 'unobserved';
          assert.notEqual(record.runtimeMode, 'unobserved');
          record.telemetry = await page.evaluate(() => pilot.telemetry);
          record.resourceTiming = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/')).map((e) => ({ path: new URL(e.name).pathname, transferSize: e.transferSize, duration: e.duration })));
          // Raw timings are retained; transferSize=0 alone is never labeled a cache hit.
          assert.deepEqual(errors, [], 'Unexpected browser exceptions');
          record.passed = true;
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          record.browserErrors = errors;
          await page.screenshot({ path: join(output, `${browserName}-${framework}-${cohort}.png`), fullPage: true }).catch(() => {});
        } finally {
          record.assetRequests = requests.filter((path) => path.startsWith('/assets/'));
          results.push(record);
          await context.tracing.stop({ path: join(output, `${browserName}-${framework}-${cohort}.zip`) });
          await context.close();
          console.log(JSON.stringify({ browser: browserName, framework, cohort, passed: record.passed, error: record.error }));
          await writeFile(join(output, 'browser-results.json'), JSON.stringify({ scope: 'localhost-lab', productionRolloutAuthorized: false, results }, null, 2));
        }
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
const failures = results.filter((record) => !record.passed);
console.log(`${results.length - failures.length}/${results.length} real framework/browser/cohort scenarios passed`);
if (results.length !== 24 || failures.length) process.exitCode = 1;
