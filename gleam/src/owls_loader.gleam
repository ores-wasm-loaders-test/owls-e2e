pub type Runtime {
  RawWasm
  WasmBindgen
  FlutterWeb
}

pub type AssetKind {
  Wasm
  Module
  Script
  Data
  Font
}

pub type Asset {
  Asset(
    id: String,
    url: String,
    kind: AssetKind,
    bytes: Int,
    sha256: String,
    prepare: Bool,
  )
}

pub type Release {
  Release(
    schema_version: Int,
    app_id: String,
    release: String,
    runtime: Runtime,
    entrypoint: String,
    assets: List(Asset),
  )
}

fn find_asset(assets: List(Asset), id: String) -> Result(Asset, Nil) {
  case assets {
    [] -> Error(Nil)
    [asset, ..rest] ->
      case asset.id == id {
        True -> Ok(asset)
        False -> find_asset(rest, id)
      }
  }
}

fn expected_entrypoint_kind(runtime: Runtime) -> AssetKind {
  case runtime {
    RawWasm -> Wasm
    WasmBindgen -> Module
    FlutterWeb -> Script
  }
}

pub fn validate_release(release: Release) -> Result(Release, String) {
  case release.schema_version == 1 || release.schema_version == 2 {
    False -> Error("unsupported schema version")
    True ->
      case find_asset(release.assets, release.entrypoint) {
        Error(_) -> Error("entrypoint is not a declared asset")
        Ok(entrypoint) ->
          case entrypoint.kind == expected_entrypoint_kind(release.runtime) {
            True -> Ok(release)
            False -> Error("entrypoint kind does not match runtime")
          }
      }
  }
}

pub fn preparable_assets(release: Release) -> List(Asset) {
  preparable(release.assets, [])
}

fn preparable(assets: List(Asset), selected: List(Asset)) -> List(Asset) {
  case assets {
    [] -> reverse(selected, [])
    [asset, ..rest] ->
      case asset.prepare {
        True -> preparable(rest, [asset, ..selected])
        False -> preparable(rest, selected)
      }
  }
}

fn reverse(items: List(Asset), reversed: List(Asset)) -> List(Asset) {
  case items {
    [] -> reversed
    [item, ..rest] -> reverse(rest, [item, ..reversed])
  }
}
