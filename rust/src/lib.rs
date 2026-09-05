//! Shared fixtures for the external-consumer tests.
//!
//! Nothing here wraps or re-implements owls-runtime: an organization consuming
//! the published package only needs the corpus reader and a couple of byte
//! fixtures. The interesting code lives in `tests/`.

#![forbid(unsafe_code)]

use serde_json::Value;
use std::path::PathBuf;

/// One entry from `corpus/release-corpus.json`.
#[derive(Debug, Clone)]
pub struct Case {
    pub name: String,
    /// `"valid"`, `"schema"` or `"host"`.
    pub expect: String,
    pub reason: String,
    pub origins: Vec<String>,
    pub release: Value,
    /// The host-layer error class the case expects, when it declares one.
    pub code: Option<String>,
    /// Hosts on which the rejection is known not to carry the declared error type.
    pub deviation_hosts: Vec<String>,
}

impl Case {
    pub fn deviates(&self) -> bool {
        self.deviation_hosts.iter().any(|h| h == "rust")
    }
}

fn corpus_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../corpus/release-corpus.json")
}

/// Read the shared corpus. Panics with a readable message rather than skipping:
/// the corpus is committed in this repository, so a missing file is a real bug.
pub fn corpus() -> Vec<Case> {
    let path = corpus_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    assert_eq!(
        doc["schemaVersion"].as_u64(),
        Some(1),
        "unsupported corpus schemaVersion in {}",
        path.display()
    );
    let cases = doc["cases"].as_array().expect("corpus 'cases' must be an array");
    assert!(!cases.is_empty(), "corpus is empty");
    cases
        .iter()
        .map(|c| Case {
            name: c["name"].as_str().expect("case name").to_owned(),
            expect: c["expect"].as_str().expect("case expect").to_owned(),
            reason: c["reason"].as_str().expect("case reason").to_owned(),
            origins: c["origins"]
                .as_array()
                .expect("case origins")
                .iter()
                .map(|o| o.as_str().expect("origin string").to_owned())
                .collect(),
            release: c["release"].clone(),
            code: c["code"].as_str().map(str::to_owned),
            deviation_hosts: c["deviation"]["hosts"]
                .as_array()
                .map(|hosts| {
                    hosts
                        .iter()
                        .filter_map(|h| h.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

/// Lowercase hex SHA-256, the form the release schema requires.
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// A real, minimal WebAssembly module: magic plus version.
pub const GOOD_WASM: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// Report a batch of per-case failures in one readable panic.
pub fn report(failures: Vec<String>) {
    if !failures.is_empty() {
        panic!(
            "{} corpus case(s) disagree with owls-runtime:\n  - {}",
            failures.len(),
            failures.join("\n  - ")
        );
    }
}
