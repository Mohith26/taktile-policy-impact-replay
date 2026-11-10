// Policy Impact Replay: core algorithm (ES module, runs in the browser and in Node).
//
// Given a logged decision history (inputs, historical decision, logged approval
// propensity, and outcomes for booked loans), a baseline flow and a set of node
// edits, it computes:
//   1. the decision diff (swap-ins, swap-outs, node-to-node transitions),
//   2. exact Shapley attribution of approvals / swap-ins / expected loss to each edit,
//   3. doubly-robust (AIPW) loss estimates for swap-ins whose outcomes were never
//      observed, with bootstrap intervals, plus partial-identification bounds for
//      rows the historical policy never explored (propensity 0),
//   4. fairness shifts (approval rate and adverse impact ratio by group) and segment deltas.

export const EXPLORATION_RATE = 0.1;

export const CHAMPION = {
  id: 'v14',
  nodes: [
    { id: 'fraud', label: 'Fraud screen', kind: 'Rule', field: 'device_risk', op: '>', value: 0.85, note: 'Decline if device risk > {v}' },
    { id: 'afford', label: 'Affordability', kind: 'Rule', field: 'dti', op: '>', value: 0.45, note: 'Decline if DTI > {v}' },
    { id: 'thin', label: 'Thin-file route', kind: 'Split', mode: 'score', scoreMin: 680, cvMax: 0.45, note: '' },
    { id: 'bureau', label: 'Bureau cutoff', kind: 'Rule', field: 'bureau_score', op: '<', value: 620, note: 'Decline if score < {v}' },
    { id: 'pd', label: 'PD model', kind: 'Model', field: 'pd_model', op: '>', value: 0.1, note: 'Decline if PD > {v}' },
  ],
};

export const NODE_IDS = ['fraud', 'afford', 'thin', 'bureau', 'pd'];

const cmp = (a, op, b) => (op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b);

// Returns { decision: 'approve'|'decline', exitNode } where exitNode is the node that declined, or 'approve'.
export function runFlow(flow, row) {
  const nodes = flow.nodes;
  let skipBureau = false;
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.id === 'thin') {
      if (!row.thin_file) continue;
      if (nd.mode === 'score') {
        if (row.bureau_score < nd.scoreMin) return { decision: 'decline', exitNode: 'thin' };
      } else {
        // Cash-flow route: thin-file applicants are underwritten on open-banking volatility
        // and bypass the bureau cutoff (their bureau score carries little signal).
        if (row.cashflow_vol > nd.cvMax) return { decision: 'decline', exitNode: 'thin' };
        skipBureau = true;
      }
      continue;
    }
    if (nd.id === 'bureau' && skipBureau) continue;
    if (cmp(row[nd.field], nd.op, nd.value)) return { decision: 'decline', exitNode: nd.id };
  }
  return { decision: 'approve', exitNode: 'approve' };
}

// An edit is { id, node, set: {...} }. Returns a new flow.
export function applyEdits(flow, edits) {
  const nodes = flow.nodes.map((n) => ({ ...n }));
  for (const e of edits) {
    const nd = nodes.find((n) => n.id === e.node);
    if (!nd) throw new Error('unknown node ' + e.node);
    Object.assign(nd, e.set);
  }
  return { ...flow, id: flow.id + '+', nodes };
}

// Decodes the columnar file (categoricals stored as dictionary indices) into row objects.
export function rowsFromColumns(columns, dicts = {}) {
  const keys = Object.keys(columns);
  const n = columns[keys[0]].length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = { id: i };
    for (const k of keys) r[k] = dicts[k] ? dicts[k][columns[k][i]] : columns[k][i];
    rows[i] = r;
  }
  return rows;
}

export function decide(rows, flow) {
  const n = rows.length;
  const appr = new Uint8Array(n);
  const exit = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = runFlow(flow, rows[i]);
    appr[i] = r.decision === 'approve' ? 1 : 0;
    exit[i] = r.exitNode;
  }
  return { appr, exit };
}

// ---------- outcome model: weighted ridge logistic regression (IRLS) ----------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
const hinge = (x, k) => Math.max(0, x - k);

export function features(r) {
  const d = (r.dti - 0.3) / 0.1;
  const nt = 1 - r.thin_file;
  return [1, (r.bureau_score - 650) / 50, d, hinge(r.dti, 0.45) / 0.1, hinge(r.dti, 0.5) / 0.1, nt * hinge(620 - r.bureau_score, 0) / 20, nt * hinge(600 - r.bureau_score, 0) / 20, Math.log(r.cashflow_vol), r.thin_file, r.thin_file * Math.log(r.cashflow_vol), logit(r.pd_model)];
}

export function fitLogistic(X, y, w, { ridge = 1.0, iters = 30 } = {}) {
  const p = X[0].length, n = X.length;
  let beta = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    const g = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let eta = 0;
      for (let j = 0; j < p; j++) eta += xi[j] * beta[j];
      const mu = sigmoid(eta);
      const wi = w[i] * mu * (1 - mu);
      const ri = w[i] * (y[i] - mu);
      for (let j = 0; j < p; j++) {
        g[j] += xi[j] * ri;
        const a = xi[j] * wi;
        for (let k = j; k < p; k++) H[j][k] += a * xi[k];
      }
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      if (j > 0) { H[j][j] += ridge; g[j] -= ridge * beta[j]; }
      else H[j][j] += 1e-8;
    }
    const step = solve(H, g);
    let maxStep = 0;
    for (let j = 0; j < p; j++) { beta[j] += step[j]; maxStep = Math.max(maxStep, Math.abs(step[j])); }
    if (maxStep < 1e-7) break;
  }
  return beta;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function predict(beta, x) {
  let eta = 0;
  for (let j = 0; j < beta.length; j++) eta += x[j] * beta[j];
  return sigmoid(eta);
}

// Per-row default estimates.
//  phi[i]   : AIPW pseudo-outcome, unbiased for P(default | x_i) whenever propensity > 0.
//             phi = m(x) + A/pi * (Y - m(x)), with m cross-fitted (2 folds) using IPW weights.
//  naive[i] : what a standard backtest does: observed outcome if booked, else a model fit
//             on the regularly-booked book (no exploration data, no reweighting).
//  identified[i] : 0 when the historical policy could never have approved the row (pi = 0).
//  lower[i] : assumption-based lower bound for unidentified rows (monotone risk in device score).
export function estimateOutcomes(rows, { folds = 2 } = {}) {
  const n = rows.length;
  const X = rows.map(features);
  const fold = new Uint8Array(n);
  for (let i = 0; i < n; i++) fold[i] = (rows[i].id * 2654435761 >>> 0) % folds;
  const m = new Float64Array(n);
  for (let f = 0; f < folds; f++) {
    const Xs = [], ys = [], ws = [];
    for (let i = 0; i < n; i++) {
      if (fold[i] === f || !rows[i].approved) continue;
      Xs.push(X[i]); ys.push(rows[i].defaulted); ws.push(1 / rows[i].propensity);
    }
    const beta = fitLogistic(Xs, ys, ws);
    for (let i = 0; i < n; i++) if (fold[i] === f) m[i] = predict(beta, X[i]);
  }
  // naive model: regular book only, unweighted
  const Xn = [], yn = [], wn = [];
  for (let i = 0; i < n; i++) if (rows[i].approved && !rows[i].exploration) { Xn.push(X[i]); yn.push(rows[i].defaulted); wn.push(1); }
  const betaNaive = fitLogistic(Xn, yn, wn);

  const phi = new Float64Array(n), naive = new Float64Array(n), identified = new Uint8Array(n), lower = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    naive[i] = r.approved ? r.defaulted : predict(betaNaive, X[i]);
    if (r.propensity > 0) {
      identified[i] = 1;
      phi[i] = m[i] + (r.approved ? (r.defaulted - m[i]) / r.propensity : 0);
    } else {
      identified[i] = 0;
      phi[i] = NaN;
    }
  }
  // Monotonicity lower bound for unexplored rows: risk is assumed non-decreasing in device risk,
  // so default probability above the fraud cut is at least the AIPW rate just below it.
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) if (identified[i] && rows[i].device_risk > 0.75) { s += phi[i]; c++; }
  const lb = c ? Math.min(1, Math.max(0, s / c)) : 0;
  for (let i = 0; i < n; i++) lower[i] = identified[i] ? phi[i] : lb;
  return { m, phi, naive, identified, lower, betaNaive, nearCutRate: lb, nearCutN: c };
}

// ---------- replay ----------
export function replay(rows, est, baseFlow, edits, { lgd = 0.65, B = 300, seed = 7, groupKey = 'age_band', refGroup = '25-61' } = {}) {
  const n = rows.length;
  const cand = applyEdits(baseFlow, edits);
  const base = decide(rows, baseFlow);
  const cd = decide(rows, cand);
  const swapIn = [], swapOut = [];
  const trans = {};
  for (let i = 0; i < n; i++) {
    const key = base.exit[i] + '>' + cd.exit[i];
    if (base.exit[i] !== cd.exit[i]) trans[key] = (trans[key] || 0) + 1;
    if (!base.appr[i] && cd.appr[i]) swapIn.push(i);
    if (base.appr[i] && !cd.appr[i]) swapOut.push(i);
  }
  const loss = (i, p) => p * rows[i].amount * lgd;
  // Baseline expected loss uses observed outcomes where booked under the baseline (baseline = logged champion here).
  const pt = (arr, f) => arr.reduce((a, i) => a + f(i), 0);

  const inIdent = swapIn.filter((i) => est.identified[i]);
  const inUnident = swapIn.filter((i) => !est.identified[i]);
  const outLoss = pt(swapOut, (i) => loss(i, rowOutcome(rows[i], est, i)));
  const inLossDR = pt(inIdent, (i) => loss(i, est.phi[i]));
  const inLossNaive = pt(swapIn, (i) => loss(i, est.naive[i]));
  const unidLo = pt(inUnident, (i) => loss(i, est.lower[i]));
  const unidHi = pt(inUnident, (i) => loss(i, 1));
  const unidWorstLo = 0;

  const baseApprN = sum(base.appr), candApprN = sum(cd.appr);
  const baseBookLoss = pt(range(n).filter((i) => base.appr[i]), (i) => loss(i, rowOutcome(rows[i], est, i)));
  const baseBookAmt = pt(range(n).filter((i) => base.appr[i]), (i) => rows[i].amount);
  const candBookAmt = baseBookAmt - pt(swapOut, (i) => rows[i].amount) + pt(swapIn, (i) => rows[i].amount);

  // Bootstrap over applicants: resample all n rows with replacement and recompute the
  // statistics on the resample (typed arrays so it stays interactive in the browser).
  const rnd = rng(seed);
  const groups = uniq(rows.map((r) => r[groupKey]));
  const G = groups.length, refIdx = groups.indexOf(refGroup);
  const gIdx = new Uint8Array(n), dLoss = new Float64Array(n), inPhiArr = new Float64Array(n), inFlag = new Uint8Array(n);
  for (let i = 0; i < n; i++) gIdx[i] = groups.indexOf(rows[i][groupKey]);
  for (const i of swapIn) if (est.identified[i]) { dLoss[i] = loss(i, est.phi[i]); inPhiArr[i] = est.phi[i]; inFlag[i] = 1; }
  for (const i of swapOut) dLoss[i] = -loss(i, rowOutcome(rows[i], est, i));
  const bAppB = base.appr, bAppC = cd.appr;
  const bDelta = new Float64Array(B), bRate = new Float64Array(B), bAir = groups.map(() => new Float64Array(B));
  const gb = new Float64Array(G), gc = new Float64Array(G), gn = new Float64Array(G);
  for (let b = 0; b < B; b++) {
    let dl = 0, inPhi = 0, inCnt = 0;
    gb.fill(0); gc.fill(0); gn.fill(0);
    for (let t = 0; t < n; t++) {
      const i = (rnd() * n) | 0;
      const g = gIdx[i];
      gn[g]++; gb[g] += bAppB[i]; gc[g] += bAppC[i];
      dl += dLoss[i]; inPhi += inPhiArr[i]; inCnt += inFlag[i];
    }
    bDelta[b] = dl; bRate[b] = inCnt ? inPhi / inCnt : 0;
    for (let g = 0; g < G; g++) {
      const airB = (gb[g] / gn[g]) / (gb[refIdx] / gn[refIdx]);
      const airC = (gc[g] / gn[g]) / (gc[refIdx] / gn[refIdx]);
      bAir[g][b] = airC - airB;
    }
  }
  const q = (arr, p) => quantile(arr, p);
  const dlPoint = inLossDR - outLoss;
  const identRate = inIdent.length ? inIdent.reduce((a, i) => a + est.phi[i], 0) / inIdent.length : NaN;
  const naiveRate = swapIn.length ? swapIn.reduce((a, i) => a + est.naive[i], 0) / swapIn.length : NaN;

  // fairness
  const fairness = groups.map((g) => {
    let nb = 0, nc = 0, nn = 0;
    for (let i = 0; i < n; i++) if (rows[i][groupKey] === g) { nn++; nb += base.appr[i]; nc += cd.appr[i]; }
    return { group: g, n: nn, baseRate: nb / nn, candRate: nc / nn };
  });
  const ref = fairness.find((f) => f.group === refGroup);
  for (const f of fairness) {
    f.baseAir = f.baseRate / ref.baseRate;
    f.candAir = f.candRate / ref.candRate;
    f.airDeltaCI = [q(bAir[groups.indexOf(f.group)], 0.05), q(bAir[groups.indexOf(f.group)], 0.95)];
  }

  // per-node flow counts and per-row flip origin
  const nodeStats = Object.fromEntries([...NODE_IDS, 'approve'].map((k) => [k, { baseDeclines: 0, candDeclines: 0, swapInFrom: 0, swapOutTo: 0 }]));
  for (let i = 0; i < n; i++) {
    if (!base.appr[i]) nodeStats[base.exit[i]].baseDeclines++;
    if (!cd.appr[i]) nodeStats[cd.exit[i]].candDeclines++;
  }
  for (const i of swapIn) nodeStats[base.exit[i]].swapInFrom++;
  for (const i of swapOut) nodeStats[cd.exit[i]].swapOutTo++;

  return {
    cand, base, cd, swapIn, swapOut, trans, nodeStats,
    n, baseApprN, candApprN,
    baseApprRate: baseApprN / n, candApprRate: candApprN / n,
    swapInIdentified: inIdent.length, swapInUnidentified: inUnident.length,
    swapInRateDR: identRate, swapInRateDRCI: [q(bRate, 0.05), q(bRate, 0.95)],
    swapInRateNaive: naiveRate,
    swapOutRate: swapOut.length ? swapOut.reduce((a, i) => a + rowOutcome(rows[i], est, i), 0) / swapOut.length : NaN,
    elDelta: dlPoint, elDeltaCI: [q(bDelta, 0.05) , q(bDelta, 0.95)],
    elDeltaNaive: inLossNaive - outLoss,
    unidentified: { count: inUnident.length, lo: unidLo, hi: unidHi, worstLo: unidWorstLo, assumedRate: est.nearCutRate },
    elDeltaTotal: [q(bDelta, 0.05) + unidLo, q(bDelta, 0.95) + unidHi],
    baseLossRate: baseBookLoss / baseBookAmt,
    candLossRate: (baseBookLoss + dlPoint + unidLo) / candBookAmt,
    candLossRateHi: (baseBookLoss + q(bDelta, 0.95) + unidHi) / candBookAmt,
    candLossRateLo: (baseBookLoss + q(bDelta, 0.05) + unidLo) / candBookAmt,
    fairness,
  };
}

// AIPW pseudo-outcome. For rows the logged policy always approved (propensity 1) this is
// exactly the observed outcome; for explored declines it is the reweighted estimate, so
// rows booked through the exploration program are never double-counted at face value.
function rowOutcome(r, est, i) { return est.identified[i] ? est.phi[i] : est.lower[i]; }

// ---------- Shapley attribution over edits ----------
// Exact Shapley values of each edit for: approvals gained, and expected loss (AIPW,
// identified rows only; unidentified rows are counted separately).
export function shapley(rows, est, baseFlow, edits, { lgd = 0.65 } = {}) {
  const k = edits.length, n = rows.length;
  const nm = 1 << k;
  const appr = new Array(nm);
  for (let mask = 0; mask < nm; mask++) {
    const sel = edits.filter((_, j) => mask & (1 << j));
    appr[mask] = decide(rows, applyEdits(baseFlow, sel)).appr;
  }
  const rowLoss = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const p = est.identified[i] ? est.phi[i] : 0;
    rowLoss[i] = p * r.amount * lgd;
  }
  const vA = new Float64Array(nm), vL = new Float64Array(nm), vU = new Float64Array(nm);
  for (let mask = 0; mask < nm; mask++) {
    let a = 0, l = 0, u = 0;
    const ap = appr[mask];
    for (let i = 0; i < n; i++) if (ap[i]) { a++; l += rowLoss[i]; if (!est.identified[i]) u++; }
    vA[mask] = a; vL[mask] = l; vU[mask] = u;
  }
  const fact = (x) => (x <= 1 ? 1 : x * fact(x - 1));
  const out = edits.map((e, j) => {
    let sA = 0, sL = 0, sU = 0;
    for (let mask = 0; mask < nm; mask++) {
      if (mask & (1 << j)) continue;
      const s = popcount(mask);
      const w = (fact(s) * fact(k - s - 1)) / fact(k);
      sA += w * (vA[mask | (1 << j)] - vA[mask]);
      sL += w * (vL[mask | (1 << j)] - vL[mask]);
      sU += w * (vU[mask | (1 << j)] - vU[mask]);
    }
    return { id: e.id, approvals: sA, loss: sL, unidentified: sU };
  });
  // interaction: flips that need two or more edits together (no single edit flips them)
  const full = appr[nm - 1], none = appr[0];
  let joint = 0, flips = 0;
  for (let i = 0; i < n; i++) {
    if (full[i] === none[i]) continue;
    flips++;
    let single = false;
    for (let j = 0; j < k; j++) if (appr[1 << j][i] !== none[i]) { single = true; break; }
    if (!single) joint++;
  }
  return { perEdit: out, total: { approvals: vA[nm - 1] - vA[0], loss: vL[nm - 1] - vL[0] }, jointFlips: joint, flips };
}

// ---------- segments ----------
export function segments(rows, est, res, key, { lgd = 0.65 } = {}) {
  const keys = uniq(rows.map((r) => r[key]));
  return keys.map((g) => {
    let n = 0, b = 0, c = 0, sin = 0, sout = 0, dl = 0, unid = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][key] !== g) continue;
      n++; b += res.base.appr[i]; c += res.cd.appr[i];
    }
    for (const i of res.swapIn) if (rows[i][key] === g) { sin++; if (est.identified[i]) dl += est.phi[i] * rows[i].amount * lgd; else unid++; }
    for (const i of res.swapOut) if (rows[i][key] === g) { sout++; dl -= rowOutcome(rows[i], est, i) * rows[i].amount * lgd; }
    return { segment: g, n, baseRate: b / n, candRate: c / n, swapIn: sin, swapOut: sout, elDelta: dl, unidentified: unid };
  });
}

// ---------- helpers ----------
export function quantile(arr, p) {
  const s = Float64Array.from(arr).sort();
  if (!s.length) return NaN;
  const idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function range(n) { return Array.from({ length: n }, (_, i) => i); }
function uniq(a) { return [...new Set(a)]; }
function popcount(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default candidate edits for the demo (v15 draft).
export const DEFAULT_EDITS = [
  { id: 'afford', node: 'afford', label: 'Relax affordability cut', set: { value: 0.5 }, param: { key: 'value', min: 0.4, max: 0.6, step: 0.01, fmt: 'dti' } },
  { id: 'bureau', node: 'bureau', label: 'Lower bureau cutoff', set: { value: 600 }, param: { key: 'value', min: 560, max: 660, step: 5, fmt: 'int' } },
  { id: 'thin', node: 'thin', label: 'Route thin files to cash-flow underwriting', set: { mode: 'cashflow', cvMax: 0.45 }, param: { key: 'cvMax', min: 0.25, max: 0.8, step: 0.01, fmt: 'vol' } },
  { id: 'pd', node: 'pd', label: 'Raise PD model threshold', set: { value: 0.12 }, param: { key: 'value', min: 0.06, max: 0.2, step: 0.005, fmt: 'pct' } },
  { id: 'fraud', node: 'fraud', label: 'Loosen fraud screen', set: { value: 0.9 }, param: { key: 'value', min: 0.8, max: 0.98, step: 0.01, fmt: 'dec' } },
];
