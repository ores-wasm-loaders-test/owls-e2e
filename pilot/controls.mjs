// WT-03: experiment controls, not a loader implementation or performance result.
const MODES = Object.freeze({
  A: Object.freeze({ prepare: false, persistentShell: false }),
  B: Object.freeze({ prepare: true, persistentShell: false }),
  C: Object.freeze({ prepare: false, persistentShell: true }),
  D: Object.freeze({ prepare: true, persistentShell: true }),
});

/** Call once BEFORE observing intent; persist only the cohort in the experiment session. */
export function allocateCohort(word = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
  if (!Number.isSafeInteger(word) || word < 0 || word > 0xffffffff) {
    throw new TypeError('Allocation requires an unsigned 32-bit random word');
  }
  // Four equally sized partitions: no modulo bias and no user identifier input.
  return ['A', 'B', 'C', 'D'][Math.floor(word / 0x40000000)];
}

export function variant(cohort, { disablePreparation = false, disableShell = false } = {}) {
  if (!Object.hasOwn(MODES, cohort)) throw new TypeError('Unknown pilot cohort');
  if (typeof disablePreparation !== 'boolean' || typeof disableShell !== 'boolean') {
    throw new TypeError('Kill switches must be explicit booleans');
  }
  const assigned = MODES[cohort];
  const prepare = assigned.prepare && !disablePreparation;
  const persistentShell = assigned.persistentShell && !disableShell;
  return Object.freeze({ cohort, prepare, persistentShell,
    overridden: prepare !== assigned.prepare || persistentShell !== assigned.persistentShell });
}

/** Inject the installed package's connectApplicationLink; never copy its implementation. */
export function bindVariant(cohort, { connect, anchor, coordinator, key, start,
  disablePreparation = false, disableShell = false, onError = () => {} } = {}) {
  const config = variant(cohort, { disablePreparation, disableShell });
  if (typeof connect !== 'function') throw new TypeError('Supply the installed package link connector');
  if (config.persistentShell && typeof start !== 'function') throw new TypeError('Shell cohorts require an activation function');
  const dispose = connect(anchor, coordinator, key, {
    prepare: config.prepare, onError,
    // A/B must never accidentally run a persistent-shell callback.
    ...(config.persistentShell ? { start } : {}),
  });
  if (typeof dispose !== 'function') throw new TypeError('Connector must return a disposer');
  return Object.freeze({ config, dispose });
}

/** Only these comparisons isolate one architectural variable. */
export function comparison(control, treatment) {
  const a = variant(control), b = variant(treatment);
  if ((control === 'A' && treatment === 'B') || (control === 'C' && treatment === 'D')) {
    return Object.freeze({ control, treatment, effect: 'prefetch', persistentShell: a.persistentShell });
  }
  if (control === 'A' && treatment === 'C') {
    return Object.freeze({ control, treatment, effect: 'document-persistence', prepare: b.prepare });
  }
  throw new TypeError('Comparison confounds effects or uses an unsupported direction');
}
