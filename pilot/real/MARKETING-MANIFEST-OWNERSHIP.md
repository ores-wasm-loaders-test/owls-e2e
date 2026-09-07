# Independent marketing manifest ownership certification

Producer: https://github.com/ores-wasm-loaders/owls-web-loader/pull/14

The dedicated workflow pins loader commit `d60920a4645d05a85e7fde1a2e965e7ad49806ff` and interface commit `231510f5d01046af657be42a5d4215be12622042`. It uses the repository's existing locked Playwright 1.55.0 and runs eight scenarios independently on Chromium, Firefox and WebKit (24 planned executions, not passes until the run completes).

The test imports the actual browser Coordinator and marketing integration. A real local HTTPS server deliberately stalls either response headers or the JSON body. Cancellation is checked both through the passed AbortSignal and server-side response closure; no mocked transport or copied producer implementation stands in for network I/O. Successful cases prepare a length- and SHA-256-verified eight-byte public Wasm module without executing it.

Coverage: final-owner header/body cancellation; one-of-two consumer release; successful retry after abort; idempotent disposal without navigation; dispatched pagehide/pageshow lifecycle; actual ordinary link navigation; and successful manifest/asset reuse. Page-transition dispatch does not establish actual BFCache admission, cross-site cache sharing, framework rendering parity, physical-device performance or production rollout.

The TLS certificate/key are generated ephemerally under the runner temporary directory and removed afterward. Test contexts alone ignore that self-signed fixture certificate; no production policy is changed and no keys are uploaded. Workflow artifacts contain only selected public test/source inputs, exact revisions and TAP results.

Local Node syntax validation succeeded. Local Chromium could launch but its managed sandbox rejected loopback HTTPS navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`; those attempts are not counted as passes. Hosted browser results are authoritative for this suite. The producer's 142 loader and 16 contract regressions passed both locally and in its separate hosted conformance check.
