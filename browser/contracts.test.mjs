import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseRelease} from "../zed_modules/ores-wasm-loaders/owls-web-loader/dist/index.js";
const cases=JSON.parse(readFileSync(new URL("../fixtures/contracts/cases.json",import.meta.url)));
for(const item of cases)test("shared contract: "+item.name,()=>{
  let accepted=false;try{parseRelease(item.manifest,["https://assets.example"]);accepted=true;}catch{}
  assert.equal(accepted,item.valid);
});

