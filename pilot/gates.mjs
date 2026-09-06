// WT-07/08: evidence analysis, never deployment authorization.
// Exact binomial inversion follows NIST's Clopper-Pearson definition:
// https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/propconf.htm
export const POLICY = Object.freeze({ id: 'owls-pilot-gates-v1', alpha: 0.05,
  minPerArm: 500, maxPerArm: 20000, p75InteractionRatio: 0.8,
  p75MarketingRatio: 1.05, failureRateIncrease: 0.001, speculativePayloadCeiling: 1048576 });
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RECEIPTS = ['publishedPackages', 'browserMatrix', 'physicalMobile', 'security', 'rollback', 'telemetry'];
const METRICS = ['interactiveMs', 'lcpMs', 'inpMs'];
const requireValue = (ok, message) => { if (!ok) throw new TypeError(message); };

/** Mode-centered recurrence avoids factorial overflow, including at large n. */
export function binomialCdf(n, p, k) {
  requireValue(Number.isSafeInteger(n) && n >= 1 && n <= POLICY.maxPerArm && Number.isFinite(p) && p >= 0 && p <= 1 && Number.isInteger(k), 'Invalid binomial inputs');
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p === 0) return 1;
  if (p === 1) return 0;
  const mode = Math.floor((n + 1) * p);
  let total = 1, selected = mode <= k ? 1 : 0, term = 1;
  for (let i = mode; i > 0; i -= 1) {
    term *= i * (1 - p) / ((n - i + 1) * p);
    total += term; if (i - 1 <= k) selected += term;
  }
  term = 1;
  for (let i = mode; i < n; i += 1) {
    term *= (n - i) * p / ((i + 1) * (1 - p));
    total += term; if (i + 1 <= k) selected += term;
  }
  return Math.min(1, Math.max(0, selected / total));
}
function inverseCdf(n, k, probability) {
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (binomialCdf(n, middle, k) > probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
export function failureBand(failures, n, tail = 0.025) {
  requireValue(Number.isInteger(failures) && failures >= 0 && failures <= n && Number.isSafeInteger(n) && n > 0 && n <= POLICY.maxPerArm && tail > 0 && tail < 0.5, 'Invalid rate interval');
  return Object.freeze({ estimate: failures / n,
    low: failures === 0 ? 0 : inverseCdf(n, failures - 1, 1 - tail),
    high: failures === n ? 1 : inverseCdf(n, failures, tail) });
}
/** Distribution-free order-statistic interval. Infinite bounds mean inconclusive. */
export function quantileBand(values, tail = 0.025, p = 0.75) {
  requireValue(Array.isArray(values) && values.length > 0 && values.length <= POLICY.maxPerArm && values.every((x) => typeof x === 'number' && x >= 0 && !Number.isNaN(x)) && tail > 0 && tail < 0.5 && p > 0 && p < 1, 'Invalid quantile observations');
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  let lowerRank = 0, upperRank = n + 1;
  // Binary search on binomial CDF; no normal approximation or bootstrap randomness.
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (binomialCdf(n, p, mid - 1) <= tail) lo = mid; else hi = mid - 1;
  }
  lowerRank = lo;
  lo = 1; hi = n + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (1 - binomialCdf(n, p, mid - 1) <= tail) hi = mid; else lo = mid + 1;
  }
  upperRank = lo;
  return Object.freeze({ estimate: sorted[Math.ceil(n * p) - 1],
    low: lowerRank === 0 ? 0 : sorted[lowerRank - 1],
    high: upperRank > n ? Infinity : sorted[upperRank - 1], lowerRank, upperRank });
}
const keyOf = (row) => [row.framework, row.browser, row.originTopology, row.networkProfile].join('|');

/**
 * One preregistered evaluation of independent randomized sessions, not repeated peeking.
 * Receipts must still be verified by a reviewer. Even green returns review eligibility,
 * never permission to deploy. Lab results and absent required evidence always HOLD.
 */
export function evaluatePilot({ scope, releaseSha, plan, observations, evidence = {} }) {
  requireValue(/^[a-f0-9]{40}$/.test(releaseSha ?? ''), 'Pin the exact source release');
  requireValue(plan?.policyId === POLICY.id && plan.randomizedBeforeIntent === true && Array.isArray(plan.strata) && plan.strata.length > 0 && plan.strata.length <= 32, 'A preregistered plan is required');
  requireValue(Object.keys(plan).every((key) => ['policyId', 'randomizedBeforeIntent', 'strata', 'comparisons', 'lockedAt'].includes(key)), 'Plan cannot override policy thresholds');
  const lockedAt = Date.parse(plan.lockedAt);
  requireValue(Number.isFinite(lockedAt), 'Plan must record its freeze time');
  requireValue(Array.isArray(plan.comparisons) && plan.comparisons.length > 0 && plan.comparisons.length <= 2 && plan.comparisons.every((pair) => pair === 'A:B' || pair === 'C:D') && new Set(plan.comparisons).size === plan.comparisons.length, 'Only matched prefetch comparisons are admissible');
  const strata = new Set();
  for (const stratum of plan.strata) {
    requireValue(['framework', 'browser', 'originTopology', 'networkProfile'].every((field) => SLUG.test(stratum[field] ?? '')), 'Invalid stratum');
    requireValue(!strata.has(keyOf(stratum)), 'Duplicate stratum'); strata.add(keyOf(stratum));
  }
  requireValue(Array.isArray(observations) && observations.length <= 100000, 'Invalid observation collection');
  const seen = new Set(), groups = new Map();
  let excludedOverrides = 0;
  for (const row of observations) {
    requireValue(/^[a-f0-9]{32}$/.test(row.sessionKey ?? '') && !seen.has(row.sessionKey), 'Sessions must be unique random opaque keys, not identities'); seen.add(row.sessionKey);
    requireValue(strata.has(keyOf(row)) && /^[ABCD]$/.test(row.cohort) && row.releaseSha === releaseSha && Date.parse(row.observedAt) > lockedAt, 'Observation does not match the frozen experiment');
    requireValue(typeof row.overridden === 'boolean' && typeof row.failed === 'boolean' && row.intentEligible === true, 'Missing eligibility or outcome');
    if (row.overridden) { excludedOverrides += 1; continue; }
    for (const metric of METRICS) requireValue(row[metric] === null || (Number.isFinite(row[metric]) && row[metric] >= 0), 'Missing/invalid metric must be explicitly null');
    requireValue(Number.isSafeInteger(row.duplicateRuntimeStarts) && row.duplicateRuntimeStarts >= 0 && Number.isSafeInteger(row.speculativePayloadBytes) && row.speculativePayloadBytes >= 0, 'Missing runtime or byte measurements');
    const key = `${keyOf(row)}|${row.cohort}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const reasons = [], comparisons = [];
  if (scope !== 'field') reasons.push('non-field observations cannot authorize field-performance conclusions');
  for (const name of RECEIPTS) {
    const receipt = evidence[name];
    if (receipt?.status !== 'passed' || receipt.releaseSha !== releaseSha || !/^[a-f0-9]{64}$/.test(receipt.artifactSha256 ?? '') || !/^https:\/\//.test(receipt.url ?? '')) reasons.push(`missing or mismatched ${name} receipt`);
  }
  let rejected = false;
  // Six quantile intervals and two rate intervals per comparison; simultaneous 95%
  // coverage across the preregistered family by Bonferroni (two tails per interval).
  const tail = POLICY.alpha / (16 * strata.size * plan.comparisons.length);
  for (const stratum of strata) for (const pair of plan.comparisons) {
    const [control, treatment] = pair.split(':');
    const a = groups.get(`${stratum}|${control}`) ?? [], b = groups.get(`${stratum}|${treatment}`) ?? [];
    const result = { stratum, pair, controlN: a.length, treatmentN: b.length, metrics: {} };
    comparisons.push(result);
    if ([a.length, b.length].some((n) => n < POLICY.minPerArm || n > POLICY.maxPerArm)) { reasons.push(`insufficient or excessive samples: ${stratum} ${pair}`); continue; }
    if ([...a, ...b].some((row) => row.duplicateRuntimeStarts > 0 || row.speculativePayloadBytes > POLICY.speculativePayloadCeiling)) { rejected = true; reasons.push(`runtime/byte ceiling violated: ${stratum} ${pair}`); }
    const rateA = failureBand(a.filter((row) => row.failed).length, a.length, tail);
    const rateB = failureBand(b.filter((row) => row.failed).length, b.length, tail);
    result.failureRateIncreaseUpper = rateB.high - rateA.low;
    if (rateB.estimate - rateA.estimate > POLICY.failureRateIncrease) rejected = true;
    if (result.failureRateIncreaseUpper > POLICY.failureRateIncrease) reasons.push(`reliability non-inferiority not established: ${stratum} ${pair}`);
    for (const metric of METRICS) {
      if ([...a, ...b].some((row) => row[metric] === null && !(metric === 'interactiveMs' && row.failed))) { reasons.push(`missing ${metric}: ${stratum} ${pair}`); continue; }
      // Failed activations are not discarded to make latency look artificially fast.
      const values = (arm) => arm.map((row) => metric === 'interactiveMs' && row.failed ? Infinity : row[metric]);
      const bandA = quantileBand(values(a), tail), bandB = quantileBand(values(b), tail);
      const limit = metric === 'interactiveMs' ? POLICY.p75InteractionRatio : POLICY.p75MarketingRatio;
      const ratioUpper = Number.isFinite(bandA.low) && bandA.low > 0 && Number.isFinite(bandB.high) ? bandB.high / bandA.low : Infinity;
      result.metrics[metric] = { control: bandA, treatment: bandB, ratioUpper, limit };
      if (ratioUpper > limit) reasons.push(`${metric} confidence gate not established: ${stratum} ${pair}`);
      if (metric !== 'interactiveMs' && bandB.estimate > limit * bandA.estimate) rejected = true;
    }
  }
  return { policyId: POLICY.id, releaseSha, scope, productionRolloutAuthorized: false,
    status: rejected ? 'reject' : reasons.length ? 'hold' : 'eligible-for-human-review',
    excludedOverrides, reasons, comparisons };
}

/** Preserve unbounded uncertainty explicitly when persisting JSON evidence. */
export function serializeReport(report) {
  return JSON.stringify(report, (_key, value) => value === Infinity ? 'unbounded' : value, 2);
}
