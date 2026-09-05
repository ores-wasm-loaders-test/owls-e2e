// Second half of the CacheStorage check. This module runs in a *new document*
// reached by a real navigation (location.assign), not a history entry or an
// SPA route swap. Anything it can still read came from CacheStorage, not from
// the previous document's memory.

const status = document.getElementById("status");
const logEl = document.getElementById("log");

const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));

const handoff = JSON.parse(sessionStorage.getItem("owls-e2e") ?? "null");
const results = handoff?.results ?? [];
const proves =
  "Verified bytes written to CacheStorage in one document are still there, " +
  "byte-identical, after a full document navigation — so a returning user's " +
  "second page load starts from cache rather than the network.";

const started = performance.now();
try {
  if (!handoff) throw new Error("no session handoff: the first document did not run");
  const cache = await caches.open("owls-e2e");
  const cached = await cache.match(handoff.cacheableUrl);
  if (!cached) throw new Error(`CacheStorage lost ${handoff.cacheableUrl} across the navigation`);
  const type = cached.headers.get("content-type");
  if (type !== "application/wasm") throw new Error(`cached content-type was ${type}`);
  const bytes = new Uint8Array(await cached.arrayBuffer());
  if (bytes.length !== handoff.bytes)
    throw new Error(`cached ${bytes.length} bytes, expected ${handoff.bytes}`);
  const digest = await sha256(bytes);
  if (digest !== handoff.expected)
    throw new Error(`cached digest ${digest} != ${handoff.expected}`);
  // The cached response must still be usable as WebAssembly, not just as bytes.
  await WebAssembly.compile(bytes);
  results.push({
    name: "cachestorage-survives-navigation", proves, status: "pass",
    detail: `${bytes.length} bytes re-read and recompiled after navigation ` +
      `(sha256 ${digest.slice(0, 16)}…)`,
    ms: Math.round(performance.now() - started),
  });
  logEl.textContent = "pass  cachestorage-survives-navigation\n";
} catch (error) {
  results.push({
    name: "cachestorage-survives-navigation", proves, status: "fail",
    detail: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
    ms: Math.round(performance.now() - started),
  });
  logEl.textContent = `FAIL  cachestorage-survives-navigation: ${error?.stack ?? error}\n`;
} finally {
  await caches.delete("owls-e2e").catch(() => {});
  sessionStorage.removeItem("owls-e2e");
  await fetch("/__result", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({results, phase: "after-navigation"}),
  });
  status.textContent = "done";
}
