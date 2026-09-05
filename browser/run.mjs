#!/usr/bin/env node
// Chromium fixture harness runner. Zero npm dependencies: it starts the local
// fixture server, drives a Chromium binary the operator already has, and waits
// for the page to post its results back.
//
// It is honest by construction. There are no stub builds and no simulated
// framework output: if OWLS_BINDGEN_DIR / OWLS_FLUTTER_DIR are absent, or no
// Chromium is installed, the corresponding checks SKIP with the reason printed.
// Pass --require (or OWLS_BROWSER_REQUIRE=1) to turn any skip into a failure,
// which is what a machine that is supposed to have the inputs should do.

import {spawn} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startFixtureServer} from "./fixture-server.mjs";

const argv = new Set(process.argv.slice(2));
const REQUIRE = argv.has("--require") || process.env.OWLS_BROWSER_REQUIRE === "1";
const KEEP_OPEN = argv.has("--headful");
const TIMEOUT_MS = Number(process.env.OWLS_BROWSER_TIMEOUT_MS ?? 120000);

const CHROME_CANDIDATES = [
  process.env.OWLS_CHROME, process.env.CHROME, process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function skipAll(reason) {
  const banner = "=".repeat(72);
  console.log(`${banner}\nSKIP: browser fixture harness did not run\n  ${reason}\n` +
    "  This is a skip, not a pass. Nothing about the browser behaviour was checked.\n" +
    "  See browser/README.md for how to produce the inputs.\n" + banner);
  process.exit(REQUIRE ? 1 : 0);
}

function isDirectory(path) {
  try { return Boolean(path) && statSync(path).isDirectory(); } catch { return false; }
}

const bindgenDir = process.env.OWLS_BINDGEN_DIR;
const flutterDir = process.env.OWLS_FLUTTER_DIR;
const haveBindgen = isDirectory(bindgenDir);
const haveFlutter = isDirectory(flutterDir);

if (!haveBindgen && !haveFlutter) {
  skipAll("neither OWLS_BINDGEN_DIR nor OWLS_FLUTTER_DIR points at a directory. " +
    "Set at least one to a real framework build output " +
    "(`wasm-pack build --target web`, `flutter build web --wasm`).");
}
for (const [name, value, ok] of [["OWLS_BINDGEN_DIR", bindgenDir, haveBindgen],
  ["OWLS_FLUTTER_DIR", flutterDir, haveFlutter]]) {
  if (value && !ok) skipAll(`${name}=${value} is not a directory.`);
  if (!value) console.log(`note: ${name} is unset; its checks will report skip.`);
}

const chrome = CHROME_CANDIDATES.find(path => path && existsSync(path));
if (!chrome) {
  skipAll("no Chromium binary found. Set OWLS_CHROME to one, or install " +
    `Chromium/Chrome at one of: ${CHROME_CANDIDATES.filter(Boolean).slice(4).join(", ")}`);
}

const server = await startFixtureServer({
  bindgenDir: haveBindgen ? bindgenDir : undefined,
  flutterDir: haveFlutter ? flutterDir : undefined,
  port: Number(process.env.OWLS_FIXTURE_PORT ?? 8642),
  cert: process.env.OWLS_FIXTURE_CERT,
  key: process.env.OWLS_FIXTURE_KEY,
});

const suites = [haveBindgen ? "bindgen" : null, haveFlutter ? "flutter" : null].filter(Boolean);
const target = `${server.url}/harness/index.html?suites=${suites.join(",")}`;
console.log(`fixture server: ${server.url} (${server.secure ? "https" : "http"})`);
console.log(`chromium      : ${chrome}`);
console.log(`target        : ${target}\n`);

const profile = mkdtempSync(join(tmpdir(), "owls-e2e-chrome-"));
const flags = [
  KEEP_OPEN ? "--auto-open-devtools-for-tabs" : "--headless=new",
  "--disable-gpu",
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  // The fixture server is on 127.0.0.1 with a self-signed certificate only when
  // the operator supplies one; accept it in that case.
  ...(server.secure ? ["--ignore-certificate-errors"] : []),
  // Chromium's sandbox cannot start inside most CI containers. This browser only
  // ever loads 127.0.0.1 fixtures from the operator's own build output.
  ...(process.env.OWLS_CHROME_SANDBOX === "1" ? [] : ["--no-sandbox"]),
  target,
];

const child = spawn(chrome, flags, {stdio: ["ignore", "pipe", "pipe"]});
child.stdout.on("data", d => process.env.OWLS_BROWSER_VERBOSE && process.stdout.write(`[chrome] ${d}`));
child.stderr.on("data", d => process.env.OWLS_BROWSER_VERBOSE && process.stderr.write(`[chrome] ${d}`));

let exitCode = 1;
try {
  const payload = await Promise.race([
    server.result,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`no result after ${TIMEOUT_MS}ms`)), TIMEOUT_MS).unref?.()),
    new Promise((_, reject) => child.once("exit", code =>
      reject(new Error(`chromium exited early with code ${code}`)))),
  ]);

  const rows = payload.results ?? [];
  const width = Math.max(...rows.map(r => r.name.length), 10);
  console.log(`phase: ${payload.phase}\n`);
  for (const row of rows) {
    console.log(`${row.status.toUpperCase().padEnd(5)} ${row.name.padEnd(width)}  ${row.ms}ms`);
    console.log(`      proves: ${row.proves}`);
    console.log(`      detail: ${row.detail}\n`);
  }

  const failed = rows.filter(r => r.status === "fail");
  const skipped = rows.filter(r => r.status === "skip");
  console.log(`${rows.length} check(s): ${rows.length - failed.length - skipped.length} pass, ` +
    `${failed.length} fail, ${skipped.length} skip`);
  for (const row of skipped) console.log(`  SKIPPED (not passed): ${row.name} — ${row.detail}`);

  if (failed.length) exitCode = 1;
  else if (skipped.length && REQUIRE) {
    console.error("\n--require was set, so a skipped check is a failure.");
    exitCode = 1;
  } else exitCode = 0;
} catch (error) {
  console.error(`browser harness error: ${error.message}`);
  for (const line of server.logs) console.error(`[page] ${line}`);
  exitCode = 1;
} finally {
  child.kill("SIGKILL");
  await server.close();
  rmSync(profile, {recursive: true, force: true});
}

process.exit(exitCode);
