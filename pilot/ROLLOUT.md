# Evidence-gated adoption and rollback (WL-16, WT-07/08)

## Current decision

HOLD for production fleet rollout. The actual SDK fixture/build/browser jobs and
candidate package archives are engineering evidence, not field performance data.
No physical-device certification, remote Zed publication receipt, or 35-org
performance sample is fabricated. An evidence analyzer can prepare a review;
it cannot authorize deployment or infer approval from the existence of a file.

## Measurement protocol

Before collecting field observations, freeze the policy ID, exact source release,
UTC plan timestamp, browser/framework/origin/network strata, independent-session
sampling rule, sample-size/stopping rule and comparisons. Allocate A/B/C/D before
intent. Use B/A and D/C for prefetch; evaluate C/A architecture changes separately.
Retain failures rather than dropping them from latency samples. Record absent
LCP/INP as null; do not count a missing observation as zero. Keep physical devices
separate from emulation and Wasm selection separate from JavaScript fallback.

`gates.mjs` evaluates one preregistered look at independent randomized sessions.
Repeated peeking invalidates this fixed-look confidence procedure. Group repeated
observations from the same session before supplying data; sessionKey is a random
opaque 128-bit identifier, never an email, user ID, IP address or access token.
Kill-switch observations retain their assigned cohort and are counted separately.
Review sample-ratio mismatch, missingness and representativeness before analysis.
The timestamp/metadata checks cannot themselves prove honest randomization.

The analyzer uses mode-centered binomial recurrence, exact Clopper-Pearson
failure intervals, distribution-free order-statistic p75 bounds and Bonferroni
coverage across the preregistered comparisons/strata. It preserves the proposed
20% latency improvement, 5% marketing regression and 0.1 percentage-point failure
margin. A minimum 500 observations per arm is an input floor, NOT assurance of
adequate power. Zero failures in 500 observations does not prove that margin.
Use a preregistered power calculation to choose sample size; insufficient evidence
is HOLD. Code caps per-arm samples at 20,000 and total rows at 100,000 to bound
processing; larger studies need an explicit versioned analysis revision.

Receipts must identify the same release and immutable evidence hash for published
packages, browser matrix, physical mobile, security, rollback and telemetry.
A reviewer must retrieve and verify each receipt. All favorable input produces
only `eligible-for-human-review`; `productionRolloutAuthorized` remains false.
`serializeReport` records infinite bounds as `unbounded`, not misleading nulls.
Synthetic records in unit tests are labeled unit fixtures and are never results.

## Disable and rollback procedure

1. Disable preparation first (`disablePreparation: true` in `bindVariant`). A/B/C/D
   attribution remains unchanged and records the override. Ordinary activation
   and native links must still work with empty or failed preparation.
2. Disable the persistent shell (`disableShell: true`) to restore normal href
   navigation. Do not dynamically swap an incompatible release into a live engine.
3. Restore the previously verified HTML/release pointer only after confirming all
   matching immutable bootstrap/glue/Wasm/assets are retained and retrievable.
   Retain old releases for the supported open-tab lifetime, not an arbitrary count.
4. Run cold entry, warm entry, direct deep link, keyboard/mobile entry, stale HTML,
   failed preparation and auth-boundary tests against the restored release. Save
   exact source/deployment IDs and traces in the rollback receipt.

Stage expansion: controlled two-app test fixtures -> approved limited product
pilot -> representative products -> wider fleet only after evidence review.
Never consolidate auth/admin origins to manufacture cache savings. Keep controls
available and actual ores-otel product wiring verified before enrolling traffic.
No deployment or DNS mutation is performed by this runbook or analyzer.
