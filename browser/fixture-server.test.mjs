// Run with: node --test browser/fixture-server.test.mjs
// These filesystem/HTTP tests require no browser, npm packages, or WASM builds.
import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {request} from "node:http";
import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {CSP, startFixtureServer} from "./fixture-server.mjs";

const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const SENTINEL = "outside-root-regression-sentinel-not-a-secret";
let fixture;
let server;
let aliasServer;

// Use a raw request path so URL normalization cannot erase traversal cases.
function get(base, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/`, {path, method: "GET", ...options}, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("fixture request timed out")));
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  const scratch = fileURLToPath(new URL("../tmp/", import.meta.url));
  await mkdir(scratch, {recursive: true});
  fixture = await mkdtemp(join(scratch, "fixture-confinement-"));
  const root = join(fixture, "root");
  const outside = join(fixture, "root-sibling");
  await mkdir(join(root, "nested"), {recursive: true});
  await mkdir(outside);
  await writeFile(join(root, "module.wasm"), WASM);
  await writeFile(join(root, "module.js"), "export const ready = true;\n");
  await writeFile(join(root, "..valid.wasm"), WASM);
  await writeFile(join(root, "nested", "module.wasm"), WASM);
  await writeFile(join(outside, "sentinel.txt"), SENTINEL);
  await symlink(join(outside, "sentinel.txt"), join(root, "escape.txt"));
  await symlink(outside, join(root, "escape-dir"), "dir");
  await symlink(join(root, "module.wasm"), join(root, "inside.wasm"));
  await symlink(join(root, "nested"), join(root, "inside-dir"), "dir");
  await symlink(join(root, "absent.wasm"), join(root, "dangling.wasm"));
  await symlink(root, join(fixture, "root-alias"), "dir");
  server = await startFixtureServer({bindgenDir: root, port: 0});
  aliasServer = await startFixtureServer({bindgenDir: join(fixture, "root-alias"), port: 0});
});

after(async () => {
  await Promise.all([server?.close(), aliasServer?.close()]);
  if (fixture) await rm(fixture, {recursive: true, force: true});
});

test("serves Wasm bytes with streaming MIME and isolation headers", async () => {
  const response = await get(server.url, "/bindgen/module.wasm");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, WASM);
  assert.equal(response.headers["content-type"], "application/wasm");
  assert.equal(response.headers["content-security-policy"], CSP);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp");
});

test("serves JavaScript with a module-compatible MIME type", async () => {
  const response = await get(server.url, "/bindgen/module.js");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
});

test("HEAD preserves length and ETag without sending the asset", async () => {
  const response = await get(server.url, "/bindgen/module.wasm", {method: "HEAD"});
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers["content-length"]), WASM.length);
  assert.equal(response.body.length, 0);
  assert.match(response.headers.etag, /^"[a-f0-9]{32}"$/);
});

test("matching ETags return 304 without a body", async () => {
  const first = await get(server.url, "/bindgen/module.wasm");
  const response = await get(server.url, "/bindgen/module.wasm", {
    headers: {"if-none-match": first.headers.etag},
  });
  assert.equal(response.status, 304);
  assert.equal(response.body.length, 0);
});

for (const path of ["/bindgen/escape.txt", "/bindgen/escape-dir/sentinel.txt"]) {
  test(`refuses outside-root symlink: ${path}`, async () => {
    const response = await get(server.url, path);
    assert.equal(response.status, 403);
    assert.equal(response.body.includes(SENTINEL), false);
  });
}

for (const path of ["/bindgen/inside.wasm", "/bindgen/inside-dir/module.wasm"]) {
  test(`allows a symlink that resolves inside the root: ${path}`, async () => {
    const response = await get(server.url, path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, WASM);
  });
}

test("allows an explicitly configured root that is itself a symlink", async () => {
  const response = await get(aliasServer.url, "/bindgen/module.wasm");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, WASM);
  const denied = await get(aliasServer.url, "/bindgen/escape.txt");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.includes(SENTINEL), false);
});

test("does not confuse a legitimate double-dot filename with a parent segment", async () => {
  const response = await get(server.url, "/bindgen/..valid.wasm");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, WASM);
});

for (const path of [
  "/bindgen/%2e%2e%2froot-sibling/sentinel.txt",
  "/bindgen/%2fetc/passwd",
  "/bindgen/bad%00.wasm",
  "/bindgen/bad%ZZ.wasm",
]) {
  test(`refuses malformed or escaping URL paths: ${path}`, async () => {
    const response = await get(server.url, path);
    assert.equal(response.status, 403);
    assert.equal(response.body.includes(SENTINEL), false);
  });
}

for (const path of ["/bindgen/missing.wasm", "/bindgen/dangling.wasm", "/bindgen/nested"]) {
  test(`missing and non-file paths remain 404: ${path}`, async () => {
    const response = await get(server.url, path);
    assert.equal(response.status, 404);
  });
}

test("the manifest does not traverse symlinks or list outside-root files", async () => {
  const response = await get(server.url, "/__manifest");
  assert.equal(response.status, 200);
  const {bindgen} = JSON.parse(response.body.toString("utf8"));
  assert.equal(bindgen.includes("module.wasm"), true);
  assert.equal(bindgen.some(path => path.includes("escape") || path.includes("sentinel")), false);
});
