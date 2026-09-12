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

test('TypeSpec and authored Draft 2020-12 JSON Schema stay first-class peers and Schema B stays generated evidence', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  const authoredTypeSpec = 'subject/owls-interfaces/contracts/main.tsp';
  const authoredSchemaA = 'subject/owls-interfaces/schemas/release.schema.json';
  const generatedSchemaB = '.contract-ir-evidence/generated/typespec.generated.schema.json';

  assert.match(
    workflow,
    /--typespec=subject\/owls-interfaces\/contracts\/main\.tsp/,
    'TJSV must receive the authored TypeSpec authority directly',
  );
  assert.match(
    workflow,
    /--schema=subject\/owls-interfaces\/schemas\/release\.schema\.json/,
    'TJSV must receive the independently authored JSON Schema A directly',
  );
  assert.match(
    workflow,
    /--output-dir=\.contract-ir-evidence\/generated/,
    'TypeSpec emission must land in a generated evidence directory',
  );
  assert.ok(
    workflow.includes(`generated_schema: ${generatedSchemaB}`),
    'canonical verification must bind generated comparison Schema B',
  );
  assert.ok(workflow.includes(`typespec: ${authoredTypeSpec}`));
  assert.ok(workflow.includes(`schema: ${authoredSchemaA}`));
  assert.match(workflow, /--report=\.contract-ir-evidence\/report\.json/);
  assert.match(workflow, /--contract-ir=\.contract-ir-evidence\/contract-ir\.json/);
  assert.match(workflow, /--instances=\.contract-ir-evidence\/instances/);

  const sourceArchiveBlock = workflow.match(/tar -czf \.contract-ir-evidence\/source\.tar\.gz([\s\S]*?)sha256sum \.contract-ir-evidence\/source\.tar\.gz/)?.[1] ?? '';
  assert.ok(sourceArchiveBlock.includes(authoredTypeSpec), 'evidence archive must retain the authored TypeSpec input');
  assert.ok(sourceArchiveBlock.includes(authoredSchemaA), 'evidence archive must retain the authored JSON Schema A input');
  assert.ok(
    !sourceArchiveBlock.includes(generatedSchemaB),
    'generated Schema B is reproducible comparison evidence, not an authored source authority',
  );

  assert.notEqual(authoredTypeSpec, authoredSchemaA);
  assert.notEqual(authoredSchemaA, generatedSchemaB);
  assert.doesNotMatch(
    workflow,
    /--schema=\.contract-ir-evidence\/generated\/typespec\.generated\.schema\.json/,
    'generated Schema B must never replace authored JSON Schema A as the schema authority input',
  );
});
