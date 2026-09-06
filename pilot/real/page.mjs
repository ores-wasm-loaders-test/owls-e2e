// Real fixture integration: imports only installed candidate-package files, never source checkouts.
import { Coordinator, ActivationHost, LeptosAdapter, FlutterAdapter, mountFlutterView,
  pilotPolicy, connectApplicationLink, createLoaderReporter, releaseKey } from '/packages/consumer-r1/owls-web-loader/index.mjs';
import { bindVariant } from '/controls.mjs';

const { framework, cohort, appPage } = document.documentElement.dataset;
const telemetry = [];
const flutterEvents = [];
const state = globalThis.pilot = { configured: false, ready: false, prepared: null,
  telemetry, flutterEvents, documentId: crypto.randomUUID(), hydrations: 0, handle: null };
// This is called from actual Dart main/post-frame callbacks, not a fake JS renderer.
globalThis.owlsFlutterEvent = (phase, count, viewId) => flutterEvents.push({ phase, count, viewId });
const manifest = await fetch(`/manifest/${framework}.json`).then((response) => {
  if (!response.ok) throw new Error('Missing real build manifest');
  return response.json();
});
const report = createLoaderReporter({ write: (event) => telemetry.push(event), labels: {
  cohort, framework: framework === 'rust' ? 'leptos' : 'flutter', runtimeMode: 'unknown',
} });
const coordinator = new Coordinator(pilotPolicy([location.origin]), { report });
const release = coordinator.register(manifest);
const key = releaseKey(release);
const host = new ActivationHost(coordinator, { report });
const appSection = document.querySelector('#app');
const flutterContainer = document.querySelector('#flutter-host');

function until(predicate, timeoutMs = 45000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    function check() {
      try {
        if (predicate()) return resolve();
        if (performance.now() - started > timeoutMs) return reject(new Error('Real application readiness timed out'));
        requestAnimationFrame(check);
      } catch (error) { reject(error); }
    }
    check();
  });
}

const adapter = framework === 'rust'
  ? new LeptosAdapter('module', (context) => import(context.release.assets.find((a) => a.id === 'glue').url), async (glue) => {
      const islands = [...document.querySelectorAll('leptos-island')];
      if (!islands.length || document.querySelector('leptos-children')) throw new Error('Expected bounded, non-nested real SSR islands');
      for (const element of islands) {
        if (typeof glue[element.dataset.component] !== 'function') throw new Error('SSR/build island export mismatch');
      }
      if (typeof glue.hydrate_islands !== 'function') throw new Error('Missing generated hydration entrypoint');
      glue.hydrate_islands();
      for (const element of islands) glue[element.dataset.component](element);
      state.hydrations += 1;
    })
  : new FlutterAdapter({ document, bootstrapMode: 'loader-only', getLoader: () => globalThis._flutter?.loader,
      loadConfig: { entrypointBaseUrl: '/assets/flutter/r1/', assetBase: '/assets/flutter/r1/',
        canvasKitBaseUrl: '/assets/flutter/r1/canvaskit/', forceSingleThreadedSkwasm: true },
    });

function start({ signal } = {}) {
  appSection.hidden = false;
  state.ready = false;
  const priorReady = flutterEvents.filter((e) => e.phase === 'ready').length;
  const promise = framework === 'rust'
    ? host.activate(key, adapter, { kind: 'document', document }, { signal, ready: async () => {
        await until(() => state.hydrations === 1 && document.querySelector('#rust-inc'));
      } })
    : host.activate(key, adapter, { kind: 'flutter-view', element: flutterContainer }, { signal,
        attach: (app, element) => mountFlutterView(app, element),
        ready: async () => until(() => flutterEvents.filter((e) => e.phase === 'ready').length > priorReady),
      });
  return promise.then((handle) => {
    state.handle = handle;
    void handle.interactive.then(() => { state.ready = true; }, (error) => { state.failure = String(error); });
    return handle;
  });
}
state.start = start;
state.reuseRuntime = async () => (await coordinator.activate(key, adapter)) === state.handle.runtime;
state.checkInvalidManifest = async () => {
  try { await coordinator.load(`${location.origin}/fault/not-json`); return false; }
  catch (error) { return error.code === 'mime'; }
};
const connect = (anchor, c, k, options) => connectApplicationLink(anchor, c, k, {
  ...options, intent: { onOutcome: (receipt) => { state.prepared = receipt; } },
});
state.binding = bindVariant(cohort, { connect, anchor: document.querySelector('#open'), coordinator, key, start,
  onError: (error) => { state.failure = String(error); },
});
state.configured = true;
if (appPage === 'true') {
  const handle = await start();
  await handle.interactive;
}
