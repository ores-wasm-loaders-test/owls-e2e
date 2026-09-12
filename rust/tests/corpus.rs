//! The shared corpus, driven through the native host.
//!
//! `owls_runtime::parse_release` folds both layers into `Error::Manifest`, so the
//! marker for "the JSON Schema rejected it" is the exact message the runtime uses
//! for a schema failure. Everything else that is still a `Manifest` error came
//! from the host-invariant layer, which is what `expect = "host"` claims.

use owls_e2e_consumer::{corpus, report, Case};
use owls_runtime::{parse_release, Error, Policy};

const SCHEMA_REJECTION: &str = "JSON Schema mismatch";

fn policy(case: &Case) -> Policy {
    Policy::new(case.origins.clone())
}

/// Host-layer error classes, expressed as the substrings owls-runtime emits.
/// A `code` in the corpus is the shared vocabulary; this maps it onto this host.
fn accepts_code(code: &str, message: &str) -> bool {
    match code {
        // A URL the parser rejects outright and a URL that fails the canonical
        // HTTPS/allowlist test are the same refusal from a consumer's point of view.
        "origin" => {
            message.contains("canonical HTTPS allowlist required") || message.contains("invalid URL")
        }
        "duplicate" => message.contains("duplicate asset"),
        "entrypoint" => message.contains("invalid entrypoint"),
        _ => false,
    }
}

#[test]
fn valid_cases_parse_and_round_trip() {
    let mut failures = Vec::new();
    let mut valid = 0usize;
    let mut runtimes = std::collections::BTreeSet::new();

    for case in corpus().into_iter().filter(|c| c.expect == "valid") {
        valid += 1;
        runtimes.insert(case.release["runtime"].as_str().unwrap_or("?").to_owned());
        match parse_release(case.release.clone(), &policy(&case)) {
            Err(e) => failures.push(format!("{}: expected acceptance, got {e} ({})", case.name, case.reason)),
            Ok(release) => {
                // Deserializing and re-serializing must not lose or invent a field.
                match serde_json::to_value(&release) {
                    Err(e) => failures.push(format!("{}: release is not serializable: {e}", case.name)),
                    Ok(round_tripped) if round_tripped != case.release => failures.push(format!(
                        "{}: round-trip changed the release\n      in : {}\n      out: {}",
                        case.name, case.release, round_tripped
                    )),
                    Ok(_) => {}
                }
            }
        }
    }

    assert!(valid >= 5, "corpus must carry at least five valid releases, found {valid}");
    for runtime in ["raw-wasm", "wasm-bindgen", "flutter-web"] {
        assert!(runtimes.contains(runtime), "corpus lacks a valid {runtime} release");
    }
    report(failures);
}

#[test]
fn schema_cases_are_rejected_by_the_schema_layer() {
    let mut failures = Vec::new();
    for case in corpus().into_iter().filter(|c| c.expect == "schema") {
        match parse_release(case.release.clone(), &policy(&case)) {
            Ok(_) => failures.push(format!(
                "{}: expected a JSON Schema rejection, but it parsed ({})",
                case.name, case.reason
            )),
            Err(Error::Manifest(m)) if m.contains(SCHEMA_REJECTION) => {}
            Err(e) => failures.push(format!(
                "{}: expected a JSON Schema rejection, got {e} ({})",
                case.name, case.reason
            )),
        }
    }
    report(failures);
}

#[test]
fn host_cases_pass_the_schema_and_fail_a_host_invariant() {
    let mut failures = Vec::new();
    let mut seen = 0usize;
    for case in corpus().into_iter().filter(|c| c.expect == "host") {
        seen += 1;
        match parse_release(case.release.clone(), &policy(&case)) {
            Ok(_) => failures.push(format!(
                "{}: expected a host-invariant rejection, but it parsed ({})",
                case.name, case.reason
            )),
            Err(Error::Manifest(m)) if m.contains(SCHEMA_REJECTION) => failures.push(format!(
                "{}: rejected by the schema layer, so it is mislabelled expect=host ({})",
                case.name, case.reason
            )),
            Err(Error::Manifest(m)) => {
                if let Some(code) = &case.code {
                    if !case.deviates() && !accepts_code(code, &m) {
                        failures.push(format!(
                            "{}: expected the '{code}' host invariant, got \"{m}\" ({})",
                            case.name, case.reason
                        ));
                    }
                }
            }
            Err(e) => failures.push(format!(
                "{}: expected Error::Manifest from the host layer, got {e} ({})",
                case.name, case.reason
            )),
        }
    }
    assert!(seen > 0, "corpus carries no host-invariant cases");
    report(failures);
}

#[test]
fn a_zero_budget_policy_is_refused_before_any_parsing() {
    let case = corpus()
        .into_iter()
        .find(|c| c.expect == "valid")
        .expect("a valid case");
    let mut broken = policy(&case);
    broken.max_asset_bytes = 0;
    assert!(matches!(
        parse_release(case.release, &broken),
        Err(Error::Budget)
    ));
}
