import * as R from './core/replay.js';

const $ = (id) => document.getElementById(id);
const fmtInt = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + '%' : 'n/a');
const pp = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + ' pp';
const money = (x, sign = true) => {
  const s = x < 0 ? '−' : sign ? '+' : '';
  const a = Math.abs(x);
  return s + (a >= 1e6 ? '$' + (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'k' : '$' + Math.round(a));
};
const NODE_LABEL = Object.fromEntries(R.CHAMPION.nodes.map((n) => [n.id, n.label]));
NODE_LABEL.approve = 'Approve';

const state = {
  rows: null, est: null, truth: null, meta: null,
  edits: R.DEFAULT_EDITS.map((e) => ({ ...e, set: { ...e.set }, on: e.id !== 'fraud' })),
  sel: null, tab: 'diff', showTruth: true, segKey: 'product',
  res: null, sh: null, solo: {},
};

function activeEdits() {
  return state.edits.filter((e) => e.on).map((e) => ({ id: e.id, node: e.node, set: { ...e.set } }));
}

async function load() {
  const [app, tr] = await Promise.all([fetch('data/applications.json').then((r) => r.json()), fetch('data/truth.json').then((r) => r.json())]);
  state.meta = app.meta;
  state.rows = R.rowsFromColumns(app.columns, app.meta.dicts);
  for (const r of state.rows) {
    const s = r.bureau_score;
    r.score_band = s < 600 ? 'Under 600' : s < 620 ? '600-619' : s < 680 ? '620-679' : s < 740 ? '680-739' : '740+';
    r.thin_label = r.thin_file ? 'Thin file' : 'Established file';
  }
  state.truth = tr.p_default;
  state.est = R.estimateOutcomes(state.rows);
  // Deep links, e.g. #tab=risk&on=fraud&sel=thin
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('tab')) state.tab = h.get('tab');
  if (h.get('sel')) state.sel = h.get('sel');
  for (const id of (h.get('on') || '').split(',').filter(Boolean)) { const e = state.edits.find((x) => x.id === id); if (e) e.on = true; }
  for (const id of (h.get('off') || '').split(',').filter(Boolean)) { const e = state.edits.find((x) => x.id === id); if (e) e.on = false; }
  const booked = state.rows.reduce((a, r) => a + r.approved, 0);
  const explored = state.rows.reduce((a, r) => a + r.exploration, 0);
  $('subline').textContent = `Replaying ${fmtInt(state.rows.length)} historical applications (Jul 2024 to Jun 2025) through v14 and v15. ${fmtInt(booked)} were booked with 12-month outcomes, ${fmtInt(explored)} of them through the ${pct(state.meta.exploration_rate, 0)} test-below-the-cut program.`;
  recompute();
}

function recompute() {
  const t0 = performance.now();
  const edits = activeEdits();
  state.res = R.replay(state.rows, state.est, R.CHAMPION, edits, { lgd: state.meta.lgd, B: 300 });
  state.sh = R.shapley(state.rows, state.est, R.CHAMPION, edits, { lgd: state.meta.lgd });
  state.solo = {};
  for (const e of edits) state.solo[e.id] = R.replay(state.rows, state.est, R.CHAMPION, [e], { lgd: state.meta.lgd, B: 200, seed: 11 });
  const ms = Math.round(performance.now() - t0);
  $('status').textContent = `Replayed in ${ms} ms`;
  $('status').className = 'status ok';
  $('editCount').textContent = edits.length;
  render();
}

function render() {
  renderFlow();
  renderEdits();
  renderKpis();
  renderTab();
}

// ---------------- canvas ----------------
function condText(node, base) {
  const fmt = (id, v) => (id === 'bureau' ? String(v) : id === 'pd' ? v.toFixed(2) : v.toFixed(2));
  if (node.id === 'thin') {
    const line = (n) => (n.mode === 'score' ? `thin_file and bureau_score < ${n.scoreMin}` : `thin_file and cashflow_vol > ${n.cvMax.toFixed(2)}; else skip bureau`);
    if (node.mode !== base.mode || node.cvMax !== base.cvMax) return `<div><s>${line(base)}</s></div><div class="new">${line(node)}</div>`;
    return line(node);
  }
  if (node.value !== base.value) return `${node.field} ${node.op} <s>${fmt(node.id, base.value)}</s> <span class="new">${fmt(node.id, node.value)}</span>`;
  return `${node.field} ${node.op} ${fmt(node.id, node.value)}`;
}

function renderFlow() {
  const { res } = state;
  const cand = res.cand.nodes;
  let html = `<div class="start">Application received <small>${fmtInt(res.n)} replayed</small></div>`;
  for (const node of cand) {
    const base = R.CHAMPION.nodes.find((n) => n.id === node.id);
    const st = res.nodeStats[node.id];
    const edited = JSON.stringify(base) !== JSON.stringify(node);
    const dDecl = st.candDeclines - st.baseDeclines;
    const badges = [];
    if (st.swapInFrom) badges.push(`<span class="b in">+${fmtInt(st.swapInFrom)} swap-ins</span>`);
    if (st.swapOutTo) badges.push(`<span class="b out">${fmtInt(st.swapOutTo)} swap-outs</span>`);
    if (!badges.length) badges.push(`<span class="b neutral">no flips</span>`);
    html += `<div class="edge"></div>
    <div class="nrow">
      <div class="node ${edited ? 'edited' : ''} ${state.sel === node.id ? 'sel' : ''}" data-node="${node.id}">
        <div class="node-top"><span class="kind ${node.kind}">${node.kind}</span><span class="node-title">${node.label}</span>${edited ? '<span class="edited-tag">Edited</span>' : ''}</div>
        <div class="cond">${condText(node, base)}</div>
        <div class="node-badges">${badges.join('')}</div>
      </div>
      <div class="branch"><div class="h"></div>
        <div class="decline">Decline <b>${fmtInt(st.candDeclines)}</b><div class="delta">${dDecl === 0 ? 'unchanged' : `was ${fmtInt(st.baseDeclines)} <span class="${dDecl < 0 ? 'up' : 'down'}">(${dDecl > 0 ? '+' : '−'}${fmtInt(Math.abs(dDecl))})</span>`}</div></div>
      </div>
    </div>`;
  }
  html += `<div class="edge"></div><div class="terminal">Approve ${fmtInt(res.candApprN)} <small>was ${fmtInt(res.baseApprN)}</small></div>`;
  $('flow').innerHTML = html;
  $('flow').querySelectorAll('.node').forEach((el) => el.addEventListener('click', () => {
    state.sel = state.sel === el.dataset.node ? null : el.dataset.node;
    if (state.tab !== 'diff') state.tab = 'diff';
    render();
  }));
}

// ---------------- edits ----------------
function fmtParam(e, v) {
  const f = e.param.fmt;
  return f === 'int' ? String(v) : f === 'pct' ? (v * 100).toFixed(1) + '%' : f === 'vol' ? 'σ≤' + (+v).toFixed(2) : (+v).toFixed(2);
}
function baseParam(e) {
  const b = R.CHAMPION.nodes.find((n) => n.id === e.node);
  if (e.id === 'thin') return 'score';
  return fmtParam(e, b[e.param.key]);
}

function renderEdits() {
  const shBy = Object.fromEntries(state.sh.perEdit.map((p) => [p.id, p]));
  let html = `<div class="edits-h"><span>v15 edits (toggle to replay without one)</span><span>Parameter</span><span style="text-align:right">Shapley share</span></div>`;
  for (const e of state.edits) {
    const v = e.set[e.param.key];
    const s = shBy[e.id];
    html += `<div class="edit ${e.on ? '' : 'off'}" data-id="${e.id}">
      <div class="edit-l"><button class="sw ${e.on ? 'on' : ''}" data-act="toggle" aria-label="toggle ${e.label}"></button>
        <div style="min-width:0"><div class="edit-name">${e.label}</div><div class="edit-node">${NODE_LABEL[e.node]} node</div></div></div>
      <div class="edit-ctl"><input type="range" min="${e.param.min}" max="${e.param.max}" step="${e.param.step}" value="${v}" ${e.on ? '' : 'disabled'} data-act="slide">
        <span class="edit-val"><s>${baseParam(e)}</s> ${fmtParam(e, v)}</span></div>
      <div class="edit-att">${s ? `<div class="a">${s.approvals >= 0 ? '+' : '−'}${fmtInt(Math.abs(s.approvals))} approvals</div><div class="l">${s.approvals > 0.5 && s.unidentified / s.approvals > 0.5 ? '<span class="warn">loss not identified</span>' : `${money(s.loss)} exp. loss${s.unidentified >= Math.max(10, 0.05 * s.approvals) ? ' <span class="warn">+ bound</span>' : ''}`}</div>` : '<div class="l">off</div>'}</div>
    </div>`;
  }
  $('edits').innerHTML = html;
  let timer = null;
  $('edits').querySelectorAll('.edit').forEach((row) => {
    const e = state.edits.find((x) => x.id === row.dataset.id);
    row.querySelector('[data-act=toggle]').addEventListener('click', () => { e.on = !e.on; recompute(); });
    const sl = row.querySelector('[data-act=slide]');
    sl.addEventListener('input', () => {
      e.set[e.param.key] = +sl.value;
      row.querySelector('.edit-val').innerHTML = `<s>${baseParam(e)}</s> ${fmtParam(e, +sl.value)}`;
      $('status').textContent = 'Replaying…'; $('status').className = 'status';
      clearTimeout(timer); timer = setTimeout(recompute, 180);
    });
  });
}

// ---------------- KPIs ----------------
function renderKpis() {
  const r = state.res, sh = state.sh;
  const dA = r.candApprRate - r.baseApprRate;
  const unid = r.unidentified.count > 0;
  $('kpis').innerHTML = `
    <div class="kpi"><div class="t">Approval rate</div><div class="v">${pct(r.candApprRate)}</div><div class="d">from ${pct(r.baseApprRate)} · <b class="${dA >= 0 ? 'up' : 'down'}">${pp(dA)}</b></div></div>
    <div class="kpi"><div class="t">Decision flips</div><div class="v">${fmtInt(r.swapIn.length)} <small>in</small> · ${fmtInt(r.swapOut.length)} <small>out</small></div><div class="d"><b>${fmtInt(sh.jointFlips)}</b> only flip when 2+ edits combine</div></div>
    <div class="kpi"><div class="t">Expected 12-mo loss change</div><div class="v ${r.elDelta > 0 ? 'down' : 'up'}">${money(r.elDelta)}${unid ? '<small> + bound</small>' : ''}</div><div class="d">90% CI ${money(r.elDeltaCI[0])} to ${money(r.elDeltaCI[1])}${unid ? `<br><span class="warn">+${money(r.unidentified.lo, false)} to ${money(r.unidentified.hi, false)} not identified</span>` : ''}</div></div>
    <div class="kpi"><div class="t">Swap-in default rate (AIPW)</div><div class="v">${pct(r.swapInRateDR)}</div><div class="d">90% CI ${pct(r.swapInRateDRCI[0])} to ${pct(r.swapInRateDRCI[1])} · naive ${pct(r.swapInRateNaive)}${unid ? `<br><span class="warn">identified swap-ins only (${fmtInt(r.swapInIdentified)} of ${fmtInt(r.swapIn.length)})</span>` : ''}</div></div>`;
}

// ---------------- tabs ----------------
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTab(); }));

function renderTab() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  const fn = { diff: tabDiff, risk: tabRisk, fair: tabFair, seg: tabSeg }[state.tab];
  $('tabbody').innerHTML = fn();
  if (state.tab === 'risk') {
    const c = $('truthChk');
    if (c) c.addEventListener('change', () => { state.showTruth = c.checked; renderTab(); });
  }
  if (state.tab === 'seg') document.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => { state.segKey = b.dataset.seg; renderTab(); }));
  if (state.tab === 'diff') document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { state.sel = null; render(); }));
}

function tabDiff() {
  const r = state.res, sh = state.sh;
  let trans = Object.entries(r.trans).map(([k, v]) => { const [a, b] = k.split('>'); return { a, b, v }; });
  if (state.sel) trans = trans.filter((t) => t.a === state.sel || t.b === state.sel);
  trans.sort((x, y) => y.v - x.v);
  const totalFlips = r.swapIn.length + r.swapOut.length;
  const maxV = Math.max(1, ...trans.map((t) => t.v));
  const kind = (t) => (t.b === 'approve' ? 'in' : t.a === 'approve' ? 'out' : '');
  const chip = (id) => (id === 'approve' ? '<span class="chip ap">Approved</span>' : `<span class="chip">Declined · ${NODE_LABEL[id]}</span>`);
  const rows = trans.map((t) => `<tr><td><span class="flowpair">${chip(t.a)}<span class="arrow">→</span>${chip(t.b)}</span></td>
     <td class="n">${fmtInt(t.v)}</td><td class="n muted">${pct(t.v / Math.max(1, Object.values(r.trans).reduce((a, b) => a + b, 0)), 1)}</td><td class="bar-cell" style="width:220px"><div class="bar ${kind(t)}" style="width:${(100 * t.v) / maxV}%"></div></td></tr>`).join('');

  const per = sh.perEdit.map((p) => ({ ...p, e: state.edits.find((e) => e.id === p.id) }));
  const maxA = Math.max(1, ...per.map((p) => Math.abs(p.approvals)));
  const maxL = Math.max(1, ...per.map((p) => Math.abs(p.loss)));
  const attRows = per.map((p) => {
    const lpa = p.approvals > 0.5 ? p.loss / p.approvals : NaN;
    return `<tr><td>${p.e.label}</td>
      <td class="n">${p.approvals >= 0 ? '+' : '−'}${fmtInt(Math.abs(p.approvals))}</td>
      <td class="bar-cell" style="width:120px"><div class="bar in" style="width:${(100 * Math.abs(p.approvals)) / maxA}%"></div></td>
      <td class="n ${p.loss > 0 ? 'down' : 'up'}">${money(p.loss)}</td>
      <td class="bar-cell" style="width:120px"><div class="bar ${p.loss > 0 ? 'out' : 'in'}" style="width:${(100 * Math.abs(p.loss)) / maxL}%"></div></td>
      <td class="n">${isFinite(lpa) ? (lpa < 0 ? '−' : '') + '$' + fmtInt(Math.abs(lpa)) : 'n/a'}</td></tr>`;
  }).join('');
  const nMoved = Object.values(r.trans).reduce((a, b) => a + b, 0);
  return `<div class="stack">
    <div>
      <div class="sec-t">Which edit caused it (exact Shapley over ${per.length} edits)</div>
      <p class="sec-s">Each edit's average marginal effect over all ${fact(per.length)} orderings of the edits, so overlapping edits split credit fairly and the shares add up to the totals. Loss is AIPW expected 12-month loss on rows the old policy could have approved.</p>
      <table class="t"><thead><tr><th>Edit</th><th class="n">Approvals</th><th></th><th class="n">Expected loss</th><th></th><th class="n">Loss per added approval</th></tr></thead><tbody>${attRows || '<tr><td colspan="6" class="muted">No edits enabled.</td></tr>'}</tbody></table>
      <div class="note" style="margin-top:10px"><b>${fmtInt(sh.jointFlips)}</b> of ${fmtInt(sh.flips)} decision flips happen only when two or more edits ship together, so replaying one edit at a time would miss them.</div>
    </div>
    <div>
      <div class="sec-t">Where the ${fmtInt(nMoved)} changed paths go ${state.sel ? `<span class="pill">${NODE_LABEL[state.sel]}</span> <a href="#" data-clear style="font-size:12px;color:var(--muted)">show all</a>` : ''}</div>
      <p class="sec-s">Exit node in v14 vs. v15 for every applicant whose path changed: ${fmtInt(r.swapIn.length)} swap-ins (green), ${fmtInt(r.swapOut.length)} swap-outs (red), and ${fmtInt(nMoved - totalFlips)} still declined but by a different node.</p>
      <table class="t"><thead><tr><th>v14 → v15</th><th class="n">Applicants</th><th class="n">Share</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No changed paths through this node.</td></tr>'}</tbody></table>
    </div>
  </div>`;
}

const fact = (k) => (k <= 1 ? 1 : k * fact(k - 1));

function tabRisk() {
  const r = state.res;
  const items = state.edits.filter((e) => e.on).map((e) => {
    const s = state.solo[e.id];
    const tr = s.swapIn.length ? s.swapIn.filter((i) => state.est.identified[i]).reduce((a, i) => a + state.truth[i], 0) / Math.max(1, s.swapInIdentified) : NaN;
    const observed = s.swapIn.filter((i) => state.rows[i].approved).length;
    return { e, s, tr, observed };
  });
  const maxX = Math.min(1, Math.max(0.1, ...items.flatMap((it) => [it.s.swapInRateDRCI[1] || 0, it.s.swapInRateNaive || 0, state.showTruth ? it.tr || 0 : 0])) * 1.12);
  const W = 750, L = 300, RGT = 16, rowH = 50, top = 26;
  const H = top + rowH * items.length + 10;
  const x = (v) => L + ((W - L - RGT) * v) / maxX;
  const step = maxX > 0.5 ? 0.1 : maxX > 0.2 ? 0.05 : 0.02;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let t = 0; t <= maxX + 1e-9; t += step) svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 6}" stroke="#efecec"/><text x="${x(t)}" y="${top - 12}" font-size="10.5" fill="#757171" text-anchor="middle">${Math.round(t * 100)}%</text>`;
  items.forEach((it, k) => {
    const y = top + k * rowH + rowH / 2;
    const s = it.s;
    svg += `<text x="0" y="${y - 4}" font-size="12.5" font-weight="600" fill="#121212">${it.e.label}</text>
            <text x="0" y="${y + 12}" font-size="11" fill="#686565">${fmtInt(s.swapIn.length)} swap-ins · ${fmtInt(it.observed)} ever observed</text>`;
    if (s.swapInIdentified > 0) {
      svg += `<line x1="${x(s.swapInRateDRCI[0])}" x2="${x(s.swapInRateDRCI[1])}" y1="${y}" y2="${y}" stroke="#121212" stroke-width="3" stroke-linecap="round" opacity=".85"/>
              <circle cx="${x(s.swapInRateDR)}" cy="${y}" r="5.5" fill="#121212"/>`;
    }
    if (s.swapInUnidentified > 0) {
      const lo = state.est.nearCutRate;
      svg += `<rect x="${x(Math.min(lo, maxX))}" y="${y - 7}" width="${Math.max(2, x(maxX) - x(Math.min(lo, maxX)))}" height="14" rx="3" fill="url(#hatch)" stroke="#ff4d00" stroke-width="1"/>
              <text x="${x(maxX)}" y="${y + 20}" font-size="10.5" fill="#ff4d00" text-anchor="end">not identified: ≥ ${pct(lo)} under monotone risk, up to 100%</text>`;
    }
    if (isFinite(s.swapInRateNaive)) svg += `<rect x="${x(s.swapInRateNaive) - 5}" y="${y - 5}" width="10" height="10" transform="rotate(45 ${x(s.swapInRateNaive)} ${y})" fill="#fff" stroke="#ff4d00" stroke-width="2"/>`;
    if (state.showTruth && isFinite(it.tr) && s.swapInIdentified > 0) svg += `<line x1="${x(it.tr)}" x2="${x(it.tr)}" y1="${y - 11}" y2="${y + 11}" stroke="#0e9755" stroke-width="2.5"/>`;
  });
  svg += `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff6f1"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ffb999" stroke-width="2"/></pattern></defs></svg>`;

  const naiveGapRows = items.filter((it) => it.s.swapInIdentified > 0 && isFinite(it.tr));
  const worst = naiveGapRows.sort((a, b) => (a.s.swapInRateNaive - a.tr) - (b.s.swapInRateNaive - b.tr))[0];
  const unid = r.unidentified.count > 0 ? `<div class="note warnbox" style="margin-top:10px"><b>${fmtInt(r.unidentified.count)} swap-ins come from a region v14 never approved</b> (fraud-screen declines were excluded from test-below-the-cut), so no amount of reweighting identifies their loss. Impact replay reports a bound instead of a guess: ${money(r.unidentified.lo, false)} to ${money(r.unidentified.hi, false)} of extra expected loss, assuming risk does not fall as device risk rises (worst case lower bound $0). Ship it as a small randomized challenger first if you need a number.</div>` : '';
  return `<div class="sec-t">How risky are the applicants v15 newly approves?</div>
    <p class="sec-s">Their outcomes were never observed: v14 declined them. A standard backtest uses observed outcomes where they exist and scores the rest with a model fit on the booked book, which never contains DTI above 0.45 or scores below 620, so it extrapolates. Impact replay uses the logged approval propensity: the ${pct(state.meta.exploration_rate, 0)} test-below-the-cut loans are reweighted by 1/propensity in a cross-fitted, doubly robust (AIPW) estimator, which is unbiased wherever v14 could have approved. Intervals are 90% bootstrap intervals over applicants. Each row replays one edit on its own.</p>
    <div style="display:flex;gap:16px;align-items:center;margin:2px 0 6px;font-size:12px;color:#686565">
      <span><svg width="14" height="10"><circle cx="5" cy="5" r="4.5" fill="#121212"/></svg> AIPW estimate + 90% CI</span>
      <span><svg width="14" height="12"><rect x="3" y="2" width="7" height="7" transform="rotate(45 6.5 5.5)" fill="#fff" stroke="#ff4d00" stroke-width="2"/></svg> Naive backtest</span>
      <label class="chk"><input type="checkbox" id="truthChk" ${state.showTruth ? 'checked' : ''}><svg width="6" height="14"><line x1="3" x2="3" y1="0" y2="14" stroke="#0e9755" stroke-width="2.5"/></svg> Simulation ground truth (known only because the data is synthetic)</label>
    </div>
    ${svg}
    ${worst && state.showTruth ? `<div class="note" style="margin-top:8px">Largest naive miss: <b>${worst.e.label}</b>. The naive backtest says ${pct(worst.s.swapInRateNaive)} default; the simulated truth is ${pct(worst.tr)}; AIPW says ${pct(worst.s.swapInRateDR)} (90% CI ${pct(worst.s.swapInRateDRCI[0])} to ${pct(worst.s.swapInRateDRCI[1])}). The wide interval is the honest part: only ${fmtInt(worst.observed)} of these applicants were ever booked.</div>` : ''}
    ${unid}`;
}

function tabFair() {
  const r = state.res;
  const order = ['18-24', '25-61', '62+'];
  const f = order.map((g) => r.fairness.find((x) => x.group === g));
  const W = 330, H = 200, L = 40, top = 16, bw = 28;
  const y = (v) => top + (H - top - 28) * (1 - v);
  let svg = `<svg width="${W}" height="${H}">`;
  for (let t = 0; t <= 1.0001; t += 0.25) svg += `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#efecec"/><text x="${L - 6}" y="${y(t) + 3}" font-size="10.5" fill="#757171" text-anchor="end">${t * 100}%</text>`;
  f.forEach((g, k) => {
    const cx = L + 18 + k * 92;
    svg += `<rect x="${cx}" y="${y(g.baseRate)}" width="${bw}" height="${y(0) - y(g.baseRate)}" rx="3" fill="#e2dddd"/>
            <rect x="${cx + bw + 4}" y="${y(g.candRate)}" width="${bw}" height="${y(0) - y(g.candRate)}" rx="3" fill="#121212"/>
            <text x="${cx + bw / 2}" y="${y(g.baseRate) - 4}" font-size="10.5" text-anchor="middle" fill="#686565">${pct(g.baseRate, 0)}</text>
            <text x="${cx + bw * 1.5 + 4}" y="${y(g.candRate) - 4}" font-size="10.5" text-anchor="middle" fill="#121212" font-weight="600">${pct(g.candRate, 0)}</text>
            <text x="${cx + bw + 2}" y="${H - 8}" font-size="11.5" text-anchor="middle" fill="#353232">Age ${g.group}</text>`;
  });
  svg += `</svg>`;
  const rows = f.map((g) => {
    const flag = (v) => (g.group === '25-61' ? '' : v < 0.8 ? '<div><span class="pill" style="background:#fce2e2;color:#a84a3e">below 0.80</span></div>' : '');
    return `<tr><td style="white-space:nowrap">Age ${g.group}${g.group === '25-61' ? '<div class="muted">reference</div>' : ''}</td><td class="n">${fmtInt(g.n)}</td>
      <td class="n">${g.baseAir.toFixed(3)}${flag(g.baseAir)}</td><td class="n"><b>${g.candAir.toFixed(3)}</b>${flag(g.candAir)}</td>
      <td class="n">${g.group === '25-61' ? 'n/a' : `${(g.candAir - g.baseAir >= 0 ? '+' : '−') + Math.abs(g.candAir - g.baseAir).toFixed(3)}<div class="muted">[${g.airDeltaCI[0].toFixed(3)}, ${g.airDeltaCI[1].toFixed(3)}]</div>`}</td></tr>`;
  }).join('');
  const young = f[0];
  return `<div class="two" style="grid-template-columns: 335px minmax(0, 1fr)">
    <div><div class="sec-t">Approval rate by age band</div><p class="sec-s"><span style="display:inline-block;width:9px;height:9px;background:#e2dddd;border-radius:2px"></span> v14 &nbsp; <span style="display:inline-block;width:9px;height:9px;background:#121212;border-radius:2px"></span> v15 draft</p>${svg}</div>
    <div><div class="sec-t">Adverse impact ratio (approval rate vs. reference group)</div>
      <p class="sec-s">The four-fifths rule flags ratios below 0.80. Brackets are 90% bootstrap intervals for the change, so a shift is only called when it clears sampling noise.</p>
      <table class="t"><thead><tr><th>Group</th><th class="n">Applicants</th><th class="n">AIR v14</th><th class="n">AIR v15</th><th class="n">Change</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note" style="margin-top:10px">${young.baseAir < 0.8 && young.candAir >= 0.8 ? `v15 lifts the 18-24 ratio from <b>${young.baseAir.toFixed(2)}</b> to <b>${young.candAir.toFixed(2)}</b>, clearing the four-fifths line. Use the toggles: the thin-file route edit drives most of it, because young applicants are far more often thin-file and v14 judged them on a bureau score that carries little signal for them.` : `18-24 ratio moves from <b>${young.baseAir.toFixed(2)}</b> to <b>${young.candAir.toFixed(2)}</b>. Toggle edits to see which one moves it.`} Age is used as an example protected attribute present in application data; a lender would plug in its own fair-lending groups.</div>
    </div></div>`;
}

function tabSeg() {
  const keys = [['product', 'Product'], ['channel', 'Channel'], ['score_band', 'Bureau score band'], ['thin_label', 'File depth']];
  const segs = R.segments(state.rows, state.est, state.res, state.segKey, { lgd: state.meta.lgd });
  if (state.segKey === 'score_band') { const o = ['Under 600', '600-619', '620-679', '680-739', '740+']; segs.sort((a, b) => o.indexOf(a.segment) - o.indexOf(b.segment)); }
  else segs.sort((a, b) => b.n - a.n);
  const maxAbs = Math.max(1, ...segs.map((s) => Math.abs(s.elDelta)));
  const rows = segs.map((s) => `<tr><td>${s.segment}</td><td class="n">${fmtInt(s.n)}</td><td class="n">${pct(s.baseRate)} → <b>${pct(s.candRate)}</b></td><td class="n ${s.candRate >= s.baseRate ? 'up' : 'down'}">${pp(s.candRate - s.baseRate)}</td>
    <td class="n">${fmtInt(s.swapIn)}</td><td class="n">${fmtInt(s.swapOut)}</td><td class="n ${s.elDelta > 0 ? 'down' : 'up'}">${money(s.elDelta)}${s.unidentified ? ` <span class="pill" style="color:#ff4d00">+${s.unidentified} unidentified</span>` : ''}</td>
    <td class="bar-cell" style="width:90px"><div class="bar ${s.elDelta > 0 ? 'out' : 'in'}" style="width:${(100 * Math.abs(s.elDelta)) / maxAbs}%"></div></td></tr>`).join('');
  return `<div style="display:flex;justify-content:space-between;align-items:center"><div class="sec-t">Impact by segment</div>
    <div style="display:flex;gap:6px">${keys.map(([k, l]) => `<button class="btn ${state.segKey === k ? 'active' : ''}" data-seg="${k}" style="padding:4px 10px;font-size:12px">${l}</button>`).join('')}</div></div>
    <p class="sec-s">Expected 12-month loss change uses observed outcomes for swap-outs and AIPW estimates for swap-ins (LGD ${Math.round(state.meta.lgd * 100)}%).</p>
    <table class="t"><thead><tr><th>Segment</th><th class="n">Applicants</th><th class="n">Approval v14 → v15</th><th class="n">Change</th><th class="n">Swap-ins</th><th class="n">Swap-outs</th><th class="n">Exp. loss change</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

load().catch((err) => { $('subline').textContent = 'Failed to load data: ' + err.message; console.error(err); });
