// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../core/replay.js';
import { generate, mulberry32 } from '../scripts/generate.mjs';

const base = { bureau_score: 700, thin_file: 0, dti: 0.3, cashflow_vol: 0.3, device_risk: 0.2, pd_model: 0.05 };

test('champion flow exits at the first failing node', () => {
  assert.deepEqual(R.runFlow(R.CHAMPION, base), { decision: 'approve', exitNode: 'approve' });
  assert.equal(R.runFlow(R.CHAMPION, { ...base, device_risk: 0.9 }).exitNode, 'fraud');
  assert.equal(R.runFlow(R.CHAMPION, { ...base, dti: 0.46 }).exitNode, 'afford');
  assert.equal(R.runFlow(R.CHAMPION, { ...base, bureau_score: 610 }).exitNode, 'bureau');
  assert.equal(R.runFlow(R.CHAMPION, { ...base, pd_model: 0.11 }).exitNode, 'pd');
  assert.equal(R.runFlow(R.CHAMPION, { ...base, thin_file: 1, bureau_score: 650 }).exitNode, 'thin');
});

test('cash-flow route underwrites thin files on volatility and bypasses the bureau cutoff', () => {
  const flow = R.applyEdits(R.CHAMPION, [{ node: 'thin', set: { mode: 'cashflow', cvMax: 0.45 } }]);
  assert.equal(R.runFlow(flow, { ...base, thin_file: 1, bureau_score: 580, cashflow_vol: 0.3 }).decision, 'approve');
  assert.equal(R.runFlow(flow, { ...base, thin_file: 1, bureau_score: 720, cashflow_vol: 0.6 }).exitNode, 'thin');
  // non-thin applicants still hit the bureau cutoff
  assert.equal(R.runFlow(flow, { ...base, bureau_score: 580 }).exitNode, 'bureau');
});

test('applyEdits does not mutate the baseline flow', () => {
  const before = JSON.stringify(R.CHAMPION);
  R.applyEdits(R.CHAMPION, R.DEFAULT_EDITS);
  assert.equal(JSON.stringify(R.CHAMPION), before);
});

test('weighted logistic regression recovers known coefficients', () => {
  const rnd = mulberry32(3);
  const X = [], y = [], w = [];
  for (let i = 0; i < 20000; i++) {
    const a = rnd() * 4 - 2, b = rnd() * 4 - 2;
    const p = 1 / (1 + Math.exp(-(-1 + 1.5 * a - 0.8 * b)));
    X.push([1, a, b]); y.push(rnd() < p ? 1 : 0); w.push(1);
  }
  const beta = R.fitLogistic(X, y, w, { ridge: 0 });
  assert.ok(Math.abs(beta[0] + 1) < 0.08, 'intercept ' + beta[0]);
  assert.ok(Math.abs(beta[1] - 1.5) < 0.08, 'a ' + beta[1]);
  assert.ok(Math.abs(beta[2] + 0.8) < 0.08, 'b ' + beta[2]);
});

const g = generate(20000, 99);
const rows = R.rowsFromColumns(g.columns, g.meta.dicts);
const est = R.estimateOutcomes(rows);
const EDITS = R.DEFAULT_EDITS.slice(0, 4);

test('AIPW pseudo-outcome equals the observed outcome when the policy always approved', () => {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].propensity === 1) assert.ok(Math.abs(est.phi[i] - rows[i].defaulted) < 1e-12);
    if (rows[i].propensity === 0) assert.equal(est.identified[i], 0);
  }
});

test('decision diff is internally consistent', () => {
  const res = R.replay(rows, est, R.CHAMPION, EDITS, { B: 50 });
  assert.equal(res.candApprN - res.baseApprN, res.swapIn.length - res.swapOut.length);
  const transTotal = Object.values(res.trans).reduce((a, b) => a + b, 0);
  assert.ok(transTotal >= res.swapIn.length + res.swapOut.length);
  const ref = res.fairness.find((f) => f.group === '25-61');
  assert.equal(ref.baseAir, 1);
  assert.ok(res.elDeltaCI[0] <= res.elDelta && res.elDelta <= res.elDeltaCI[1]);
});

test('Shapley attribution is efficient: per-edit shares sum to the total change', () => {
  const sh = R.shapley(rows, est, R.CHAMPION, EDITS);
  const res = R.replay(rows, est, R.CHAMPION, EDITS, { B: 10 });
  const sumA = sh.perEdit.reduce((a, e) => a + e.approvals, 0);
  const sumL = sh.perEdit.reduce((a, e) => a + e.loss, 0);
  assert.ok(Math.abs(sumA - sh.total.approvals) < 1e-6);
  assert.ok(Math.abs(sumA - (res.candApprN - res.baseApprN)) < 1e-6);
  assert.ok(Math.abs(sumL - sh.total.loss) < 1e-3);
  assert.ok(Math.abs(sh.total.loss - res.elDelta) < 1e-3);
});

test('Shapley gives a no-op edit zero credit', () => {
  const noop = { id: 'noop', node: 'fraud', set: { value: 0.85 } };
  const sh = R.shapley(rows, est, R.CHAMPION, [...EDITS.slice(0, 2), noop]);
  assert.ok(Math.abs(sh.perEdit[2].approvals) < 1e-9);
  assert.ok(Math.abs(sh.perEdit[2].loss) < 1e-9);
});

test('swap-ins the old policy never explored get bounds, not a point estimate', () => {
  const res = R.replay(rows, est, R.CHAMPION, R.DEFAULT_EDITS, { B: 20 });
  assert.ok(res.unidentified.count > 0);
  assert.ok(res.unidentified.lo < res.unidentified.hi);
  assert.equal(res.swapInIdentified + res.swapInUnidentified, res.swapIn.length);
  assert.ok(res.elDeltaTotal[1] - res.elDeltaTotal[0] > res.elDeltaCI[1] - res.elDeltaCI[0]);
});

test('simulation check: AIPW is unbiased for swap-in default, the naive backtest is not', () => {
  // Repeated draws from the generator; truth = mean true default probability of swap-ins.
  const afford = [R.DEFAULT_EDITS[0]];
  let biasDR = 0, biasNaive = 0, covered = 0;
  const K = 10;
  for (let s = 0; s < K; s++) {
    const gg = generate(20000, 500 + s);
    const rr = R.rowsFromColumns(gg.columns, gg.meta.dicts);
    const ee = R.estimateOutcomes(rr);
    const res = R.replay(rr, ee, R.CHAMPION, EDITS, { B: 150, seed: s + 1 });
    const truth = res.swapIn.reduce((a, i) => a + gg.truth[i], 0) / res.swapIn.length;
    biasDR += (res.swapInRateDR - truth) / K;
    if (truth >= res.swapInRateDRCI[0] && truth <= res.swapInRateDRCI[1]) covered++;
    const ra = R.replay(rr, ee, R.CHAMPION, afford, { B: 1 });
    const ta = ra.swapIn.reduce((a, i) => a + gg.truth[i], 0) / ra.swapIn.length;
    biasNaive += (ra.swapInRateNaive - ta) / K;
  }
  assert.ok(Math.abs(biasDR) < 0.01, 'AIPW bias ' + biasDR);
  assert.ok(biasNaive < -0.015, 'naive should understate affordability swap-in risk, bias ' + biasNaive);
  assert.ok(covered >= 7, '90% interval covered truth in ' + covered + '/' + K);
});
