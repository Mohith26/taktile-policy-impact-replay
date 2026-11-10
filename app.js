import * as R from './core/replay.js';

// Presentation layer styled after Taktile's production app shell. All numbers come from core/replay.js.
const $ = (id) => document.getElementById(id);
const fmtInt = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + '%' : 'n/a');
const pp = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + ' pp';
const money = (x, sign = true) => {
  const s = x < 0 ? '−' : sign ? '+' : '';
  const a = Math.abs(x);
  return s + (a >= 1e6 ? '$' + (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'K' : '$' + Math.round(a));
};
const icons = () => window.lucide && window.lucide.createIcons();
const NODE_LABEL = Object.fromEntries(R.CHAMPION.nodes.map((n) => [n.id, n.label]));
NODE_LABEL.approve = 'Approve';
const EDIT_NAME = { afford: 'Affordability cut', bureau: 'Bureau cutoff', thin: 'Thin-file cash-flow route', pd: 'PD model threshold', fraud: 'Fraud screen' };
const NODE_ICON = { Rule: 'shuffle', Split: 'split', Model: 'brain-circuit' };
const C = { blue: '#5b86e5', orange: '#ea8444', green: '#8fe0bb', axis: '#353232', muted: '#686565', faint: '#9a9797', grid: '#f0f0f0', track: '#f3f2f2', ink: '#0b0a0a', truth: '#3a926e', light: '#c4dbf7' };

const state = {
  rows: null, est: null, truth: null, meta: null,
  edits: R.DEFAULT_EDITS.map((e) => ({ ...e, set: { ...e.set }, on: e.id !== 'fraud' })),
  sel: null, tab: 'overview', showTruth: true, segKey: 'product',
  res: null, sh: null, solo: {}, ms: 0,
};

const activeEdits = () => state.edits.filter((e) => e.on).map((e) => ({ id: e.id, node: e.node, set: { ...e.set } }));

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
  state.booked = state.rows.reduce((a, r) => a + r.approved, 0);
  state.explored = state.rows.reduce((a, r) => a + r.exploration, 0);
  const h = new URLSearchParams(location.hash.slice(1)); // deep links: #tab=risk&on=fraud&sel=thin
  if (h.get('tab')) state.tab = h.get('tab');
  if (h.get('sel')) state.sel = h.get('sel');
  for (const id of (h.get('on') || '').split(',').filter(Boolean)) { const e = state.edits.find((x) => x.id === id); if (e) e.on = true; }
  for (const id of (h.get('off') || '').split(',').filter(Boolean)) { const e = state.edits.find((x) => x.id === id); if (e) e.on = false; }
  recompute();
}

function recompute() {
  const t0 = performance.now();
  const edits = activeEdits();
  state.res = R.replay(state.rows, state.est, R.CHAMPION, edits, { lgd: state.meta.lgd, B: 300 });
  state.sh = R.shapley(state.rows, state.est, R.CHAMPION, edits, { lgd: state.meta.lgd });
  state.solo = {};
  for (const e of edits) state.solo[e.id] = R.replay(state.rows, state.est, R.CHAMPION, [e], { lgd: state.meta.lgd, B: 200, seed: 11 });
  state.ms = Math.round(performance.now() - t0);
  render();
}

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  const fn = { overview: viewOverview, risk: viewRisk, fair: viewFair, seg: viewSeg }[state.tab] || viewOverview;
  const scroll = $('content').scrollTop;
  $('content').innerHTML = intro() + fn();
  $('content').scrollTop = scroll;
  wire();
  icons();
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
$('rerun').addEventListener('click', () => recompute());

function intro() {
  const n = activeEdits().length;
  return `<div class="intro"><span>${fmtInt(state.rows.length)} historical applications replayed through v14 and v15 (${n} edit${n === 1 ? '' : 's'}) · ${fmtInt(state.booked)} booked with 12-month outcomes, ${fmtInt(state.explored)} via the ${pct(state.meta.exploration_rate, 0)} test-below-the-cut program</span>
    <span class="chip-ok"><i data-lucide="check"></i>${state.ms > 0 ? `Replayed in ${state.ms} ms` : 'Replay complete'}</span></div>`;
}

const cardHead = (t, s = '') => `<div class="card-h"><div><div class="card-t">${t}</div>${s ? `<div class="card-s">${s}</div>` : ''}</div><div class="card-acts"><i data-lucide="sparkle"></i><i data-lucide="ellipsis-vertical"></i></div></div>`;

// ---------------- overview ----------------
function kpis() {
  const r = state.res, sh = state.sh;
  const unid = r.unidentified.count > 0;
  return `<div class="grid4">
    <div class="card kpi">${cardHead('Approval rate')}
      <div class="kpi-pair"><div><div class="kpi-lab">v14 (Published)</div><div class="kpi-num">${pct(r.baseApprRate)}</div></div>
      <div><div class="kpi-lab">v15 (Draft)</div><div class="kpi-num">${pct(r.candApprRate)}</div></div></div>
      <div class="kpi-foot"><b class="${r.candApprRate >= r.baseApprRate ? 'pos' : 'neg'}">${pp(r.candApprRate - r.baseApprRate)}</b> on ${fmtInt(r.n)} replayed applications</div></div>
    <div class="card kpi">${cardHead('Decision flips')}
      <div class="kpi-pair"><div><div class="kpi-lab">Swap-ins</div><div class="kpi-num">${fmtInt(r.swapIn.length)}</div></div>
      <div><div class="kpi-lab">Swap-outs</div><div class="kpi-num">${fmtInt(r.swapOut.length)}</div></div></div>
      <div class="kpi-foot"><b>${fmtInt(sh.jointFlips)}</b> only flip when 2+ edits ship together</div></div>
    <div class="card kpi">${cardHead('Expected 12-mo loss change')}
      <div class="kpi-lab">AIPW estimate</div><div class="kpi-num ${r.elDelta > 0 ? 'neg' : 'pos'}">${money(r.elDelta)}</div>
      <div class="kpi-foot">90% CI ${money(r.elDeltaCI[0])} to ${money(r.elDeltaCI[1])}${unid ? `<br><span class="warn">plus ${money(r.unidentified.lo, false)} to ${money(r.unidentified.hi, false)} not identified</span>` : ''}</div></div>
    <div class="card kpi">${cardHead('Swap-in default rate')}
      <div class="kpi-pair"><div><div class="kpi-lab">Naive backtest</div><div class="kpi-num" style="color:${C.muted}">${pct(r.swapInRateNaive)}</div></div>
      <div><div class="kpi-lab">AIPW</div><div class="kpi-num">${pct(r.swapInRateDR)}</div></div></div>
      <div class="kpi-foot">90% CI ${pct(r.swapInRateDRCI[0])} to ${pct(r.swapInRateDRCI[1])}${unid ? ` · identified swap-ins only (${fmtInt(r.swapInIdentified)})` : ''}</div></div>
  </div>`;
}

const fmtV = (id, v) => (id === 'bureau' ? String(v) : (+v).toFixed(2));
function condChips(node, base) {
  const chip = (f) => `<span class="code"><span class="p">data.</span><span class="f">${f}</span></span>`;
  if (node.id === 'thin') {
    const changed = node.mode !== base.mode || node.cvMax !== base.cvMax;
    if (node.mode === 'cashflow') return `${chip('thin_file')}<span class="op">and</span>${chip('cashflow_vol')}<span class="op">&gt;</span><span class="val ${changed ? 'new' : ''}">${node.cvMax.toFixed(2)}</span>${changed && base.mode === 'score' ? `<span class="val old">bureau_score &lt; ${base.scoreMin}</span>` : ''}`;
    return `${chip('thin_file')}<span class="op">and</span>${chip('bureau_score')}<span class="op">&lt;</span><span class="val">${node.scoreMin}</span>`;
  }
  const changed = node.value !== base.value;
  return `${chip(node.field)}<span class="op">${node.op === '>' ? '&gt;' : '&lt;'}</span>${changed ? `<span class="val old">${fmtV(node.id, base.value)}</span><span class="val new">${fmtV(node.id, node.value)}</span>` : `<span class="val">${fmtV(node.id, node.value)}</span>`}`;
}

function canvasCard() {
  const r = state.res;
  let h = `<div class="canvas"><div class="cv-col"><span class="cv-start"><i data-lucide="play"></i>Input <span class="muted">· ${fmtInt(r.n)} applications</span></span>`;
  for (const node of r.cand.nodes) {
    const base = R.CHAMPION.nodes.find((n) => n.id === node.id);
    const st = r.nodeStats[node.id];
    const edited = JSON.stringify(base) !== JSON.stringify(node);
    const d = st.candDeclines - st.baseDeclines;
    const badges = [];
    if (st.swapInFrom) badges.push(`<span class="tag in">+${fmtInt(st.swapInFrom)} swap-ins</span>`);
    if (st.swapOutTo) badges.push(`<span class="tag out">${fmtInt(st.swapOutTo)} swap-outs</span>`);
    h += `<div class="cv-edge"></div><div class="cv-line">
      <div class="tnode ${state.sel === node.id ? 'sel' : ''}" data-node="${node.id}" title="${node.id === 'thin' ? (node.mode === 'cashflow' ? 'thin_file and cashflow_vol > ' + node.cvMax.toFixed(2) : 'thin_file and bureau_score < ' + node.scoreMin) : node.field + ' ' + node.op + ' ' + fmtV(node.id, node.value)}">
        <div class="ticon ${node.kind}"><i data-lucide="${NODE_ICON[node.kind]}"></i></div>
        <div><div class="tkind">${node.kind}</div><div class="ttitle">${node.label}</div></div>
        ${edited ? '<span class="tedited"><span class="dot draft"></span>Edited</span>' : ''}
      </div>
      <div class="cv-branch"><div class="cv-h"></div><span class="pill"><b>Decline · ${fmtInt(st.candDeclines)}</b><span class="sub">${d === 0 ? 'unchanged' : `was ${fmtInt(st.baseDeclines)} (${d > 0 ? '+' : '−'}${fmtInt(Math.abs(d))})`}</span></span></div>
    </div>${badges.length ? `<div class="tbadges-out">${badges.join('')}</div>` : ''}`;
  }
  h += `<div class="cv-edge"></div><div class="tnode" style="cursor:default"><div class="ticon Outcome"><i data-lucide="flag"></i></div><div><div class="tkind">Outcome · was ${fmtInt(r.baseApprN)}</div><div class="ttitle">Approve · ${fmtInt(r.candApprN)}</div></div></div>`;
  h += `</div></div>`;
  return `<div class="card" style="padding:16px">${cardHead('Decision flow · v15 draft', 'Edited nodes are marked. Click a node to filter its changed paths.')}${h}</div>`;
}

function fmtParam(e, v) {
  const f = e.param.fmt;
  return f === 'int' ? String(v) : f === 'pct' ? (+v).toFixed(3).replace(/0$/, '') : (+v).toFixed(2);
}
function baseParam(e) {
  const b = R.CHAMPION.nodes.find((n) => n.id === e.node);
  if (e.id === 'thin') return 'score ≥ ' + b.scoreMin;
  return fmtParam(e, b[e.param.key]);
}

function editsCard() {
  const shBy = Object.fromEntries(state.sh.perEdit.map((p) => [p.id, p]));
  const rows = state.edits.map((e) => {
    const v = e.set[e.param.key];
    const s = shBy[e.id];
    const unidMostly = s && s.approvals > 0.5 && s.unidentified / s.approvals > 0.5;
    return `<tr class="${e.on ? '' : 'off'}" data-id="${e.id}">
      <td style="width:36px"><button class="sw ${e.on ? 'on' : ''}" data-act="toggle" aria-label="toggle ${e.label}"></button></td>
      <td><div class="ename">${EDIT_NAME[e.id]}</div><div class="enode">${NODE_LABEL[e.node]}</div></td>
      <td><span class="bav"><span class="tag before">${baseParam(e)}</span><i data-lucide="arrow-right" style="width:12px;height:12px;color:${C.faint}"></i><span class="tag after" data-val>${e.id === 'thin' ? 'σ ≤ ' : ''}${fmtParam(e, v)}</span></span></td>
      <td><input type="range" min="${e.param.min}" max="${e.param.max}" step="${e.param.step}" value="${v}" ${e.on ? '' : 'disabled'} data-act="slide"></td>
      <td class="n">${s ? `${s.approvals >= 0 ? '+' : '−'}${fmtInt(Math.abs(s.approvals))}` : '<span style="color:#9a9797">off</span>'}</td>
      <td class="n">${s ? (unidMostly ? '<span class="tag warnt">not identified</span>' : `<span class="${s.loss > 0 ? 'neg' : 'pos'}">${money(s.loss)}</span>`) : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="card">${cardHead('Changes in v15 draft', 'Toggle or drag to re-run the replay. Approvals and loss are each edit\'s exact Shapley share.')}
    <table class="tbl"><thead><tr><th></th><th>Edit</th><th>Before → After</th><th>Adjust</th><th class="n">Approvals</th><th class="n">Exp. loss</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function pathsCard() {
  const r = state.res;
  let trans = Object.entries(r.trans).map(([k, v]) => { const [a, b] = k.split('>'); return { a, b, v }; });
  if (state.sel) trans = trans.filter((t) => t.a === state.sel || t.b === state.sel);
  trans.sort((x, y) => y.v - x.v);
  const total = Object.values(r.trans).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...trans.map((t) => t.v));
  const name = (id) => (id === 'approve' ? 'Approved' : NODE_LABEL[id]);
  const rows = trans.slice(0, 10).map((t) => {
    const cls = t.b === 'approve' ? '' : t.a === 'approve' ? 'o' : 'l';
    return `<div class="lab">${name(t.a)} → ${name(t.b)}</div><div class="trk"><div class="fill ${cls}" style="width:${(100 * t.v) / max}%"></div></div><div class="v">${fmtInt(t.v)} <small>(${pct(t.v / total)})</small></div>`;
  }).join('');
  return `<div class="card">${cardHead('Where changed paths go' + (state.sel ? ` · ${NODE_LABEL[state.sel]}` : ''), `Exit node in v14 → exit node in v15 for the ${fmtInt(total)} applicants whose path changed${state.sel ? ` · <a class="lnk" data-clear>Show all</a>` : ''}`)}
    <div class="hb">${rows || '<div class="lab"></div><div style="color:#686565">No changed paths through this node.</div><div></div>'}</div>
    <div class="legend"><span><i style="background:${C.blue}"></i>Swap-in (declined → approved)</span><span><i style="background:${C.orange}"></i>Swap-out</span><span><i style="background:#9ab4e7"></i>Still declined, different node</span></div></div>`;
}

function viewOverview() {
  return kpis() + `<div class="row" style="grid-template-columns: 450px minmax(0, 1fr)">${canvasCard()}<div class="stack">${editsCard()}${pathsCard()}</div></div>`;
}

// ---------------- swap-in risk ----------------
function viewRisk() {
  const r = state.res;
  const items = state.edits.filter((e) => e.on).map((e) => {
    const s = state.solo[e.id];
    const tr = s.swapInIdentified ? s.swapIn.filter((i) => state.est.identified[i]).reduce((a, i) => a + state.truth[i], 0) / s.swapInIdentified : NaN;
    const observed = s.swapIn.filter((i) => state.rows[i].approved).length;
    return { e, s, tr, observed };
  });
  const maxX = Math.min(1, Math.max(0.1, ...items.flatMap((it) => [it.s.swapInRateDRCI[1] || 0, it.s.swapInRateNaive || 0, state.showTruth ? it.tr || 0 : 0])) * 1.12);
  const W = 1060, L = 290, RG = 20, rowH = 54, top = 14;
  const H = top + rowH * items.length + 34;
  const x = (v) => L + ((W - L - RG) * v) / maxX;
  const step = maxX > 0.5 ? 0.1 : maxX > 0.2 ? 0.05 : 0.02;
  let svg = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">`;
  for (let t = 0; t <= maxX + 1e-9; t += step) svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 30}" stroke="${C.grid}"/><text x="${x(t)}" y="${H - 14}" font-size="11" fill="${C.axis}" text-anchor="middle">${Math.round(t * 100)}%</text>`;
  items.forEach((it, k) => {
    const y = top + k * rowH + rowH / 2;
    const s = it.s;
    svg += `<text x="${L - 16}" y="${y - 3}" font-size="12.5" fill="${C.ink}" text-anchor="end">${EDIT_NAME[it.e.id]}</text>
            <text x="${L - 16}" y="${y + 13}" font-size="11" fill="${C.muted}" text-anchor="end">${fmtInt(s.swapIn.length)} swap-ins · ${fmtInt(it.observed)} ever observed</text>
            <rect x="${L}" y="${y - 9}" width="${W - L - RG}" height="18" fill="${C.track}" opacity=".55"/>`;
    if (s.swapInIdentified > 0) svg += `<rect x="${x(s.swapInRateDRCI[0])}" y="${y - 4}" width="${Math.max(2, x(s.swapInRateDRCI[1]) - x(s.swapInRateDRCI[0]))}" height="8" rx="1" fill="${C.light}"/><circle cx="${x(s.swapInRateDR)}" cy="${y}" r="5" fill="${C.blue}"/>`;
    if (s.swapInUnidentified > 0) {
      const lo = state.est.nearCutRate;
      svg += `<rect x="${x(Math.min(lo, maxX))}" y="${y - 6}" width="${Math.max(2, x(maxX) - x(Math.min(lo, maxX)))}" height="12" fill="url(#hatch)"/>
              <text x="${x(maxX) - 4}" y="${y + 21}" font-size="10.5" fill="#b4502f" text-anchor="end">not identified: ≥ ${pct(lo)} under monotone risk, up to 100%</text>`;
    }
    if (isFinite(s.swapInRateNaive)) svg += `<rect x="${x(s.swapInRateNaive) - 4.5}" y="${y - 4.5}" width="9" height="9" transform="rotate(45 ${x(s.swapInRateNaive)} ${y})" fill="#fff" stroke="${C.orange}" stroke-width="2"/>`;
    if (state.showTruth && isFinite(it.tr) && s.swapInIdentified > 0) svg += `<line x1="${x(it.tr)}" x2="${x(it.tr)}" y1="${y - 10}" y2="${y + 10}" stroke="${C.truth}" stroke-width="2"/>`;
  });
  svg += `<text x="${(L + W - RG) / 2}" y="${H - 1}" font-size="11" fill="${C.axis}" text-anchor="middle">Default rate of swap-ins (12 months)</text>`;
  svg += `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fceeda"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ed9a5c" stroke-width="2"/></pattern></defs></svg>`;
  const ranked = items.filter((it) => it.s.swapInIdentified > 0 && isFinite(it.tr)).sort((a, b) => (a.s.swapInRateNaive - a.tr) - (b.s.swapInRateNaive - b.tr));
  const worst = ranked[0];
  const unid = r.unidentified.count > 0 ? `<div class="note warnbox"><b>${fmtInt(r.unidentified.count)} swap-ins come from a region v14 never approved</b> (fraud-screen declines were excluded from test-below-the-cut), so no reweighting can identify their loss. Impact replay reports a bound instead of a guess: ${money(r.unidentified.lo, false)} to ${money(r.unidentified.hi, false)} of extra expected loss, assuming risk does not fall as device risk rises (worst-case lower bound $0). Route a small randomized share to v15 first if you need a number.</div>` : '';
  return `<div class="card">${cardHead('Swap-in default rate by edit', `Applicants v15 approves that v14 declined have no observed outcomes. AIPW reweights the ${pct(state.meta.exploration_rate, 0)} test-below-the-cut loans by 1/propensity (cross-fitted, doubly robust); intervals are 90% bootstrap over applicants. Each row replays one edit on its own.`)}
    ${svg}
    <div class="legend"><span><i style="background:${C.blue}"></i>AIPW estimate</span><span><i style="background:${C.light};border-radius:1px;width:14px;height:6px"></i>90% interval</span><span><i style="background:#fff;border:2px solid ${C.orange};border-radius:1px;transform:rotate(45deg);width:7px;height:7px"></i>Naive backtest (model fit on booked loans)</span>
      <label class="chk"><input type="checkbox" id="truthChk" ${state.showTruth ? 'checked' : ''}><i style="background:${C.truth};border-radius:0;width:2px;height:12px"></i>Simulation ground truth (synthetic data only)</label></div>
    ${worst && state.showTruth ? `<div class="note">Largest naive miss: <b>${EDIT_NAME[worst.e.id]}</b>. The naive backtest says ${pct(worst.s.swapInRateNaive)}; the simulated truth is ${pct(worst.tr)}; AIPW says ${pct(worst.s.swapInRateDR)} (90% CI ${pct(worst.s.swapInRateDRCI[0])} to ${pct(worst.s.swapInRateDRCI[1])}). The wide interval is the honest part: only ${fmtInt(worst.observed)} of these applicants were ever booked.</div>` : ''}
    ${unid}</div>`;
}

// ---------------- fairness ----------------
function viewFair() {
  const r = state.res;
  const f = ['18-24', '25-61', '62+'].map((g) => r.fairness.find((x) => x.group === g));
  const W = 520, H = 280, L = 44, B = 40, top = 14, bw = 46;
  const y = (v) => top + (H - top - B) * (1 - v);
  let svg = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">`;
  for (let t = 0; t <= 1.0001; t += 0.25) svg += `<text x="${L - 10}" y="${y(t) + 4}" font-size="11" fill="${C.axis}" text-anchor="end">${t * 100}%</text>`;
  svg += `<line x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="${C.grid}"/>`;
  f.forEach((g, k) => {
    const cx = L + 50 + k * 150;
    svg += `<rect x="${cx}" y="${y(g.baseRate)}" width="${bw}" height="${y(0) - y(g.baseRate)}" fill="${C.light}"/>
      <rect x="${cx + bw + 6}" y="${y(g.candRate)}" width="${bw}" height="${y(0) - y(g.candRate)}" fill="${C.blue}"/>
      <text x="${cx + bw / 2}" y="${y(g.baseRate) - 6}" font-size="11" text-anchor="middle" fill="${C.muted}">${pct(g.baseRate, 0)}</text>
      <text x="${cx + bw * 1.5 + 6}" y="${y(g.candRate) - 6}" font-size="11" text-anchor="middle" fill="${C.ink}">${pct(g.candRate, 0)}</text>
      <text x="${cx + bw + 3}" y="${H - 18}" font-size="11" text-anchor="middle" fill="${C.axis}">${g.group}</text>`;
  });
  svg += `<text x="${(L + W) / 2}" y="${H - 2}" font-size="11" fill="${C.axis}" text-anchor="middle">Age band</text></svg>`;
  const rows = f.map((g) => {
    const flag = (v) => (g.group !== '25-61' && v < 0.8 ? ' <span class="tag out">below 0.80</span>' : '');
    return `<tr><td>${g.group}${g.group === '25-61' ? ' <span class="tag gray">reference</span>' : ''}</td><td class="n">${fmtInt(g.n)}</td><td class="n">${g.baseAir.toFixed(3)}${flag(g.baseAir)}</td><td class="n"><b style="font-weight:500">${g.candAir.toFixed(3)}</b>${flag(g.candAir)}</td>
      <td class="n">${g.group === '25-61' ? '<span style="color:#9a9797">n/a</span>' : `${(g.candAir - g.baseAir >= 0 ? '+' : '−') + Math.abs(g.candAir - g.baseAir).toFixed(3)} <span style="color:${C.muted}">[${g.airDeltaCI[0].toFixed(3)}, ${g.airDeltaCI[1].toFixed(3)}]</span>`}</td></tr>`;
  }).join('');
  const young = f[0];
  return `<div class="row" style="grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)">
    <div class="card">${cardHead('Approval rate by age band')}${svg}
      <div class="legend"><span><i style="background:${C.light}"></i>v14 (Published)</span><span><i style="background:${C.blue}"></i>v15 (Draft)</span></div></div>
    <div class="card">${cardHead('Adverse impact ratio', 'Approval rate relative to the reference group. Four-fifths rule flags ratios below 0.80; brackets are 90% bootstrap intervals for the change.')}
      <table class="tbl"><thead><tr><th>Age band</th><th class="n">Applicants</th><th class="n">v14</th><th class="n">v15</th><th class="n">Change [90% CI]</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note">${young.baseAir < 0.8 && young.candAir >= 0.8 ? `v15 lifts the 18-24 ratio from <b>${young.baseAir.toFixed(2)}</b> to <b>${young.candAir.toFixed(2)}</b>, clearing the four-fifths line. The thin-file route edit drives most of it: young applicants are far more often thin-file, and v14 judged them on a bureau score that carries little signal for them.` : `18-24 ratio moves from <b>${young.baseAir.toFixed(2)}</b> to <b>${young.candAir.toFixed(2)}</b>. Toggle edits on the Overview tab to see which one moves it.`} Age is an example protected attribute; a lender would use its own fair-lending groups.</div></div>
  </div>`;
}

// ---------------- segments ----------------
function viewSeg() {
  const keys = [['product', 'Product'], ['channel', 'Channel'], ['score_band', 'Bureau score band'], ['thin_label', 'File depth']];
  const segs = R.segments(state.rows, state.est, state.res, state.segKey, { lgd: state.meta.lgd });
  if (state.segKey === 'score_band') { const o = ['Under 600', '600-619', '620-679', '680-739', '740+']; segs.sort((a, b) => o.indexOf(a.segment) - o.indexOf(b.segment)); } else segs.sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...segs.map((s) => Math.abs(s.elDelta)));
  const rows = segs.map((s) => `<tr><td>${s.segment}</td><td class="n">${fmtInt(s.n)}</td><td class="n">${pct(s.baseRate)} → <b style="font-weight:500">${pct(s.candRate)}</b></td><td class="n ${s.candRate >= s.baseRate ? 'pos' : 'neg'}">${pp(s.candRate - s.baseRate)}</td>
    <td class="n">${fmtInt(s.swapIn)}</td><td class="n">${fmtInt(s.swapOut)}</td><td class="n ${s.elDelta > 0 ? 'neg' : 'pos'}">${money(s.elDelta)}${s.unidentified ? ` <span class="tag warnt">+${s.unidentified} unidentified</span>` : ''}</td>
    <td style="width:220px"><div style="height:14px;background:${C.track};position:relative"><div style="position:absolute;left:0;top:0;bottom:0;width:${(100 * Math.abs(s.elDelta)) / max}%;background:${s.elDelta > 0 ? C.orange : C.blue}"></div></div></td></tr>`).join('');
  return `<div class="card"><div class="card-h"><div><div class="card-t">Impact by segment</div><div class="card-s">Expected 12-month loss change: observed outcomes for swap-outs, AIPW estimates for swap-ins (LGD ${Math.round(state.meta.lgd * 100)}%).</div></div>
      <div class="seg-btns">${keys.map(([k, l]) => `<button data-seg="${k}" class="${state.segKey === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <table class="tbl"><thead><tr><th>Segment</th><th class="n">Applicants</th><th class="n">Approval v14 → v15</th><th class="n">Change</th><th class="n">Swap-ins</th><th class="n">Swap-outs</th><th class="n">Exp. loss change</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------- interactions ----------------
function wire() {
  document.querySelectorAll('.tnode[data-node]').forEach((el) => el.addEventListener('click', () => { state.sel = state.sel === el.dataset.node ? null : el.dataset.node; render(); }));
  document.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('click', () => { state.sel = null; render(); }));
  document.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => { state.segKey = b.dataset.seg; render(); }));
  const tc = $('truthChk');
  if (tc) tc.addEventListener('change', () => { state.showTruth = tc.checked; render(); });
  let timer = null;
  document.querySelectorAll('tr[data-id]').forEach((row) => {
    const e = state.edits.find((x) => x.id === row.dataset.id);
    row.querySelector('[data-act=toggle]').addEventListener('click', () => { e.on = !e.on; recompute(); });
    const sl = row.querySelector('[data-act=slide]');
    sl.addEventListener('input', () => {
      e.set[e.param.key] = +sl.value;
      row.querySelector('[data-val]').textContent = (e.id === 'thin' ? 'σ ≤ ' : '') + fmtParam(e, +sl.value);
      clearTimeout(timer); timer = setTimeout(recompute, 200);
    });
  });
}

load().catch((err) => { $('content').textContent = 'Failed to load data: ' + err.message; console.error(err); });
