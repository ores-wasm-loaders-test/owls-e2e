import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

function exactSha(value, name) {
  assert.match(value, /^[0-9a-f]{40}$/u, `${name} must be a full immutable commit SHA`);
  return value;
}

function declaredRef(workflow, name) {
  const match = workflow.match(new RegExp(`^\\s*${name}:\\s*([0-9a-f]{40})\\s*$`, 'm'));
  assert.ok(match, `${name} is missing from the workflow`);
  return match[1];
}

function rejectMutableValidatorRef(source, name) {
  assert.doesNotMatch(
    source,
    /repository:\s*ORESoftware\/typespec-json-schema-validator[\s\S]{0,260}?ref:\s*(?:main|master|v\d+)/,
    `${name} uses a mutable validator ref`,
  );
  assert.doesNotMatch(
    source,
    /typespec-json-schema-validator(?:\/actions\/verify-contract-ir)?@(?:main|master|v\d+)/,
    `${name} uses a mutable validator action ref`,
  );
}

function requireCanonicalAdmission(workflow, name, validatorRef) {
  assert.ok(
    workflow.includes(`ORESoftware/typespec-json-schema-validator/actions/verify-contract-ir@${validatorRef}`),
    `${name} does not run the canonical complete-scope TJSV consumer verifier`,
  );
  assert.match(workflow, /fixtures\/valid\/\*\.json/u, `${name} does not stage the admitted release corpus`);
  assert.match(workflow, /instances\/Release\/valid/u, `${name} does not retain Release/valid corpus semantics`);
  assert.match(
    workflow,
    /(?:tjsv-)?consumer-verification\.json/u,
    `${name} does not retain a canonical consumer receipt`,
  );
}

test('the salvaged source closure preserves peer-authority semantics and current immutable components', async () => {
  const closure = JSON.parse(await read('contract-ir/source-closure.json'));
  assert.equal(closure.schema, 'ores-wasm-loaders.source-closure/v2');
  assert.equal(closure.issue, 'DEN-3959');
  assert.equal(closure.salvagedFrom, 'ores-wasm-loaders-test/owls-e2e#7');
  assert.equal(closure.authorities.typespec, 'independently-authored-authority');
  assert.equal(closure.authorities.jsonSchemaA, 'independently-authored-authority');
  assert.equal(closure.authorities.precedence, 'none');
  assert.equal(closure.authorities.schemaB, 'comparison-evidence-only');
  assert.equal(closure.authorities.contractIr, 'derived-admission-evidence');

  const entries = Object.entries(closure.components);
  assert.deepEqual(
    entries.map(([name]) => name).sort(),
    ['flutterLoader', 'interfaces', 'nativeLoader', 'validator', 'webLoader'],
  );
  for (const [name, ref] of entries) exactSha(ref, name);
  assert.equal(new Set(entries.map(([, ref]) => ref)).size, entries.length);
});

test('E2E and all four contract hosts converge on the same reviewed TJSV and interface boundary', async () => {
  const closure = JSON.parse(await read('contract-ir/source-closure.json'));
  const e2e = await read('.github/workflows/contract-ir-admission.yml');

  const expectedEnv = {
    OWLS_INTERFACES_REF: closure.components.interfaces,
    TSJSV_REF: closure.components.validator,
    OWLS_WEB_LOADER_REF: closure.components.webLoader,
    OWLS_RUNTIME_REF: closure.components.nativeLoader,
    OWLS_FLUTTER_REF: closure.components.flutterLoader,
  };
  for (const [name, ref] of Object.entries(expectedEnv)) {
    assert.equal(declaredRef(e2e, name), ref, `${name} drifted from source-closure.json`);
  }

  const hosts = {
    interfaces: await read('subject/owls-interfaces/.github/workflows/contract.yml'),
    webLoader: await read('subject/owls-web-loader/.github/workflows/contract-ir-consumer.yml'),
    nativeLoader: await read('subject/owls-runtime/.github/workflows/native-contract.yml'),
    flutterLoader: await read('subject/owls-flutter/.github/workflows/flutter-package.yml'),
  };

  assert.equal(declaredRef(hosts.interfaces, 'TSJSV_REF'), closure.components.validator);
  assert.equal(declaredRef(hosts.webLoader, 'TSJSV_REF'), closure.components.validator);
  assert.equal(declaredRef(hosts.webLoader, 'OWLS_INTERFACES_REF'), closure.components.interfaces);
  assert.equal(declaredRef(hosts.nativeLoader, 'TSJSV_REF'), closure.components.validator);
  assert.equal(declaredRef(hosts.nativeLoader, 'OWLS_INTERFACES_REF'), closure.components.interfaces);
  assert.equal(declaredRef(hosts.flutterLoader, 'TSJSV_REF'), closure.components.validator);
  assert.equal(declaredRef(hosts.flutterLoader, 'CURRENT_INTERFACES_REF'), closure.components.interfaces);

  for (const [name, workflow] of Object.entries(hosts)) {
    assert.match(workflow, /ORESoftware\/typespec-json-schema-validator/u, `${name} does not name TJSV`);
    rejectMutableValidatorRef(workflow, name);
    requireCanonicalAdmission(workflow, name, closure.components.validator);
  }

  assert.match(hosts.interfaces, /node scripts\/verify-contract-ir\.mjs/u);
  assert.match(hosts.interfaces, /node scripts\/check-language-projections\.mjs/u);
  assert.match(hosts.webLoader, /node scripts\/verify-contract-ir-consumer\.mjs/u);
  assert.match(hosts.nativeLoader, /node scripts\/verify-contract-ir\.mjs/u);
  assert.match(hosts.flutterLoader, /node scripts\/verify-contract-ir\.mjs/u);
});
