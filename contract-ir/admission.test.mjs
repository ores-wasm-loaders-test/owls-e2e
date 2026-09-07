import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

const rootUrl = new URL('../', import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const evidenceUrl = new URL('.contract-ir-evidence/', rootUrl);
const validator = await import(
  new URL('subject/typespec-json-schema-validator/src/index.mjs', rootUrl).href,
);

const readJson = async (relativeUrl) => JSON.parse(await readFile(new URL(relativeUrl, rootUrl), 'utf8'));
const report = await readJson('.contract-ir-evidence/report.json');
const contractIr = await readJson('.contract-ir-evidence/contract-ir.json');
const typespec = fileURLToPath(new URL('subject/owls-interfaces/contracts/main.tsp', rootUrl));
const authoredSchema = fileURLToPath(
  new URL('subject/owls-interfaces/schemas/release.schema.json', rootUrl),
);
const recordedGeneratedSchema = report?.inputs?.generatedJsonSchema?.input;
const generatedSchema = isAbsolute(recordedGeneratedSchema)
  ? recordedGeneratedSchema
  : resolve(rootPath, recordedGeneratedSchema);

const verify = ({
  suppliedIr = contractIr,
  suppliedReport = report,
  suppliedAuthoredSchema = authoredSchema,
} = {}) => validator.verifyContractIr({
  contractIr: suppliedIr,
  report: suppliedReport,
  typespec,
  generatedSchema,
  authoredSchema: suppliedAuthoredSchema,
});

test('an outside consumer admits the exact producer artifact', async () => {
  const verification = await verify();
  assert.equal(verification.schema, validator.CONTRACT_IR_VERIFICATION_SCHEMA);
  assert.equal(verification.status, 'passed');
  assert.equal(verification.admissible, true);
  assert.equal(verification.suppliedIrId, contractIr.irId);
  assert.equal(verification.computedIrId, contractIr.irId);
  assert.equal(verification.expectedIrId, contractIr.irId);
  assert.equal(contractIr.admission.receipt.runId, report.runId);
  assert.equal(contractIr.admission.receipt.zeroUnexplainedFindings, true);

  const admitted = new Set(
    contractIr.declarations.map((declaration) => declaration.names.authoredJsonSchema),
  );
  for (const name of ['Release', 'Asset', 'PrepareBudget', 'Activation']) {
    assert.ok(admitted.has(name), `missing admitted WASM declaration: ${name}`);
  }

  await writeFile(
    new URL('verification.json', evidenceUrl),
    `${JSON.stringify(verification, null, 2)}\n`,
  );
});

test('tampering with the Contract IR invalidates its self digest', async () => {
  const tampered = structuredClone(contractIr);
  tampered.role = 'editable-third-authority';
  const verification = await verify({ suppliedIr: tampered });
  assert.equal(verification.status, 'failed');
  assert.equal(verification.admissible, false);
  assert.equal(verification.suppliedIrId, contractIr.irId);
  assert.notEqual(verification.computedIrId, verification.suppliedIrId);
  assert.equal(verification.expectedIrId, contractIr.irId);
});

test('changing the parity receipt invalidates the receipt-bound IR', async () => {
  const changedReport = structuredClone(report);
  changedReport.configuration = {
    ...(changedReport.configuration ?? {}),
    downstreamConsumerTamperProbe: true,
  };
  const verification = await verify({ suppliedReport: changedReport });
  assert.equal(verification.status, 'failed');
  assert.equal(verification.admissible, false);
  assert.equal(verification.suppliedIrId, contractIr.irId);
  assert.equal(verification.computedIrId, contractIr.irId);
  assert.notEqual(verification.expectedIrId, contractIr.irId);
});

test('changing an authored authority after emission is rejected', async () => {
  const changedSchema = await readJson(
    'subject/owls-interfaces/schemas/release.schema.json',
  );
  changedSchema.$comment = 'intentional downstream stale-input probe';
  const changedPathUrl = new URL('authored.changed.schema.json', evidenceUrl);
  await writeFile(changedPathUrl, `${JSON.stringify(changedSchema, null, 2)}\n`);

  const verification = await verify({
    suppliedAuthoredSchema: fileURLToPath(changedPathUrl),
  });
  assert.equal(verification.status, 'failed');
  assert.equal(verification.admissible, false);
  assert.match(verification.error ?? '', /digest no longer matches the receipt/);
});

test('a stopped parity receipt produces a non-admissible tombstone', async () => {
  const stoppedReport = structuredClone(report);
  stoppedReport.status = 'stopped_for_evaluation';
  stoppedReport.zeroUnexplainedFindings = false;
  const tombstone = validator.buildContractIrTombstone(
    stoppedReport,
    'downstream-e2e-intentional-stop',
  );
  assert.equal(tombstone.admissible, false);
  assert.equal(tombstone.editableAuthority, false);

  const verification = await verify({
    suppliedIr: tombstone,
    suppliedReport: stoppedReport,
  });
  assert.equal(verification.status, 'failed');
  assert.equal(verification.admissible, false);
});

test('every admitted declaration retains both authority lanes and a digest', () => {
  assert.ok(contractIr.declarations.length > 0);
  for (const declaration of contractIr.declarations) {
    assert.equal(
      declaration.lanes.typespecGeneratedJsonSchema.role,
      'comparison-evidence-only',
      `${declaration.id}: Schema B role drifted`,
    );
    assert.equal(
      declaration.lanes.authoredJsonSchema.role,
      'independently-authored-authority',
      `${declaration.id}: authored JSON Schema role drifted`,
    );
    assert.match(declaration.assertionDigest, /^[a-f0-9]{64}$/u);
  }
  assert.equal(contractIr.authorities.typespec, 'independently-authored');
  assert.equal(contractIr.authorities.jsonSchema, 'independently-authored');
  assert.equal(contractIr.authorities.generatedJsonSchema, 'comparison-evidence-only');
  assert.equal(contractIr.authorities.precedence, 'none');
});
