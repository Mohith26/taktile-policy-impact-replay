// Repeated-simulation check of the estimators (truth is known only because data is simulated).
// Usage: node scripts/coverage.mjs [K=40]
import * as R from '../core/replay.js';
import { generate } from './generate.mjs';
const edits = R.DEFAULT_EDITS.slice(0,4);
let cov=0, covN=0, bD=0,bN=0, K=+process.argv[2]||20;
const perEdit={};
for (let s=1;s<=K;s++){
  const g = generate(40000, 1000+s); const rows = R.rowsFromColumns(g.columns, g.meta.dicts); const t=g.truth;
  const est = R.estimateOutcomes(rows);
  const res = R.replay(rows, est, R.CHAMPION, edits, {B:200});
  const tr = res.swapIn.reduce((a,i)=>a+t[i],0)/res.swapIn.length;
  const inCI = tr>=res.swapInRateDRCI[0] && tr<=res.swapInRateDRCI[1];
  cov+=inCI; const naiveIn = (()=>{ /* naive CI-free */ return res.swapInRateNaive; })();
  bD += res.swapInRateDR - tr; bN += res.swapInRateNaive - tr;
  const trueEL = res.swapIn.reduce((a,i)=>a+t[i]*rows[i].amount*0.65,0)-res.swapOut.reduce((a,i)=>a+t[i]*rows[i].amount*0.65,0);
  covN += trueEL>=res.elDeltaCI[0] && trueEL<=res.elDeltaCI[1];
  for (const e of edits){ const r=R.replay(rows,est,R.CHAMPION,[e],{B:1}); const trr=r.swapIn.reduce((a,i)=>a+t[i],0)/r.swapIn.length; perEdit[e.id]=perEdit[e.id]||{dr:0,nv:0}; perEdit[e.id].dr+=r.swapInRateDR-trr; perEdit[e.id].nv+=r.swapInRateNaive-trr; }
  console.log(s, tr.toFixed(4), res.swapInRateDR.toFixed(4), res.swapInRateDRCI.map(x=>x.toFixed(4)).join('-'), res.swapInRateNaive.toFixed(4), inCI);
}
console.log('coverage rate', cov/K, 'EL cov', covN/K, 'bias DR', bD/K, 'bias naive', bN/K);
for (const k in perEdit) console.log(k, (perEdit[k].dr/K).toFixed(4), (perEdit[k].nv/K).toFixed(4));
