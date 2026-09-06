import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCohort, variant, bindVariant, comparison } from './controls.mjs';

for (const [cohort, prepare, persistentShell] of [
  ['A', false, false], ['B', true, false], ['C', false, true], ['D', true, true],
]) {
  test(`cohort ${cohort} independently sets preparation and document persistence`, () => {
    assert.deepEqual(variant(cohort), { cohort, prepare, persistentShell, overridden: false });
    assert.ok(Object.isFrozen(variant(cohort)));
  });
}
test('allocation partitions all uint32 boundaries equally', () => {
  assert.deepEqual([0, 0x3fffffff, 0x40000000, 0x7fffffff, 0x80000000, 0xbfffffff, 0xc0000000, 0xffffffff].map(allocateCohort),
    ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D']);
});
test('allocation rejects identities, fractions and out-of-range values', () => {
  for (const value of ['user@example.test', -1, 1.5, 0x100000000, NaN, Infinity]) assert.throws(() => allocateCohort(value), TypeError);
});
test('invalid cohorts and nonboolean switches fail closed', () => {
  for (const cohort of ['toString', '__proto__', 'E', '']) assert.throws(() => variant(cohort), TypeError);
  assert.throws(() => variant('A', { disableShell: 'false' }), TypeError);
});
test('kill switch preserves assigned cohort and marks the observation overridden', () => {
  assert.deepEqual(variant('D', { disablePreparation: true, disableShell: true }),
    { cohort: 'D', prepare: false, persistentShell: false, overridden: true });
});
test('A/B never bind an activation callback or run application code during setup', () => {
  let starts = 0;
  for (const cohort of ['A', 'B']) {
    const binding = bindVariant(cohort, { connect: (_anchor, _coordinator, _key, options) => {
      assert.ok(!('start' in options)); assert.equal(options.prepare, cohort === 'B'); return () => {};
    }, start: () => { starts += 1; } });
    binding.dispose();
  }
  assert.equal(starts, 0);
});
test('C/D bind the supplied callback without invoking it and preserve disposal', () => {
  let starts = 0, disposals = 0; const start = () => { starts += 1; };
  for (const cohort of ['C', 'D']) {
    const binding = bindVariant(cohort, { start, connect: (_a, _c, _k, options) => {
      assert.equal(options.start, start); assert.equal(options.prepare, cohort === 'D'); return () => { disposals += 1; };
    } });
    binding.dispose();
  }
  assert.equal(starts, 0); assert.equal(disposals, 2);
});
test('shell kill switch leaves a normal link even without an activation callback', () => {
  const binding = bindVariant('D', { disableShell: true, connect: (_a, _c, _k, options) => {
    assert.ok(!('start' in options)); assert.equal(options.prepare, true); return () => {};
  } });
  assert.equal(binding.config.overridden, true);
});
test('missing runtime inputs fail instead of generating fake readiness', () => {
  assert.throws(() => bindVariant('A'), TypeError);
  assert.throws(() => bindVariant('C', { connect: () => () => {} }), TypeError);
  assert.throws(() => bindVariant('A', { connect: () => null }), TypeError);
});
test('matched comparisons separate prefetch from persistent-document effects', () => {
  assert.equal(comparison('A', 'B').effect, 'prefetch');
  assert.equal(comparison('C', 'D').effect, 'prefetch');
  assert.equal(comparison('A', 'C').effect, 'document-persistence');
});
test('confounded or reverse comparisons are rejected', () => {
  for (const [a, b] of [['A', 'D'], ['B', 'C'], ['B', 'A'], ['C', 'C']]) assert.throws(() => comparison(a, b), TypeError);
});
