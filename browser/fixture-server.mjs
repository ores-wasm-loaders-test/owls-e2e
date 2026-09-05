// A deterministic local fixture server for the Chromium harness. Zero npm deps.
//
// It serves three things:
//   /harness/*          the harness pages in browser/pages/
//   /bindgen/*          the operator's `wasm-pack build --target web` output
//   /flutter/*          the operator's `flutter build web --wasm` output
//   /__manifest         a sorted listing of the two build directories
//   /__result           POST sink for the harness's results
//
// Everything about it is fixed on purpose: a pinned port, sorted listings,
// content-addressed ETags and immutable caching, so a run either reproduces or
// tells you which byte changed.
//
// MIME types matter here. `WebAssembly.compileStreaming` refuses a response that
// is not `application/wasm`, and an ES module import refuses anything that is not
// a JavaScript MIME type — so serving these correctly is itself part of the test.

import {createHash} from "node:crypto";
import {createServer as createHttpServer} from "node:http";
import {createServer as createHttpsServer} from "node:https";
import {readFile, readdir, stat} from "node:fs/promises";
import {existsSync} from "node:fs";
import {extname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const PAGES = fileURLToPath(new URL("./pages/", import.meta.url));

const MIME = new Map(Object.entries({
  ".wasm": "application/wasm",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".symbols": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}));

// 'wasm-unsafe-eval' is the whole point: WebAssembly compilation is permitted,
// JavaScript eval()/new Function() is not. A harness check asserts both halves.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function contentType(path) {
  return MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

/** Resolve `urlPath` under `root`, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.replace(/^\/+/, "")); }
  catch { return null; }
  if (!decoded || decoded.includes("\0")) return null;
  const base = resolve(root);
  const target = resolve(base, decoded);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return target;
}

async function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of (await readdir(join(root, prefix), {withFileTypes: true}))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * @param {{bindgenDir?: string, flutterDir?: string, port?: number,
 *          cert?: string, key?: string, crossOriginIsolated?: boolean}} options
 */
export async function startFixtureServer(options = {}) {
  const roots = new Map();
  if (options.bindgenDir) roots.set("bindgen", resolve(options.bindgenDir));
  if (options.flutterDir) roots.set("flutter", resolve(options.flutterDir));
  roots.set("harness", PAGES);

  let resolveResult;
  const result = new Promise(r => { resolveResult = r; });
  const logs = [];

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body, type = "text/plain; charset=utf-8", extra = {}) => {
      res.writeHead(status, {
        "content-type": type,
        "content-length": Buffer.byteLength(body),
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        ...(options.crossOriginIsolated === false ? {} : {
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
          "cross-origin-resource-policy": "same-origin",
        }),
        ...extra,
      });
      res.end(body);
    };

    if (req.method === "POST" && url.pathname === "/__result") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch (e) { parsed = {error: `unparseable result payload: ${e.message}`}; }
      send(200, "ok");
      resolveResult(parsed);
      return;
    }
    if (req.method === "POST" && url.pathname === "/__log") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      logs.push(Buffer.concat(chunks).toString("utf8"));
      send(200, "ok");
      return;
    }
    if (url.pathname === "/__manifest") {
      const manifest = {};
      for (const [name, root] of roots)
        manifest[name] = name === "harness" ? [] : await listFiles(root);
      send(200, JSON.stringify(manifest, null, 2), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { send(405, "method not allowed"); return; }

    const [, mount, ...rest] = url.pathname.split("/");
    if (url.pathname === "/") { res.writeHead(302, {location: "/harness/index.html"}); res.end(); return; }
    const root = roots.get(mount);
    if (!root) { send(404, `no such mount: /${mount}`); return; }

    const path = safeJoin(root, rest.join("/") || "index.html");
    if (!path) { send(403, "path escapes the fixture root"); return; }
    if (!existsSync(path) || !(await stat(path)).isFile()) { send(404, `not found: ${url.pathname}`); return; }

    const body = await readFile(path);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, {
      "content-type": contentType(path),
      "content-length": body.length,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      etag,
      ...(options.crossOriginIsolated === false ? {} : {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      }),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  const wrapped = (req, res) => handler(req, res).catch(e => {
    if (!res.headersSent) res.writeHead(500, {"content-type": "text/plain"});
    res.end(`fixture server error: ${e.stack}`);
  });

  const secure = Boolean(options.cert && options.key);
  const server = secure
    ? createHttpsServer({cert: await readFile(options.cert), key: await readFile(options.key)}, wrapped)
    : createHttpServer(wrapped);

  const port = options.port ?? 8642;
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });

  return {
    // http://127.0.0.1 is a trustworthy origin, so CacheStorage, WebAssembly
    // streaming and cross-origin isolation all behave as they do under HTTPS.
    url: `${secure ? "https" : "http"}://127.0.0.1:${server.address().port}`,
    secure,
    logs,
    result,
    close: () => new Promise(ok => server.close(ok)),
  };
}
