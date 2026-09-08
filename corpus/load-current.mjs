import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const EXPECTATIONS = new Set(['valid', 'schema', 'host']);
const OVERRIDE_SCHEMA = 'ores-wasm-loaders-test.release-corpus-overrides/v1';

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
  if (!Array.isArray(policy.overrides)) {
    throw new Error('release corpus evolution policy must contain an overrides array');
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

  const changed = new Set();
  for (const override of policy.overrides) {
    if (!override || typeof override.case !== 'string' || changed.has(override.case)) {
      throw new Error('release corpus overrides must have unique case names');
    }
    const item = cases.get(override.case);
    if (!item) throw new Error(`release corpus override names unknown case ${override.case}`);
    if (!EXPECTATIONS.has(override.from) || !EXPECTATIONS.has(override.to)) {
      throw new Error(`${override.case}: invalid expectation transition`);
    }
    if (item.expect !== override.from) {
      throw new Error(`${override.case}: expected historical ${override.from}, saw ${item.expect}`);
    }
    if (override.from === override.to) throw new Error(`${override.case}: no-op override is forbidden`);
    if (typeof override.reason !== 'string' || override.reason.trim().length < 24) {
      throw new Error(`${override.case}: evolution reason is missing or too short`);
    }
    item.historicalExpectation = item.expect;
    item.expect = override.to;
    item.evolutionReason = override.reason;
    changed.add(override.case);
  }

  const evolvedCases = source.cases.map((item) => cases.get(item.name));
  const counts = evolvedCases.reduce(
    (result, item) => ({ ...result, [item.expect]: result[item.expect] + 1 }),
    { valid: 0, schema: 0, host: 0 },
  );
  const corpus = deepFreeze({ ...source, targetContract: policy.targetContract, cases: evolvedCases });
  const receipt = deepFreeze({
    schema: 'ores-wasm-loaders-test.release-corpus-receipt/v1',
    status: 'passed',
    targetContract: policy.targetContract,
    sourceGitBlob: policy.sourceGitBlob,
    sourceSha256: sha256(corpusBytes),
    overrideSha256: sha256(overrideBytes),
    cases: evolvedCases.length,
    overrides: changed.size,
    counts,
  });

  return Object.freeze({ corpus, receipt });
}
