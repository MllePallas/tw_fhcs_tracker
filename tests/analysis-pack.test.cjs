const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const P=require('../docs/analysis-pack.js'),rules=require('../docs/comparison-rules.json');
const history=Object.fromEntries(fs.readdirSync('docs/data').filter(f=>/^\d+-\d+\.json$/.test(f)).map(f=>{const d=JSON.parse(fs.readFileSync(`docs/data/${f}`,'utf8'));return[d.report_period,d];}));
test('report pack uses Gregorian periods and original amounts, with no future information',()=>{
  const p=P.build(history,rules,'2026/08');
  assert.equal(p.coverage.available,13);assert.equal(p.period,'2026/08');
  const bill=p.holdings.find(r=>r.code==='2889');assert.equal(bill.monthly,3.75);
  assert.ok(Math.abs(bill.mom.pct-98.412698)<.0001);
  assert.ok(p.news.length>13);assert.ok(p.history.some(r=>r.industry==='life'));
  assert.ok(p.news.every(r=>/^20\d{2}\/\d{2}$/.test(r.period)&&r.period<=p.period));
  const old=P.build(history,rules,'2025/07');assert.ok(old.news.every(r=>r.period<='2025/07'));
  assert.ok(old.markets.every(r=>r.period<='2025/07'));
  assert.equal(p.holdings.find(r=>r.code==='2887').yoy_rank_eligible,false);
  assert.equal(p.holdings.find(r=>r.code==='2883').yoy_rank_eligible,true);
  for(const r of p.holdings.filter(r=>r.fvoci))assert.equal(r.fvoci.yoy,null);
});
test('missing companies and subsidiary baselines never become zero or fabricated attribution',()=>{
  const h=structuredClone(history);h['115/08'].companies=h['115/08'].companies.filter(c=>c.code!=='2889');
  h['115/07'].companies.find(c=>c.code==='2881').subsidiaries=[];
  const p=P.build(h,rules,'2026/08');
  assert.equal(p.coverage.available,12);assert.equal(p.holdings.find(r=>r.code==='2889').monthly,null);
  assert.equal(p.attribution.find(r=>r.code==='2881').other,null);
  assert.equal(p.attribution.find(r=>r.code==='2889').delta,null);
});
test('lower bound FVOCI never creates an exact disposal gain',()=>{
  const h=structuredClone(history);h['115/08'].companies.find(c=>c.code==='2881').holding_company.fvoci_adjusted.value_type='lower_bound';
  const a=P.build(h,rules,'2026/08').holdings.find(r=>r.code==='2881').fvoci;
  assert.equal(a.disposal_monthly,null);assert.equal(a.value_type,'lower_bound');
  assert.equal(P.dates('115 年8月及115/07'), '2026年8月及2026/07');
});
test('news from another reporting period is retained but excluded from analysis',()=>{
  const p=P.build(history,rules,'2026/08');
  const stale=p.news.find(n=>n.period===p.period&&n.code==='2886');
  assert.equal(stale.analysis_eligible,false);assert.match(stale.quality_note,/待核對/);
  assert.ok(stale.summary.length>0);assert.ok(p.limitations.some(s=>s.includes('兆豐金新聞')));
});
