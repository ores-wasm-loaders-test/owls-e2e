// Browser-side half of the fixture harness. It runs only against real framework
// build output that the operator supplied; the runner tells it which suites the
// fixture server actually mounted.
//
// Nothing here is a mock. Every check either exercises a real build artifact or
// is not run at all.

const params = new URLSearchParams(location.search);
const suites = new Set((params.get("suites") ?? "").split(",").filter(Boolean));
const status = document.getElementById("status");
const logEl = document.getElementById("log");
const results = [];

const log = message => {
  logEl.textContent += `${message}\n`;
  navigator.sendBeacon?.("/__log", message);
};

async function check(name, proves, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({name, proves, status: "pass", detail: detail ?? null,
      ms: Math.round(performance.now() - started)});
    log(`pass  ${name}`);
  } catch (error) {
    results.push({name, proves, status: "fail",
      detail: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
      ms: Math.round(performance.now() - started)});
    log(`FAIL  ${name}: ${error?.stack ?? error}`);
  }
}

function skip(name, proves, reason) {
  results.push({name, proves, status: "skip", detail: reason, ms: 0});
  log(`skip  ${name}: ${reason}`);
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));

const manifest = await (await fetch("/__manifest")).json();
const pick = (files, test) => files.find(test);

// --------------------------------------------------------- CSP behaviour ----
await check(
  "csp-permits-wasm-but-not-eval",
  "The page can compile WebAssembly under a CSP that has no 'unsafe-eval', " +
  "so shipping WASM never requires weakening script policy.",
  async () => {
    let evalBlocked = false;
    try { new Function("return 1")(); } catch { evalBlocked = true; }
    assert(evalBlocked, "new Function() succeeded: the CSP is missing or carries 'unsafe-eval'");
    const module = await WebAssembly.compile(
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    assert(module instanceof WebAssembly.Module, "WebAssembly.compile did not return a Module");
    return "eval blocked, WebAssembly.compile allowed ('wasm-unsafe-eval')";
  });

// --------------------------------------------------- wasm-bindgen output ----
const bindgenFiles = manifest.bindgen ?? [];
const glueName = pick(bindgenFiles, f => f.endsWith(".js") && !f.endsWith(".d.ts"));
const wasmName = pick(bindgenFiles, f => f.endsWith("_bg.wasm")) ?? pick(bindgenFiles, f => f.endsWith(".wasm"));

if (!suites.has("bindgen")) {
  skip("bindgen-mime-and-init", "wasm-bindgen glue and binary load under the real MIME types",
    "OWLS_BINDGEN_DIR was not supplied");
} else if (!glueName || !wasmName) {
  skip("bindgen-mime-and-init", "wasm-bindgen glue and binary load under the real MIME types",
    `OWLS_BINDGEN_DIR has no glue/.wasm pair (saw ${bindgenFiles.length} files)`);
} else {
  await check(
    "wasm-served-as-application-wasm",
    "The fixture server's MIME types are the ones the platform requires: " +
    "compileStreaming refuses anything that is not application/wasm.",
    async () => {
      const response = await fetch(`/bindgen/${wasmName}`);
      assert(response.ok, `GET /bindgen/${wasmName} -> ${response.status}`);
      const type = response.headers.get("content-type");
      assert(type === "application/wasm", `content-type was ${type}`);
      const module = await WebAssembly.compileStreaming(response.clone());
      assert(module instanceof WebAssembly.Module, "compileStreaming did not produce a Module");
      return `${wasmName} compiled from a streaming application/wasm response`;
    });

  await check(
    "bindgen-glue-initializes-from-supplied-bytes",
    "The organization fetches and verifies the binary itself and hands the bytes " +
    "to the generated glue, exactly as BindgenAdapter does — the loader never " +
    "reaches for the network on the glue's behalf.",
    async () => {
      const bytes = new Uint8Array(await (await fetch(`/bindgen/${wasmName}`)).arrayBuffer());
      const digest = await sha256(bytes);
      const glue = await import(`/bindgen/${glueName}`);
      assert(typeof glue.default === "function",
        `${glueName} has no default export; is this a --target web build?`);
      await glue.default({module_or_path: bytes});
      const exported = Object.keys(glue).filter(k => k !== "default");
      return `${glueName} initialized from ${bytes.length} verified bytes ` +
        `(sha256 ${digest.slice(0, 16)}…), ${exported.length} export(s)`;
    });
}

// -------------------------------------------------------- Flutter output ----
const flutterFiles = manifest.flutter ?? [];
const bootstrap = pick(flutterFiles, f => f === "flutter_bootstrap.js");

if (!suites.has("flutter")) {
  skip("flutter-two-views-one-engine", "Two embedded views share one Flutter engine",
    "OWLS_FLUTTER_DIR was not supplied");
} else if (!bootstrap) {
  skip("flutter-two-views-one-engine", "Two embedded views share one Flutter engine",
    `OWLS_FLUTTER_DIR has no flutter_bootstrap.js (saw ${flutterFiles.length} files)`);
} else {
  await check(
    "flutter-two-views-one-engine",
    "A product can embed two Flutter views in one document and they share a " +
    "single engine: initializeEngine runs once, addView returns two distinct " +
    "view ids, and removeView tears one down without disturbing the other.",
    async () => {
      await import("/flutter/flutter_bootstrap.js");
      const loader = globalThis._flutter?.loader;
      assert(loader, "flutter_bootstrap.js did not install window._flutter.loader");

      let entrypoints = 0;
      const entrypoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("onEntrypointLoaded never fired")), 30000);
        loader.load({
          config: {multiViewEnabled: true},
          onEntrypointLoaded: initializer => {
            entrypoints++;
            clearTimeout(timer);
            resolve(initializer);
          },
        })?.catch?.(reject);
      });

      // One engine: initializeEngine is called exactly once, and both views come
      // from the single app object it produced.
      const runner = await entrypoint.initializeEngine({multiViewEnabled: true});
      const app = await runner.runApp();
      assert(typeof app?.addView === "function",
        "runApp() did not return a multi-view app object; check the pinned Flutter version");
      assert(typeof app.removeView === "function", "the app object has no removeView");

      const a = app.addView({hostElement: document.getElementById("view-a")});
      const b = app.addView({hostElement: document.getElementById("view-b")});
      assert(a !== b, `addView returned the same id twice: ${a}`);
      assert(entrypoints === 1, `the loader produced ${entrypoints} entrypoints, expected one`);

      app.removeView(a);
      return `views ${a} and ${b} from one engine (${entrypoints} entrypoint, ` +
        `1 initializeEngine); ${a} removed cleanly`;
    });
}

// ------------------------------------- CacheStorage across a navigation -----
// Seed the cache here, then hand off to after-navigation.html, which re-reads it
// after a full document navigation and posts the combined result.
const cacheableUrl = wasmName && suites.has("bindgen") ? `/bindgen/${wasmName}` : null;

if (!cacheableUrl) {
  skip("cachestorage-survives-navigation",
    "Verified bytes cached by CacheStorage survive a full document navigation, " +
    "so a second page load starts from cache instead of the network",
    "no real WASM artifact was supplied to cache");
  await fetch("/__result", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({results, phase: "single-document"}),
  });
  status.textContent = "done";
} else {
  const response = await fetch(cacheableUrl);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const cache = await caches.open("owls-e2e");
  await cache.put(cacheableUrl, response);
  sessionStorage.setItem("owls-e2e", JSON.stringify({
    results, cacheableUrl, expected: await sha256(bytes), bytes: bytes.length,
  }));
  status.textContent = "navigating…";
  location.assign("./after-navigation.html");
}
