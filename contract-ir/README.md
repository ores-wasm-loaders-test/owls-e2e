# External WASM Contract IR admission

This suite consumes the exact merged `ores-wasm-loaders/owls-interfaces` source and the exact
`ORESoftware/typespec-json-schema-validator` producer/verifier as independent GitHub checkouts.
The `owls-interfaces` repository therefore does not grade its own downstream admission boundary.

The workflow regenerates Schema B from TypeSpec, compares it with independently authored JSON
Schema A, runs differential probes, emits a deterministic parity receipt and Contract IR, and then
calls the exported `verifyContractIr()` API from this separate test organization.

The tests require the exact artifact to pass and deliberately prove rejection of:

- a mutated IR whose self digest no longer matches;
- a changed parity receipt;
- an authored JSON Schema changed after IR emission;
- a stopped parity receipt and its non-admissible tombstone;
- missing or altered peer-authority lane provenance.

The test does not edit or rank either authority. TypeSpec and authored JSON Schema remain peers;
generated Schema B and Contract IR remain downstream comparison and admission evidence. The
workflow pins every repository and reusable Action to immutable commit SHAs, records the source
closure, hashes the evidence bundle, and uploads it for 30 days.

This is contract-admission evidence only. It is not a claim about production marketing-site
latency, mobile-device behavior, Flutter renderer selection, or browser cache persistence.
