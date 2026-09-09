import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

function exactSha(value, name) {
  assert.match(value, /^[0-9a-f]{40}$/, `${name} must be a full immutable commit SHA`);
  return value;
}

function declaredRef(workflow, name) {
  const match = workflow.match(new RegExp(`^\\s*${name}:\\s*([0-9a-f]{40})\\s*$`, 'm'));
  assert.ok(match, `${name} is missing from the E2E workflow`);
  return match[1];
}

function rejectsMutableValidatorRef(source, name) {
  assert.doesNotMatch(
    source,
    /repository:\s*ORESoftware\/typespec-json-schema-validator[\s\S]{0,240}?ref:\s*(?:main|master|v\d+)/,
    `${name} uses a mutable validator ref`,
  );
}

test('the committed source closure preserves peer-authority semantics', async () => {
  const closure = JSON.parse(await read('contract-ir/source-closure.json'));
  assert.equal(closure.schema, 'ores-wasm-loaders.source-closure/v1');
  assert.equal(closure.issue, 'DEN-3828');
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

test('E2E and every loader host use the reviewed exact validator closure', async () => {
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

  const workflows = {
    interfaces: await read('subject/owls-interfaces/.github/workflows/contract.yml'),
    webLoader: await read('subject/owls-web-loader/.github/workflows/contract-ir-consumer.yml'),
    nativeLoader: await read('subject/owls-runtime/.github/workflows/native-contract.yml'),
    flutterLoader: await read('subject/owls-flutter/.github/workflows/flutter-package.yml'),
  };

  for (const [name, workflow] of Object.entries(workflows)) {
    assert.match(workflow, /ORESoftware\/typespec-json-schema-validator/);
    assert.ok(
      workflow.includes(closure.components.validator),
      `${name} does not pin the reviewed validator commit`,
    );
    assert.ok(
      /typespec-json-schema-validator\.mjs check/.test(workflow) ||
        /uses:\s*ORESoftware\/typespec-json-schema-validator@[0-9a-f]{40}/.test(workflow),
      `${name} does not execute the shared validator`,
    );
    assert.match(workflow, /verify-contract-ir\.mjs/);
    assert.match(workflow, /check-language-projections\.mjs/);
    rejectsMutableValidatorRef(workflow, name);
  }

  assert.ok(workflows.interfaces.includes(closure.components.validator));
  assert.ok(workflows.webLoader.includes(closure.components.interfaces));
  assert.ok(workflows.nativeLoader.includes(closure.components.interfaces));
});
