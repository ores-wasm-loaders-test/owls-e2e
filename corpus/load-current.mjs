import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const EXPECTATIONS = new Set(['valid', 'schema', 'host']);
const OVERRIDE_SCHEMA = 'ores-wasm-loaders-test.release-corpus-overrides/v2';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobId(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requireReason(override) {
  if (typeof override.reason !== 'string' || override.reason.trim().length < 24) {
    throw new Error(`${override.case}: evolution reason is missing or too short`);
  }
}

export function loadCurrentCorpus() {
  const corpusBytes = readFileSync(new URL('./release-corpus.json', import.meta.url));
  const overrideBytes = readFileSync(new URL('./expectation-overrides.v2.json', import.meta.url));
  const source = JSON.parse(corpusBytes.toString('utf8'));
  const policy = JSON.parse(overrideBytes.toString('utf8'));

  if (source.schemaVersion !== 1 || !Array.isArray(source.cases)) {
    throw new Error('release corpus must be a schemaVersion 1 object with a cases array');
  }
  if (source.cases.length !== 54) {
    throw new Error(`release corpus size changed: expected 54, saw ${source.cases.length}`);
  }
  if (policy.schema !== OVERRIDE_SCHEMA || policy.targetContract !== 'owls-release-v2') {
    throw new Error('unsupported release corpus evolution policy');
  }
  if (gitBlobId(corpusBytes) !== policy.sourceGitBlob) {
    throw new Error('release corpus source blob no longer matches the reviewed evolution policy');
  }
  if (!Array.isArray(policy.expectationOverrides) || !Array.isArray(policy.codeOverrides)) {
    throw new Error('release corpus evolution policy must contain expectationOverrides and codeOverrides arrays');
  }

  const cases = new Map();
  for (const item of source.cases) {
    if (!item || typeof item.name !== 'string' || item.name.length === 0) {
      throw new Error('every release corpus case must have a name');
    }
    if (cases.has(item.name)) throw new Error(`duplicate release corpus case ${item.name}`);
    if (!EXPECTATIONS.has(item.expect)) throw new Error(`${item.name}: unknown expectation ${item.expect}`);
    cases.set(item.name, structuredClone(item));
  }

  const expectationChanged = new Set();
  for (const override of policy.expectationOverrides) {
    if (!override || typeof override.case !== 'string' || expectationChanged.has(override.case)) {
      throw new Error('expectation overrides must have unique case names');
    }
    const item = cases.get(override.case);
    if (!item) throw new Error(`expectation override names unknown case ${override.case}`);
    if (!EXPECTATIONS.has(override.from) || !EXPECTATIONS.has(override.to)) {
      throw new Error(`${override.case}: invalid expectation transition`);
    }
    if (item.expect !== override.from) {
      throw new Error(`${override.case}: expected historical ${override.from}, saw ${item.expect}`);
    }
    if (override.from === override.to) throw new Error(`${override.case}: no-op expectation override is forbidden`);
    requireReason(override);
    item.historicalExpectation = item.expect;
    item.expect = override.to;
    item.evolutionReason = override.reason;
    expectationChanged.add(override.case);
  }

  const codeChanged = new Set();
  for (const override of policy.codeOverrides) {
    if (!override || typeof override.case !== 'string' || codeChanged.has(override.case)) {
      throw new Error('code overrides must have unique case names');
    }
    const item = cases.get(override.case);
    if (!item) throw new Error(`code override names unknown case ${override.case}`);
    if (item.expect !== 'host') {
      throw new Error(`${override.case}: only host-negative cases may change host error taxonomy`);
    }
    if (typeof override.from !== 'string' || typeof override.to !== 'string' ||
        override.from.length === 0 || override.to.length === 0) {
      throw new Error(`${override.case}: invalid host error-code transition`);
    }
    if (item.code !== override.from) {
      throw new Error(`${override.case}: expected historical code ${override.from}, saw ${item.code ?? 'none'}`);
    }
    if (override.from === override.to) throw new Error(`${override.case}: no-op code override is forbidden`);
    requireReason(override);
    item.historicalCode = item.code;
    item.code = override.to;
    item.codeEvolutionReason = override.reason;
    codeChanged.add(override.case);
  }

  const evolvedCases = source.cases.map((item) => cases.get(item.name));
  const counts = evolvedCases.reduce(
    (result, item) => ({ ...result, [item.expect]: result[item.expect] + 1 }),
    { valid: 0, schema: 0, host: 0 },
  );
  const corpus = deepFreeze({ ...source, targetContract: policy.targetContract, cases: evolvedCases });
  const receipt = deepFreeze({
    schema: 'ores-wasm-loaders-test.release-corpus-receipt/v2',
    status: 'passed',
    targetContract: policy.targetContract,
    sourceGitBlob: policy.sourceGitBlob,
    sourceSha256: sha256(corpusBytes),
    overrideSha256: sha256(overrideBytes),
    cases: evolvedCases.length,
    expectationOverrides: expectationChanged.size,
    codeOverrides: codeChanged.size,
    overrides: expectationChanged.size + codeChanged.size,
    counts,
  });

  return Object.freeze({ corpus, receipt });
}
