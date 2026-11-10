// Seeded synthetic lending history for the Policy Impact Replay demo.
// Usage: node scripts/generate.mjs [n=30000] [seed=20250630]
// Writes data/applications.json (what a lender would actually have) and
// data/truth.json (the true default probability per row, known only because
// the data is simulated; the estimator never reads it).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAMPION, runFlow, EXPLORATION_RATE } from '../core/replay.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

export function generate(n = 40000, seed = 20250630) {
  const rnd = mulberry32(seed);
  const normal = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pick = (items, weights) => {
    const u = rnd();
    let c = 0;
    for (let i = 0; i < items.length; i++) { c += weights[i]; if (u < c) return items[i]; }
    return items[items.length - 1];
  };

  const PRODUCTS = ['Personal loan', 'Debt consolidation', 'Credit builder'];
  const CHANNELS = ['Direct', 'Partner', 'Paid search'];
  const AGE = ['18-24', '25-61', '62+'];
  const months = ['2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];

  const cols = { month: [], product: [], channel: [], age_band: [], bureau_score: [], thin_file: [], dti: [], cashflow_vol: [], device_risk: [], pd_model: [], amount: [], approved: [], propensity: [], exploration: [], defaulted: [], loss: [] };
  const truth = [];
  const LGD = 0.65;

  for (let i = 0; i < n; i++) {
    const age = pick(AGE, [0.22, 0.66, 0.12]);
    const product = pick(PRODUCTS, [0.5, 0.32, 0.18]);
    const channel = pick(CHANNELS, [0.45, 0.33, 0.22]);
    const z = normal() + (channel === 'Paid search' ? 0.25 : 0) + (product === 'Credit builder' ? 0.3 : 0); // latent risk
    const thinP = age === '18-24' ? 0.38 : age === '62+' ? 0.08 : 0.1;
    const thin = rnd() < thinP ? 1 : 0;
    // Thin-file bureau scores are lower and much less informative; age itself carries no risk.
    const score = thin ? clip(Math.round(648 - 18 * z + 42 * normal()), 480, 850)
                       : clip(Math.round(686 - 52 * z + 24 * normal()), 480, 850);
    const dti = clip(0.3 + 0.055 * z + 0.085 * normal(), 0.02, 0.8);
    const cv = Math.exp(-0.95 + 0.38 * z + 0.33 * normal()); // open-banking cash-flow volatility
    const fraudRing = rnd() < 0.025;
    const device = clip(fraudRing ? 0.72 + 0.25 * rnd() : 0.05 + 0.75 * Math.pow(rnd(), 1.7), 0, 1);
    // In-house PD model: decent but does not know the affordability cliff above DTI 0.44.
    const pdModel = sigmoid(-3.05 + 0.8 * (z + 0.55 * normal()) + 1.8 * (dti - 0.3));
    const amount = Math.round((product === 'Credit builder' ? 1500 + 2500 * rnd() : product === 'Debt consolidation' ? 6000 + 18000 * rnd() : 2000 + 13000 * rnd()) / 50) * 50;

    // True default probability (hidden). Nonlinear affordability cliff, thin-file risk driven by cash flow, fraud loss.
    // Risk accelerates just past both historical cuts (the classic reject-inference trap):
    // the regularly-booked book never sees DTI > 0.45 or scores < 620, so a model fit on it
    // extrapolates the gentle slope it saw.
    let logit = -3.05 + 0.95 * z + 1.6 * (dti - 0.3) + 20 * Math.max(0, dti - 0.45) + (thin ? 0 : 0.03 * Math.max(0, 622 - score));
    if (thin) logit += 1.5 * (Math.log(cv) - Math.log(0.42));
    if (fraudRing) logit += 2.6;
    const pTrue = sigmoid(logit);

    const row = { bureau_score: score, thin_file: thin, dti: r3(dti), cashflow_vol: r3(cv), device_risk: r3(device), pd_model: r3(pdModel) };
    const champ = runFlow(CHAMPION, row);
    // Logged historical policy: champion approvals + a 10% randomised test-below-the-cut
    // program on non-fraud declines. Fraud-screen declines are never explored.
    let approved = 0, propensity = 0, exploration = 0;
    if (champ.decision === 'approve') { approved = 1; propensity = 1; }
    else if (champ.exitNode !== 'fraud') { propensity = EXPLORATION_RATE; if (rnd() < EXPLORATION_RATE) { approved = 1; exploration = 1; } }
    let defaulted = null, loss = null;
    const y = rnd() < pTrue ? 1 : 0;
    if (approved) { defaulted = y; loss = y ? Math.round(amount * LGD) : 0; }

    cols.month.push(Math.floor(rnd() * 12)); cols.product.push(PRODUCTS.indexOf(product)); cols.channel.push(CHANNELS.indexOf(channel)); cols.age_band.push(AGE.indexOf(age));
    cols.bureau_score.push(score); cols.thin_file.push(thin); cols.dti.push(row.dti); cols.cashflow_vol.push(row.cashflow_vol);
    cols.device_risk.push(row.device_risk); cols.pd_model.push(row.pd_model); cols.amount.push(amount);
    cols.approved.push(approved); cols.propensity.push(propensity); cols.exploration.push(exploration); cols.defaulted.push(defaulted); cols.loss.push(loss);
    truth.push(r3(pTrue));
  }
  return { meta: { n, seed, lgd: LGD, dicts: { month: months, product: PRODUCTS, channel: CHANNELS, age_band: AGE }, exploration_rate: EXPLORATION_RATE, window: 'Applications Jul 2024 - Jun 2025, 12-month performance', generated_by: 'scripts/generate.mjs' }, columns: cols, truth };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = +(process.argv[2] || 40000), seed = +(process.argv[3] || 20250630);
  const { meta, columns, truth } = generate(n, seed);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'applications.json'), JSON.stringify({ meta, columns }));
  writeFileSync(join(root, 'truth.json'), JSON.stringify({ meta: { note: 'True default probabilities. Simulation check only; never read by the estimator.' }, p_default: truth }));
  const appr = columns.approved.reduce((a, b) => a + b, 0);
  console.log(`wrote ${n} applications, ${appr} booked (${columns.exploration.reduce((a, b) => a + b, 0)} via exploration)`);
}
