import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/contract-ir-admission.yml', import.meta.url);
const declarations = Object.freeze([
  'Ores.WasmLoaders.Activation',
  'Ores.WasmLoaders.ActivationMode',
  'Ores.WasmLoaders.ApplicationId',
  'Ores.WasmLoaders.Asset',
  'Ores.WasmLoaders.AssetId',
  'Ores.WasmLoaders.AssetKind',
  'Ores.WasmLoaders.AssetRole',
  'Ores.WasmLoaders.AssetStage',
  'Ores.WasmLoaders.EntrypointId',
  'Ores.WasmLoaders.FrameworkKind',
  'Ores.WasmLoaders.HostSelector',
  'Ores.WasmLoaders.HttpsAssetUrl',
  'Ores.WasmLoaders.IslandName',
  'Ores.WasmLoaders.PrepareBudget',
  'Ores.WasmLoaders.PrepareStage',
  'Ores.WasmLoaders.RecordString',
  'Ores.WasmLoaders.RecordUnknown',
  'Ores.WasmLoaders.Release',
  'Ores.WasmLoaders.ReleaseId',
  'Ores.WasmLoaders.RuntimeKind',
  'Ores.WasmLoaders.SchemaVersion',
  'Ores.WasmLoaders.Sha256Hex',
  'Ores.WasmLoaders.ToolchainId',
]);

const exactRef = (workflow, name) => {
  const value = workflow.match(new RegExp(`^\\s*${name}:\\s*([0-9a-f]{40})\\s*$`, 'm'))?.[1];
  assert.ok(value, `${name} must be immutable`);
  return value;
};

test('external admission uses one exact TJSV revision and complete peer-authority scope', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const interfaceRef = exactRef(workflow, 'OWLS_INTERFACES_REF');
  const validatorRef = exactRef(workflow, 'TSJSV_REF');

  assert.notEqual(interfaceRef, validatorRef);
  assert.match(workflow, /repository:\s*ores-wasm-loaders\/owls-interfaces[\s\S]{0,180}?ref:\s*\$\{\{ env\.OWLS_INTERFACES_REF \}\}/);
  assert.match(workflow, /repository:\s*ORESoftware\/typespec-json-schema-validator[\s\S]{0,180}?ref:\s*\$\{\{ env\.TSJSV_REF \}\}/);
  const actionRef = workflow.match(/actions\/verify-contract-ir@([0-9a-f]{40})/)?.[1];
  assert.equal(actionRef, validatorRef, 'canonical consumer action must match the audited TJSV checkout');
  assert.match(workflow, /--instances=\.contract-ir-evidence\/instances/);
  assert.match(workflow, /subject\/owls-interfaces\/fixtures\/valid\/\*\.json/);
  assert.match(workflow, /tjsv-consumer-verification\.json/);
  for (const declaration of declarations) {
    assert.ok(workflow.includes(`"${declaration}"`), `missing downstream admission scope: ${declaration}`);
  }
  assert.doesNotMatch(workflow, /typespec-json-schema-validator(?:\/actions\/verify-contract-ir)?@(?:main|master|v\d+)/);
  assert.doesNotMatch(workflow, /ref:\s*(?:main|master)\s*$/m);
});
