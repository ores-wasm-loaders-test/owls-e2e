use wasm_bindgen::prelude::*;
#[wasm_bindgen]
pub fn add(left:u32,right:u32)->u32 {left+right}
#[wasm_bindgen]
pub fn hydrate_islands()->String {"owls-hydrated".into()}

