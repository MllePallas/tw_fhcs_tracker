const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const P=require('../docs/analysis-pack.js');
const history={};
for(const f of fs.readdirSync(path.join(root,'docs/data')).filter(f=>/^\d+-\d+\.json$/.test(f))){
  const d=JSON.parse(fs.readFileSync(path.join(root,'docs/data',f),'utf8'));
  history[d.report_period]=d;
}
const period=process.argv[2]||JSON.parse(fs.readFileSync(path.join(root,'docs/data/index.json'),'utf8')).latest;
process.stdout.write(JSON.stringify(P.build(history,require('../docs/comparison-rules.json'),period)));
