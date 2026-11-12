const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const P=require('../docs/analysis-pack.js');
const rules=require('../docs/comparison-rules.json');

const history=Object.fromEntries(fs.readdirSync('docs/data').filter(f=>/^\d+-\d+\.json$/.test(f)).map(f=>{
  const d=JSON.parse(fs.readFileSync(`docs/data/${f}`,'utf8'));return[d.report_period,d];
}));
const pack=P.build(history,rules,'2026/09');
const approved=path.join('docs','reports','2026-09.md');
const preview=path.join('docs','previews','2026-09-redraft.md');
const report=fs.existsSync(approved)?approved:preview;
const draft=fs.existsSync(report)?fs.readFileSync(report,'utf8'):null;
function number(n,signed=false) {
  if(n===null||n===undefined)return '—';
  const abs=Math.round((Math.abs(n)+1e-9)*10)/10;
  const value=abs.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
  return n<0?`−${value}`:signed&&n>0?`+${value}`:value;
}
function percent(c) {
  if(c?.status==='loss_to_profit')return '虧轉盈';
  if(c?.status==='profit_to_loss')return '盈轉虧';
  return c?.pct===null||c?.pct===undefined?'—':`${number(c.pct,true)}%`;
}
function tableRows(title) {
  const lines=draft.split(/\r?\n/),start=lines.findIndex(line=>line.startsWith(title));
  assert.ok(start>=0,`表格不存在：${title}`);
  const rows=[];
  for(const line of lines.slice(start+2)){
    if(!line.startsWith('| '))break;
    rows.push(line.split('|').slice(1,-1).map(cell=>cell.trim()));
  }
  return rows;
}
function expected(row) {
  return [row.name,number(row.monthly),percent(row.mom),number(row.mom.delta,true),percent(row.monthly_yoy),
    number(row.cumulative),percent(row.yoy)];
}
test('every holding and subsidiary figure in September draft matches the calculation pack',{skip:!draft},()=>{
  const holdings=tableRows('| 金控 | 單月淨利 |');
  assert.equal(holdings.length,13);
  for(const cells of holdings){
    const row=pack.holdings.find(r=>r.name===cells[0]);assert.ok(row,cells[0]);
    assert.deepEqual(cells,expected(row));
  }
  for(const [title,industry,count] of [['壽險公司','life',9],['銀行','bank',14],['證券公司','securities',12]]){
    const rows=tableRows(`| ${title} | 單月淨利 |`);
    assert.equal(rows.length,count);
    for(const cells of rows){
      const row=pack.subsidiaries.find(r=>r.industry===industry&&r.name===cells[0]);assert.ok(row,cells[0]);
      assert.deepEqual(cells.slice(0,7),expected(row));
    }
  }
});
