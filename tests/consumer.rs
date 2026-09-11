use owls_runtime::{parse_release,Policy,Transport,Asset,Result,Host,MemoryStore,NativeRuntime};
use std::sync::atomic::AtomicBool;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
#[test]
fn published_contract_corpus() {
    let cases:Vec<Value>=serde_json::from_str(include_str!("../fixtures/contracts/cases.json")).unwrap();
    for case in cases {
      assert_eq!(parse_release(case["manifest"].clone(),&Policy::new(vec!["https://assets.example".into()])).is_ok(),
        case["valid"].as_bool().unwrap(),"{}",case["name"]);
    }
}
struct TenantTransport;
impl Transport for TenantTransport {
    fn fetch(&self,_:&Asset,_:&AtomicBool)->Result<Vec<u8>> {Ok(vec![0,97,115,109,1,0,0,0])}
}
#[test]
fn external_org_overrides_transport_without_forking_loader() {
    let bytes=[0,97,115,109,1,0,0,0];
    let manifest=json!({"schemaVersion":1,"appId":"tenant-b","release":"r1","runtime":"raw-wasm","entrypoint":"main","assets":[{
      "id":"main","url":"https://assets.example/main.wasm","kind":"wasm","bytes":8,
      "sha256":format!("{:x}",Sha256::digest(bytes)),"prepare":true}]});
    let mut host=Host::new(manifest,Policy::new(vec!["https://assets.example".into()]),TenantTransport,MemoryStore::new(1000)).unwrap();
    let cancelled=AtomicBool::new(false);host.prefetch(&cancelled).unwrap();
    NativeRuntime::new(65536,1000).unwrap().instantiate(&mut host,&cancelled,|_|Ok(())).unwrap();
}

