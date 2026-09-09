const origin = location.origin;
globalThis.__OWLS_INTERFACES_URL__ = `${origin}/packages/consumer-r1/owls-interfaces/index.mjs`;

const [loader, interfaces] = await Promise.all([
  import(`${origin}/packages/consumer-r1/owls-web-loader/index.mjs`),
  import(globalThis.__OWLS_INTERFACES_URL__),
]);

const manifestResponse = await fetch('/manifest/dioxus.json', { credentials: 'omit', cache: 'no-store' });
if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
const release = interfaces.parseRelease(manifest, [origin], interfaces.releaseSchema);
const expectedClosure = interfaces.dependencyClosureForRoute(release, '/child');
if (expectedClosure.length === 0) throw new Error('Dioxus /child has no admitted dependency closure');

const nativeFetch = globalThis.fetch.bind(globalThis);
const assetFetches = [];
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
  const url = new URL(raw, location.href);
  if (url.origin === origin && url.pathname.startsWith('/assets/dioxus/r1/')) assetFetches.push(url.pathname);
  return nativeFetch(input, init);
};

let instantiateCalls = 0;
let instantiateStreamingCalls = 0;
const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);
const nativeInstantiateStreaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
WebAssembly.instantiate = (...args) => {
  instantiateCalls += 1;
  return nativeInstantiate(...args);
};
if (nativeInstantiateStreaming) {
  WebAssembly.instantiateStreaming = (...args) => {
    instantiateStreamingCalls += 1;
    return nativeInstantiateStreaming(...args);
  };
}

const telemetry = [];
const policy = loader.browserPolicy([origin], {
  maxPrepareBytes: 64 * 1024 * 1024,
  maxAssetBytes: 64 * 1024 * 1024,
  concurrency: 2,
  timeoutMs: 30_000,
  allowPreparation: () => true,
});
const coordinator = new loader.Coordinator(policy, { report: (event) => telemetry.push(event) });
const registered = coordinator.register(manifest);
const key = interfaces.releaseKey(registered);

const beforeFirst = assetFetches.length;
const first = await loader.prefetchRoute(coordinator, key, '/child');
const afterFirst = assetFetches.length;
const firstFetches = assetFetches.slice(beforeFirst, afterFirst);
const beforeSecond = assetFetches.length;
const second = await loader.prefetchRoute(coordinator, key, '/child');
const secondFetches = assetFetches.slice(beforeSecond);

const expectedPaths = expectedClosure.map((asset) => new URL(asset.url).pathname);
const noExecution = instantiateCalls === 0 && instantiateStreamingCalls === 0;

globalThis.dioxusPrefetch = Object.freeze({
  ready: true,
  first,
  second,
  firstFetches: Object.freeze(firstFetches),
  secondFetches: Object.freeze(secondFetches),
  expectedPaths: Object.freeze(expectedPaths),
  instantiateCalls,
  instantiateStreamingCalls,
  noExecution,
  telemetry: Object.freeze(telemetry),
});

document.querySelector('#status').textContent = noExecution && first.ready && second.ready ? 'ready' : 'failed';
