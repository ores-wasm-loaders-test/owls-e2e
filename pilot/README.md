# Independent four-variant pilot controls — WT-03

This is experiment setup logic, not a second loader. It adds only `pilot/` and its
own CI workflow; it does not overwrite the active external-consumer work in PR #2.
Read that suite's AGENTS.md before changing its corpus or consumer integrations.

A = normal navigation/no preparation; B = normal navigation/fetch-only preparation;
C = persistent shell/no preparation; D = persistent shell/fetch-only preparation.
Call `allocateCohort()` before observing hover/focus and retain the assigned cohort
for the experiment session. Do not derive it from user identity or engagement.
Use `bindVariant` with the installed owls package's `connectApplicationLink` and
application-specific activation callback. It never imports or copies loader source.
Existing consumer requirements still apply: resolve published packages through
zed_modules, not sibling source imports. This change does not publish a package.

Record the returned config with experiment observations. Kill switches preserve
the assigned cohort and mark `overridden: true`; apply a preregistered exclusion
or separate stratum instead of silently reclassifying treatment as control.
The low-level comparison helper permits B/A and D/C for prefetch, and C/A for
persistent-document effects. It rejects comparisons changing both variables.

Run `node --test --test-reporter=tap pilot/*.test.mjs`. Fourteen deterministic
tests verify setup, allocation boundaries, disable switches, native-mode callback
exclusion, and comparison invariants. CI records exact source/Node versions and TAP.
This does not test real Flutter/Leptos/Dioxus, browsers, package installation, or
performance. WT-02/WT-04/WT-07 still need real SDK fixtures, devices, network traces,
adequate samples and confidence analysis. No 20% speedup or production go/no-go is
asserted by these control tests.
