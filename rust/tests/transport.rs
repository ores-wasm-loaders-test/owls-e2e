//! An organization supplies its own `Transport` and `ByteStore` and drives the
//! stock `owls_runtime::Host` with them. Nothing here forks or wraps coordinator
//! internals; only the two published traits are implemented.

use owls_e2e_consumer::{digest, GOOD_WASM};
use owls_runtime::{Asset, ByteStore, Error, Host, Policy, Result, Transport};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const ORIGIN: &str = "https://assets.example";
const URL: &str = "https://assets.example/engine.wasm";
const ATLAS_URL: &str = "https://assets.example/atlas.bin";
const ATLAS: [u8; 4] = [0xde, 0xad, 0xbe, 0xef];

fn manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "appId": "acme-consumer",
        "release": "2026.09.05-e2e",
        "runtime": "raw-wasm",
        "entrypoint": "engine",
        "assets": [
            {"id": "engine", "url": URL, "kind": "wasm",
             "bytes": GOOD_WASM.len(), "sha256": digest(&GOOD_WASM), "prepare": true},
            {"id": "atlas", "url": ATLAS_URL, "kind": "data",
             "bytes": ATLAS.len(), "sha256": digest(&ATLAS), "prepare": true}
        ]
    })
}

fn policy() -> Policy {
    Policy::new(vec![ORIGIN.to_owned()])
}

/// The organization's CDN client: a private object map, its own accounting, and
/// cooperative cancellation through the caller's `AtomicBool`.
#[derive(Clone)]
struct OrgTransport {
    objects: Arc<BTreeMap<String, Vec<u8>>>,
    calls: Arc<AtomicUsize>,
    observed_cancel: Arc<AtomicUsize>,
    /// After this many successful reads the organization's own deadline fires
    /// and flips the shared cancellation flag.
    trip_after: Option<usize>,
    trip: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    /// Serve these bytes instead of the real object, to model a corrupted CDN.
    poison: Option<Vec<u8>>,
}

impl OrgTransport {
    fn new(objects: &[(&str, &[u8])]) -> Self {
        Self {
            objects: Arc::new(
                objects
                    .iter()
                    .map(|(url, bytes)| ((*url).to_owned(), bytes.to_vec()))
                    .collect(),
            ),
            calls: Arc::new(AtomicUsize::new(0)),
            observed_cancel: Arc::new(AtomicUsize::new(0)),
            trip_after: None,
            trip: Arc::new(Mutex::new(None)),
            poison: None,
        }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }
    fn observed_cancel(&self) -> usize {
        self.observed_cancel.load(Ordering::Relaxed)
    }
}

impl Transport for OrgTransport {
    fn fetch(&self, asset: &Asset, cancelled: &AtomicBool) -> Result<Vec<u8>> {
        let served = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        if self.trip_after == Some(served) {
            if let Some(flag) = self.trip.lock().expect("trip lock").as_ref() {
                flag.store(true, Ordering::Relaxed);
            }
        }
        if cancelled.load(Ordering::Relaxed) {
            self.observed_cancel.fetch_add(1, Ordering::Relaxed);
            return Err(Error::Cancelled);
        }
        match &self.poison {
            Some(poison) => Ok(poison.clone()),
            None => self
                .objects
                .get(&asset.url)
                .cloned()
                .ok_or_else(|| Error::Manifest(format!("no such object: {}", asset.url))),
        }
    }
}

/// The organization's cache. `owls_runtime::ByteStore` is get/put only; a bad
/// entry is corrected by the overwrite that follows the refetch.
#[derive(Clone, Default)]
struct OrgStore {
    entries: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    gets: Arc<AtomicUsize>,
    puts: Arc<AtomicUsize>,
}

impl OrgStore {
    fn seed(&self, key: &str, bytes: &[u8]) {
        self.entries
            .lock()
            .expect("store lock")
            .insert(key.to_owned(), bytes.to_vec());
    }
    fn peek(&self, key: &str) -> Option<Vec<u8>> {
        self.entries.lock().expect("store lock").get(key).cloned()
    }
    fn puts(&self) -> usize {
        self.puts.load(Ordering::Relaxed)
    }
    fn gets(&self) -> usize {
        self.gets.load(Ordering::Relaxed)
    }
}

impl ByteStore for OrgStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.gets.fetch_add(1, Ordering::Relaxed);
        Ok(self.entries.lock().expect("store lock").get(key).cloned())
    }
    fn put(&mut self, key: &str, bytes: &[u8]) -> Result<()> {
        self.puts.fetch_add(1, Ordering::Relaxed);
        self.entries
            .lock()
            .expect("store lock")
            .insert(key.to_owned(), bytes.to_vec());
        Ok(())
    }
}

fn host(transport: OrgTransport, store: OrgStore) -> Host<OrgTransport, OrgStore> {
    Host::new(manifest(), policy(), transport, store).expect("manifest is valid")
}

#[test]
fn an_organization_transport_and_store_drive_the_stock_host() {
    let transport = OrgTransport::new(&[(URL, &GOOD_WASM), (ATLAS_URL, &ATLAS)]);
    let store = OrgStore::default();
    let mut host = host(transport.clone(), store.clone());
    let cancelled = AtomicBool::new(false);

    host.prefetch(&cancelled).expect("prefetch succeeds");
    assert_eq!(transport.calls(), 2, "both prepared assets were fetched once");
    assert_eq!(store.puts(), 2, "verified bytes were handed to the organization cache");

    // Verified bytes are reused; the store is keyed by digest, not by URL.
    let bytes = host.bytes("engine", &cancelled).expect("cached bytes");
    assert_eq!(bytes, GOOD_WASM.to_vec());
    assert_eq!(transport.calls(), 2, "no refetch for an already verified asset");
    assert!(store.gets() > 0);
    assert_eq!(store.peek(&digest(&GOOD_WASM)), Some(GOOD_WASM.to_vec()));
}

#[test]
fn a_flag_set_before_preparation_stops_the_host_without_touching_the_network() {
    let transport = OrgTransport::new(&[(URL, &GOOD_WASM), (ATLAS_URL, &ATLAS)]);
    let mut host = host(transport.clone(), OrgStore::default());
    let cancelled = AtomicBool::new(true);

    assert!(matches!(host.prefetch(&cancelled), Err(Error::Cancelled)));
    assert_eq!(transport.calls(), 0, "an already-cancelled prefetch must not reach the transport");
}

#[test]
fn the_organization_transport_observes_cancellation_mid_preparation() {
    let flag = Arc::new(AtomicBool::new(false));
    let mut transport = OrgTransport::new(&[(URL, &GOOD_WASM), (ATLAS_URL, &ATLAS)]);
    transport.trip_after = Some(1);
    *transport.trip.lock().expect("trip lock") = Some(flag.clone());

    let store = OrgStore::default();
    let mut host = host(transport.clone(), store.clone());

    // The organization's own deadline fires inside the first fetch: it flips the
    // shared flag, sees it, and reports Cancelled rather than returning bytes.
    let err = host.prefetch(&flag).expect_err("preparation is cancelled");
    assert!(matches!(err, Error::Cancelled), "got {err}");
    assert_eq!(transport.calls(), 1, "the second asset was never requested");
    assert_eq!(transport.observed_cancel(), 1, "the transport acted on the flag itself");
    assert!(flag.load(Ordering::Relaxed));
    assert_eq!(store.puts(), 0, "a cancelled fetch caches nothing");

    // Cancellation is not corruption: clearing the flag resumes cleanly.
    flag.store(false, Ordering::Relaxed);
    host.prefetch(&flag).expect("preparation resumes");
    assert_eq!(transport.calls(), 3, "both assets were served on the retry");
    assert_eq!(store.puts(), 2);
}

#[test]
fn a_corrupted_cache_entry_is_ignored_and_the_asset_is_refetched() {
    let transport = OrgTransport::new(&[(URL, &GOOD_WASM), (ATLAS_URL, &ATLAS)]);
    let store = OrgStore::default();
    // The organization's cache is content-addressed by digest; poison that slot.
    store.seed(&digest(&GOOD_WASM), b"not the engine");
    let mut host = host(transport.clone(), store.clone());
    let cancelled = AtomicBool::new(false);

    let bytes = host.bytes("engine", &cancelled).expect("bad cache entry is survivable");
    assert_eq!(bytes, GOOD_WASM.to_vec());
    assert_eq!(transport.calls(), 1, "the asset was refetched");
    assert_eq!(
        store.peek(&digest(&GOOD_WASM)),
        Some(GOOD_WASM.to_vec()),
        "the good bytes replaced the corrupted entry"
    );
}

#[test]
fn a_corrupted_transport_response_fails_integrity_and_never_reaches_the_cache() {
    let mut transport = OrgTransport::new(&[(URL, &GOOD_WASM)]);
    transport.poison = Some(vec![0x00, 0x61, 0x73, 0x6d, 0xff, 0xff, 0xff, 0xff]);
    let store = OrgStore::default();
    let mut host = host(transport.clone(), store.clone());
    let cancelled = AtomicBool::new(false);

    let err = host.bytes("engine", &cancelled).expect_err("integrity must fail");
    assert!(matches!(err, Error::Integrity), "got {err}");
    assert_eq!(store.puts(), 0, "unverified bytes must never be cached");
}

#[test]
fn a_short_response_of_the_right_shape_still_fails_integrity() {
    let mut transport = OrgTransport::new(&[(URL, &GOOD_WASM)]);
    transport.poison = Some(GOOD_WASM[..4].to_vec());
    let mut host = host(transport, OrgStore::default());
    assert!(matches!(
        host.bytes("engine", &AtomicBool::new(false)),
        Err(Error::Integrity)
    ));
}

#[test]
fn unknown_assets_and_oversized_assets_are_refused_before_any_fetch() {
    let transport = OrgTransport::new(&[(URL, &GOOD_WASM)]);
    let mut host = host(transport.clone(), OrgStore::default());
    let cancelled = AtomicBool::new(false);
    assert!(matches!(host.bytes("nope", &cancelled), Err(Error::Asset)));

    let mut tight = policy();
    tight.max_asset_bytes = 4;
    let mut strict = Host::new(manifest(), tight, transport.clone(), OrgStore::default())
        .expect("manifest is valid");
    assert!(matches!(strict.bytes("engine", &cancelled), Err(Error::Budget)));

    let mut tiny = policy();
    tiny.max_prepare_bytes = 4;
    let mut budgeted = Host::new(manifest(), tiny, transport.clone(), OrgStore::default())
        .expect("manifest is valid");
    assert!(matches!(budgeted.prefetch(&cancelled), Err(Error::Budget)));
    assert_eq!(transport.calls(), 0, "budget checks run before the network does");
}

#[test]
fn the_host_exposes_the_parsed_release_it_was_built_from() {
    let host = host(OrgTransport::new(&[]), OrgStore::default());
    let release = host.release();
    assert_eq!(release.app_id, "acme-consumer");
    assert_eq!(release.entrypoint, "engine");
    assert_eq!(release.assets.len(), 2);
    assert_eq!(release.assets[0].sha256, digest(&GOOD_WASM));
}
