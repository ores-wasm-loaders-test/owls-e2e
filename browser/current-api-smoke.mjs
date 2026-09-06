import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const assetUrl = 'https://assets.ores-wasm-loaders.test/fixture.wasm';
let wasmRequests = 0;
let schemaRequests = 0;

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body>
  <main>
    <h1>OWLS browser consumer</h1>
    <button id="open" type="button">Open application</button>
    <output id="status" aria-live="polite">idle</output>
  </main>
  <script type="module" nonce="owls-e2e">
    const interfacesUrl = '/zed_modules/ores-wasm-loaders/owls-interfaces/index.mjs';
    const assetUrl = ${JSON.stringify('https://assets.ores-wasm-loaders.test/fixture.wasm')};
    globalThis.__OWLS_INTERFACES_URL__ = interfacesUrl;
    const {
      Coordinator,
      MemoryStore,
      RawWasmAdapter,
      browserPolicy,
      prepareOnIntent,
      releaseKey,
    } = await import('/zed_modules/ores-wasm-loaders/owls-web-loader/index.mjs');

    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const events = [];
    const coordinator = new Coordinator(browserPolicy([new URL(assetUrl).origin], {
      maxPrepareBytes: 1024,
      maxAssetBytes: 1024,
      concurrency: 1,
      timeoutMs: 5000,
      activationJoinMs: 25,
      allowPreparation: () => true,
    }), {
      store: new MemoryStore(),
      report: (event) => events.push(event),
    });
    const release = coordinator.register({
      schemaVersion: 1,
      appId: 'browser-consumer',
      release: '2026.09.06-chromium',
      runtime: 'raw-wasm',
      entrypoint: 'engine',
      assets: [{
        id: 'engine',
        url: assetUrl,
        kind: 'wasm',
        bytes: bytes.length,
        sha256: digest,
        prepare: true,
      }],
    });
    const key = releaseKey(release);
    const button = document.querySelector('#open');
    const status = document.querySelector('#status');
    const stopIntent = prepareOnIntent(button, coordinator, key, { dwellMs: 20, exitGraceMs: 20 });

    button.addEventListener('click', async () => {
      status.value = 'loading';
      const instance = await coordinator.activate(key, new RawWasmAdapter());
      status.value = instance instanceof WebAssembly.Instance ? 'interactive' : 'failed';
      globalThis.__owlsResult = {
        status: status.value,
        fetched: events.filter((event) => event.phase === 'fetch').length,
        activated: events.filter((event) => event.phase === 'activated').length,
        receipt: coordinator.receiptFor(key),
      };
      stopIntent();
    });
    globalThis.__owlsReady = true;
  </script>
</body>
</html>`;

const mime = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'nonce-owls-e2e' 'wasm-unsafe-eval'; connect-src 'self' https://assets.ores-wasm-loaders.test; object-src 'none'; base-uri 'none'",
    );
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    if (request.url === '/zed_modules/ores-wasm-loaders/owls-interfaces/schemas/release.schema.json') {
      schemaRequests += 1;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '');
    const file = resolve(root, pathname);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(file);
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.end(body);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error));
  }
});

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route(assetUrl, async (route) => {
    wasmRequests += 1;
    await route.fulfill({
      status: 200,
      body: wasm,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': 'application/wasm',
      },
    });
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__owlsReady === true);
  await page.hover('#open');
  await page.waitForFunction(
    (url) => performance.getEntriesByName(url).length === 1,
    assetUrl,
  );
  await page.click('#open');
  await page.waitForFunction(() => globalThis.__owlsResult?.status === 'interactive');
  const result = await page.evaluate(() => globalThis.__owlsResult);

  if (pageErrors.length) throw new Error(`browser page errors:\n${pageErrors.join('\n')}`);
  if (result.fetched !== 1) throw new Error(`expected one verified loader fetch event, saw ${result.fetched}`);
  if (result.activated !== 1) throw new Error(`expected one activation event, saw ${result.activated}`);
  if (result.receipt?.status !== 'warmed') throw new Error(`unexpected preparation receipt: ${JSON.stringify(result.receipt)}`);
  if (wasmRequests !== 1) throw new Error(`expected one network transfer for Wasm, saw ${wasmRequests}`);
  if (schemaRequests !== 1) throw new Error(`expected one authoritative schema fetch, saw ${schemaRequests}`);
  console.log(JSON.stringify({ status: 'passed', wasmRequests, schemaRequests, result }));
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
