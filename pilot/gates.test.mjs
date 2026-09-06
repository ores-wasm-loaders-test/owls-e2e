import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POLICY, binomialCdf, failureBand, quantileBand, evaluatePilot, serializeReport} from './gates.mjs';
const close=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
test('binomial CDF matches exact elementary probabilities',()=>{
  close(binomialCdf(4,.5,0),1/16); close(binomialCdf(4,.5,2),11/16);
  close(binomialCdf(10,0,0),1); close(binomialCdf(10,1,9),0);
});
test('binomial recurrence stays finite for large samples',()=>{
  close(binomialCdf(20000,.5,9999)+binomialCdf(20000,.5,10000),1,1e-9);
});
test('zero observed failures still have a positive upper confidence bound',()=>{
  const ci=failureBand(0,500);close(ci.low,0);close(ci.high,1-Math.pow(.025,1/500));assert.ok(ci.high>.001);
});
test('all failures retain uncertainty below one',()=>{
  const ci=failureBand(500,500);close(ci.high,1);close(ci.low,Math.pow(.025,1/500));
});
test('exact interval matches independently verified Clopper-Pearson fixture',()=>{
  const ci=failureBand(5,10);close(ci.low,.18708602844739852);close(ci.high,.8129139715526015);
});
test('small quantile samples have unbounded uncertainty',()=>{assert.equal(quantileBand([10]).high,Infinity);});
test('quantile sorting never mutates caller observations',()=>{
  const a=[9,2,1,5];const old=[...a];quantileBand(a);assert.deepEqual(a,old);
});
test('quantile order-statistic band encloses the point estimate',()=>{
  const q=quantileBand(Array.from({length:1000},(_,i)=>i+1));assert.equal(q.estimate,750);assert.ok(q.low<750&&q.high>750);
});
test('invalid numeric inputs reject rather than silently becoming zero',()=>{
  for(const x of [-1,NaN])assert.throws(()=>quantileBand([x]));assert.throws(()=>failureBand(11,10));assert.throws(()=>binomialCdf(2,.5,NaN));
});
const SHA='a'.repeat(40), stratum={framework:'rust',browser:'chromium',originTopology:'same-origin',networkProfile:'normal'};
function experiment(n=6000){
  const plan={policyId:POLICY.id,randomizedBeforeIntent:true,lockedAt:'2026-09-06T10:00:00Z',strata:[stratum],comparisons:['A:B']};
  const observations=[];
  for(const [index,cohort] of ['A','B'].entries())for(let i=0;i<n;i++)observations.push({...stratum,sessionKey:(index*n+i+1).toString(16).padStart(32,'0'),cohort,releaseSha:SHA,observedAt:'2026-09-06T12:00:00Z',intentEligible:true,overridden:false,failed:false,interactiveMs:index?60:100,lcpMs:100,inpMs:100,duplicateRuntimeStarts:0,speculativePayloadBytes:index?100:0});
  const receipt={status:'passed',releaseSha:SHA,artifactSha256:'b'.repeat(64),url:'https://example.test/synthetic-unit-test-only'};
  const evidence=Object.fromEntries(['publishedPackages','browserMatrix','physicalMobile','security','rollback','telemetry'].map(key=>[key,receipt]));
  return {scope:'field',releaseSha:SHA,plan,observations,evidence};
}
test('synthetic qualifying evidence still cannot authorize production',()=>{
  const r=evaluatePilot(experiment());assert.equal(r.status,'eligible-for-human-review');assert.equal(r.productionRolloutAuthorized,false);
});
test('localhost evidence always holds even with favorable timings',()=>{
  const input=experiment();input.scope='localhost-lab';assert.equal(evaluatePilot(input).status,'hold');
});
test('missing mobile and publication receipts hold',()=>{
  const input=experiment();delete input.evidence.physicalMobile;delete input.evidence.publishedPackages;const r=evaluatePilot(input);assert.equal(r.status,'hold');assert.ok(r.reasons.some(x=>x.includes('physicalMobile')));
});
test('small samples cannot prove a 0.1pp reliability margin',()=>{
  const r=evaluatePilot(experiment(500));assert.equal(r.status,'hold');assert.ok(r.reasons.some(x=>x.includes('reliability')));
});
test('duplicate runtime initialization is a rejection',()=>{
  const input=experiment();input.observations[1].duplicateRuntimeStarts=1;assert.equal(evaluatePilot(input).status,'reject');
});
test('observed marketing regression is a rejection',()=>{
  const input=experiment();for(const r of input.observations)if(r.cohort==='B')r.inpMs=200;assert.equal(evaluatePilot(input).status,'reject');
});
test('missing marketing metrics hold instead of being dropped',()=>{
  const input=experiment();input.observations[0].lcpMs=null;assert.equal(evaluatePilot(input).status,'hold');
});
test('threshold relaxation, confounded comparisons and reused sessions reject input',()=>{
  const a=experiment(1);a.plan.p75InteractionRatio=2;assert.throws(()=>evaluatePilot(a));
  const b=experiment(1);b.plan.comparisons=['A:D'];assert.throws(()=>evaluatePilot(b));
  const c=experiment(1);c.observations[1].sessionKey=c.observations[0].sessionKey;assert.throws(()=>evaluatePilot(c));
});
test('release mismatch and observations before preregistration reject input',()=>{
  const a=experiment(1);a.observations[0].releaseSha='c'.repeat(40);assert.throws(()=>evaluatePilot(a));
  const b=experiment(1);b.observations[0].observedAt='2026-09-05T00:00:00Z';assert.throws(()=>evaluatePilot(b));
});
test('kill-switch overrides are counted separately, never relabeled as control',()=>{
  const input=experiment(500);input.observations[0].overridden=true;const r=evaluatePilot(input);assert.equal(r.excludedOverrides,1);assert.equal(r.comparisons[0].controlN,499);assert.equal(r.status,'hold');
});
test('failed activations remain in reliability and latency analysis',()=>{
  const input=experiment();for(const row of input.observations)if(row.cohort==='B'){row.failed=true;row.interactiveMs=null;}const r=evaluatePilot(input);assert.equal(r.status,'reject');assert.equal(r.comparisons[0].metrics.interactiveMs.treatment.estimate,Infinity);
});
test('persisted reports distinguish unbounded uncertainty from a missing metric',()=>{
  assert.equal(JSON.parse(serializeReport({bound:Infinity,missing:null})).bound,'unbounded');
});
