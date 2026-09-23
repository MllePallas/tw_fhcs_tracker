const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../docs/analytics.js');
const rules = require('../docs/comparison-rules.json');
const root = path.resolve(__dirname, '..');
const history = Object.fromEntries(fs.readdirSync(path.join(root, 'docs/data')).filter(f => /^\d+-\d+\.json$/.test(f)).map(f => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'docs/data', f), 'utf8'));
  return [data.report_period, data];
}));
const near = (a, b, tolerance = .05) => assert.ok(Math.abs(a-b) < tolerance, `${a} != ${b}`);

test('calendar windows cross years without skipping missing months', () => {
  assert.equal(A.shift('115/01', -1), '114/12');
  assert.deepEqual(A.range('115/02', 3), ['114/12','115/01','115/02']);
  assert.equal(A.yearMonths('115/08').length, 8);
});
test('zero, loss and low-base cases never emit misleading growth percentages', () => {
  for (const [cur,base,status] of [[0,0,'flat'],[10,0,'zero_to_profit'],[-10,0,'zero_to_loss'],[10,-10,'loss_to_profit'],[-10,10,'profit_to_loss'],[-5,-10,'loss_narrowing'],[-20,-10,'loss_widening'],[0,-10,'loss_to_zero'],[-10,-10,'loss_flat'],[200,1,'low_base']]) {
    const result = A.compare(cur,base);
    assert.equal(result.status,status); assert.equal(result.pct,null); assert.equal(result.delta,cur-base);
  }
  assert.equal(A.compare(2000,100,{scale:1500}).status,'low_base');
  assert.equal(A.compare(100,200).pct,-50);
});
test('missing is not zero, and non-finite values cannot become valid metrics', () => {
  for (const bad of [null,undefined,NaN,Infinity,'100']) assert.equal(A.compare(bad,100).status,'missing');
  assert.equal(A.toNTM(2,'億元'),200);
  assert.equal(A.toNTM(2000,'千元'),2);
  assert.equal(A.toNTM(10,'unknown'),null);
});
test('real August examples match independently calculated numbers', () => {
  const bill = A.row(history,rules,'115/08','2889','國票金');
  near(bill.mom.pct,98.4127); near(bill.average.pct,-27.977);
  near(bill.average.base,(601+772+189)/3);
  const c = A.row(history,rules,'115/08','2891','中信金');
  near(c.mom.delta,5521); near(c.rolling.pct,-.934);
  assert.equal(A.row(history,rules,'115/08','2881','富邦金').mom.status,'loss_to_profit');
});
test('one missing middle month invalidates the full window, preserving available amounts', () => {
  const h = structuredClone(history); delete h['115/06'];
  const r=A.row(h,rules,'115/08','2889','國票金');
  assert.equal(r.average.status,'missing'); assert.equal(r.average.base,null);
  assert.equal(r.rolling.status,'missing'); assert.equal(r.monthly,375);
  assert.ok(r.average.missing.includes('115/06'));
});
test('error entries and wrong-period cached data are unavailable', () => {
  const h=structuredClone(history); h['115/08'].companies.find(c=>c.code==='2889').error=true;
  assert.equal(A.value(h,'115/08','2889'),null);
  h['115/08']=h['115/07']; assert.equal(A.value(h,'115/08','2880'),null);
});
test('merger policy considers whole YTD and partial merger month', () => {
  assert.match(A.reason(rules,'2887',A.yearMonths('115/08'),A.yearMonths('114/08')),/合併/);
  assert.match(A.reason({...rules,accounting:null},'2887',['115/07'],['114/07']),/合併/);
  assert.equal(A.reason({...rules,accounting:null},'2887',['115/08'],['114/08']),'');
  assert.match(A.reason(rules,'2890',A.yearMonths('115/12'),A.yearMonths('114/12')),/京城/);
  assert.equal(A.reason(rules,'2890',['115/10'],['114/10']),'');
  assert.equal(A.reason(rules,'2890',A.yearMonths('116/08'),A.yearMonths('115/08')),'');
});
test('accounting boundary and subsidiary-specific merger rules do not affect unchanged banks', () => {
  assert.match(A.reason(rules,'2881',['115/08'],['114/08']),/新制/);
  assert.equal(A.reason(rules,'2881',['115/08'],['114/08'],'台北富邦銀行'),'');
  assert.equal(A.reason(rules,'2887',['115/08'],['114/08'],'台新銀行'),'');
  assert.match(A.reason(rules,'2887',['115/05'],['115/03'],'台新證券'),/元富/);
});
test('reconciliation distinguishes known basis differences and revisions from missing data', () => {
  assert.match(A.reconcile(history,rules,'5880',A.yearMonths('115/08')).note,/非控制權益/);
  assert.match(A.reconcile(history,rules,'2887',A.yearMonths('114/11')).note,/重編|調整/);
  assert.equal(A.reconcile(history,rules,'2880',['114/12','115/01']).cumulative,null);
});
test('negative and missing values cannot fabricate a new high or streak', () => {
  const h={};
  for(let m=1;m<=6;m++)h[`115/0${m}`]={report_period:`115/0${m}`,companies:[{code:'x',unit:'百萬元',holding_company:{monthly_profit:100*m}}]};
  let r=A.row(h,rules,'115/06','x','測試');assert.ok(r.labels.includes('連續 3 次月增'));assert.ok(r.labels.includes('近 6 月新高'));
  delete h['115/04'];r=A.row(h,rules,'115/06','x','測試');assert.ok(!r.labels.includes('連續 3 次月增'));assert.ok(!r.labels.includes('近 6 月新高'));
});
function context() {
  const elements = new Map();
  const element = id => { if(!elements.has(id)) elements.set(id,{value:'',innerHTML:'',textContent:'',classList:{add(){},remove(){},toggle(){}},scrollIntoView(){},querySelector(){return {textContent:''}}}); return elements.get(id); };
  const ctx=vm.createContext({console,ProfitAnalytics:A,document:{addEventListener(){},getElementById:element,querySelectorAll(){return []},body:{classList:{toggle(){}}}},window:{},Intl,Map,Set,Date,Math,Number,Array,Object,JSON,structuredClone,location:{origin:'http://localhost',pathname:'/'}});
  for(const file of ['app.js','trends.js'])vm.runInContext(fs.readFileSync(path.join(root,'docs',file),'utf8'),ctx,{filename:file});
  ctx.testHistory=structuredClone(history);ctx.testRules=rules;
  vm.runInContext(`Object.assign(monthCache,testHistory); comparisonRules=testRules; state.data=monthCache['115/08']; state.index={months:Object.keys(monthCache).sort().reverse().map(period=>({period}))}; Object.values(monthCache).forEach(applyComparisonPolicy); state.displayUnit='億元'; state.sortMode='trend_deviation';`,ctx);
  return {ctx,element};
}
test('full-report and image models follow the same comparison and EPS policies', () => {
  const {ctx}=context();
  const model=vm.runInContext('snapBuildModel()',ctx);
  assert.ok(model.cols.some(c=>c.key==='mom'));
  assert.ok(!model.cols.some(c=>c.key==='epsM'));
  assert.equal(model.rows.find(r=>r.code==='2881').epsC,'8.30');
  vm.runInContext("window.XLSX={utils:{encode_cell:({r,c})=>String.fromCharCode(65+c)+(r+1),encode_range:({s,e})=>String.fromCharCode(65+s.c)+(s.r+1)+':'+String.fromCharCode(65+e.c)+(e.r+1)}}",ctx);
  const sheet=vm.runInContext('buildHoldingsSheet(state.data,state.displayUnit)',ctx);
  assert.equal(sheet['!cols'].length,9);
  assert.ok(!Object.values(sheet).some(cell=>cell?.v==='公告單月 EPS'));
  const fubonRow=Object.entries(sheet).find(([addr,cell])=>/^B\d+$/.test(addr)&&cell.v==='富邦金')[0].slice(1);
  assert.equal(sheet[`G${fubonRow}`].v,8.3);
  assert.match(model.rows.find(r=>r.code==='2887').yoy,/^[+-]?[\d.]+%$/);
  assert.ok(model.rows.some(r=>r.type==='fvoci'));
  for(const r of model.rows.filter(r=>r.type==='fvoci')) assert.equal(r.yoy,'');
  assert.equal(vm.runInContext('state.pageMode',ctx),'monthly');
  vm.runInContext("state.viewMode='life'",ctx);
  const life=vm.runInContext('snapBuildModel()',ctx);
  assert.ok(life.rows.some(r=>r.type==='fvoci'));
  for(const r of life.rows.filter(r=>r.type==='fvoci')) assert.equal(r.yoy,'');
  assert.equal(vm.runInContext("state.data.companies.find(c=>c.code==='2881').holding_company.fvoci_adjusted.yoy_pct",ctx),null);
});
test('period YoY shows reported change, and missing intermediate month blocks aggregation', () => {
  const {ctx}=context();
  assert.equal(vm.runInContext("periodYoyOf({months:A.yearMonths('115/08'),baseMonths:A.yearMonths('114/08')},'2887',59700).status",ctx),'normal');
  near(vm.runInContext("periodAggCompany(['115/06','115/07','115/08'],'2880').profit",ctx),3371+3288+2895,20);
  vm.runInContext("delete monthCache['115/07']",ctx);
  assert.equal(vm.runInContext("periodAggCompany(['115/06','115/07','115/08'],'2880')",ctx),null);
});
test('dashboard renders all companies, touch-accessible heatmap and empty filter state', () => {
  const {ctx,element}=context();
  vm.runInContext('renderTrendDashboard()',ctx);
  const html=element('trend-root').innerHTML;
  assert.equal((html.match(/id="trend-row-/g)||[]).length,13);
  assert.ok(html.includes('heat-table'));assert.ok(!html.includes('NaN'));assert.ok(!html.includes('Infinity'));
  vm.runInContext("trendFilter='turn';renderTrendDashboard()",ctx);
  assert.equal((element('trend-root').innerHTML.match(/id="trend-row-/g)||[]).length,1);
  vm.runInContext("renderTrendDetail('2889')",ctx);
  assert.ok(element('trend-detail').innerHTML.includes('-28.0%'));
});
test('all historical company windows produce finite outputs or explicit unavailable states', () => {
  for(const [p,d] of Object.entries(history))for(const c of d.companies){
    const r=A.row(history,rules,p,c.code,c.name);
    for(const metric of [r.mom,r.average,r.rolling,r.yoy]) for(const key of ['cur','base','delta','pct']) assert.ok(metric[key]===null||Number.isFinite(metric[key]),`${p}/${c.code}/${key}`);
  }
});
test('rapid month switching cannot render or export an older response as the selected month', async () => {
  const {ctx}=context();
  const pending=new Map();
  ctx.fetch=url=>new Promise(resolve=>pending.set(url.match(/(\d+-\d+)\.json/)[1],resolve));
  vm.runInContext("loadTrendHistory=async()=>{};closeDetail=()=>{};resetTableScroll=()=>{};var rendered=[];renderAll=()=>rendered.push(state.data.report_period);",ctx);
  const older=vm.runInContext("loadData('115/07')",ctx);
  const newer=vm.runInContext("loadData('115/08')",ctx);
  assert.equal(vm.runInContext('state.loading',ctx),true);
  pending.get('115-08')({ok:true,json:async()=>structuredClone(history['115/08'])});
  await newer;
  pending.get('115-07')({ok:true,json:async()=>structuredClone(history['115/07'])});
  await older;
  assert.equal(vm.runInContext('state.data.report_period',ctx),'115/08');
  assert.equal(vm.runInContext('state.loading',ctx),false);
  assert.equal(vm.runInContext('rendered.join()',ctx),'115/08');
});

test('reported YoY remains numeric across accounting events, losses and low bases', () => {
  assert.equal(A.reportedYoY(120,100,'會計新制').pct,20);
  assert.equal(A.reportedYoY(-50,-100).pct,50);
  assert.equal(A.reportedYoY(50,-100).pct,150);
  assert.equal(A.reportedYoY(200,1).pct,19900);
  assert.equal(A.reportedYoY(10,0).pct,null);
  assert.equal(A.reportedYoY(10,null).status,'missing');
  const {ctx}=context();
  const companies=vm.runInContext('state.data.companies',ctx);
  for(const c of companies) {
    const old=history['114/08'].companies.find(b=>b.code===c.code);
    for(const [h,b] of [[c.holding_company,old?.holding_company],...(c.subsidiaries||[]).filter(s=>s.name.includes('人壽')).map(s=>[s,old?.subsidiaries?.find(b=>b.name===s.name)])]) {
      if(b?.cumulative_profit && h.cumulative_profit != null) near(h.cumulative_profit_yoy_pct,(h.cumulative_profit-b.cumulative_profit)/Math.abs(b.cumulative_profit)*100);
      if(h.fvoci_adjusted && h.name?.includes('人壽')) assert.equal(h.fvoci_adjusted.yoy_status,'not_presented');
    }
  }
});
