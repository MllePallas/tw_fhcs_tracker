// Run with the site's pinned xlsx-js-style bundle: node tests/export-smoke.cjs path/to/xlsx.cjs
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const library=vm.createContext({console,Buffer});
vm.runInContext(fs.readFileSync(path.resolve(process.argv[2]),'utf8'),library);
const XLSX=library.XLSX;
const root=path.resolve(__dirname,'..');
const history=Object.fromEntries(fs.readdirSync(path.join(root,'docs/data')).filter(f=>/^\d+-\d+\.json$/.test(f)).map(f=>{const d=JSON.parse(fs.readFileSync(path.join(root,'docs/data',f),'utf8'));return[d.report_period,d];}));
const ctx=vm.createContext({console,AnalysisPack:require('../docs/analysis-pack.js'),ProfitAnalytics:require('../docs/analytics.js'),document:{addEventListener(){}},window:{XLSX},XLSX,Intl,Map,Set,Date,Math,Number,Array,Object,JSON,history,rules:require('../docs/comparison-rules.json')});
for(const file of ['app.js','trends.js','analysis-ui.js'])vm.runInContext(fs.readFileSync(path.join(root,'docs',file),'utf8'),ctx,{filename:file});
const book=vm.runInContext(`
Object.assign(monthCache,history);comparisonRules=rules;state.data=monthCache['115/08'];state.index={months:Object.keys(history).map(period=>({period}))};
Object.values(monthCache).forEach(applyComparisonPolicy);state.displayUnit='億元';state.sortMode='trend_deviation';
buildMonthlyWorkbook(XLSX,state.data,state.displayUnit);`,ctx);
const out=path.join(root,'.test-output','taiwan-fhcs-2026-08.xlsx');
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
const restored=XLSX.read(fs.readFileSync(out),{type:'buffer',cellStyles:true});
assert.deepEqual(Array.from(restored.SheetNames),['金控總覽','銀行子公司','壽險子公司','證券子公司','其他子公司','市場概況']);
const full=XLSX.utils.sheet_to_json(restored.Sheets['金控總覽']);
assert.equal(full.filter(r=>r['代號']).length,13);
assert.ok(!Object.keys(full[0]).includes('公告單月 EPS'));
assert.equal(typeof full.find(r=>r['代號']==='2881')['累計 EPS'],'number');
assert.equal(typeof full.find(r=>r['代號']==='2887')['累計 YoY'],'number');
const holdingAdjusted=full.filter(r=>String(r['金控']).includes('FVOCI'));
assert.ok(holdingAdjusted.length>0);
for(const r of holdingAdjusted) assert.ok(r['累計 YoY'] == null || r['累計 YoY'] === '');
const life=XLSX.utils.sheet_to_json(restored.Sheets['壽險子公司']);
const adjusted=life.filter(r=>String(r['壽險子公司']).includes('FVOCI'));
assert.ok(adjusted.length>0);
for(const r of adjusted) assert.ok(r['累計 YoY'] == null || r['累計 YoY'] === '');
assert.equal(typeof life.find(r=>r['壽險子公司']==='富邦人壽')['累計 YoY'],'number');
for(const name of restored.SheetNames) for(const [address,cell] of Object.entries(restored.Sheets[name])) {
  if(address.startsWith('!'))continue;
  assert.notEqual(cell.t,'e',`${name}!${address}`);
  if(cell.t==='n')assert.ok(Number.isFinite(cell.v));
}
console.log(JSON.stringify({file:out,sheets:restored.SheetNames,companies:13,checks:'six sheets, typed numbers, missing EPS, formatting and read-back passed'}));
