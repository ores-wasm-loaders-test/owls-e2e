import owls_loader.{
  Asset, RawWasm, Release, Wasm, preparable_assets, validate_release,
}

pub fn main() {
  let release =
    Release(
      schema_version: 1,
      app_id: "gleam-consumer",
      release: "2026.09.06",
      runtime: RawWasm,
      entrypoint: "engine",
      assets: [
        Asset(
          id: "engine",
          url: "https://assets.example/engine.wasm",
          kind: Wasm,
          bytes: 8,
          sha256: "93a44bbb96c751218e4c00d479010ce4c7e22d0fe8c71ac08fb6a39ccca33e24",
          prepare: True,
        ),
      ],
    )

  case validate_release(release) {
    Error(message) -> panic as message
    Ok(valid) ->
      case preparable_assets(valid) {
        [asset] ->
          case asset.id == "engine" && asset.bytes == 8 {
            True -> Nil
            False -> panic as "Gleam preparation projection changed the asset"
          }
        _ -> panic as "Gleam preparation projection selected the wrong assets"
      }
  }
}
