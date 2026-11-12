const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const forbidden=['不能','不宜','不可','不等於','不代表','尚缺','待揭露','未拆解','未量化','可能','研判','不排除'];
function violations(markdown) {
  const lines=markdown.split(/\r?\n/);
  const headings=lines.flatMap((line,index)=>/^##\s/.test(line)?[index]:[]);
  const last=headings.at(-1)??lines.length;
  const hits=[];
  let humanReview=false;
  for(let i=0;i<last;i++) {
    const line=lines[i];
    if(!line.trim()){humanReview=false;continue;}
    if(/^\*\*人工審閱/.test(line)||/^人工審閱/.test(line))humanReview=true;
    if(humanReview)continue;
    for(const word of forbidden)if(line.includes(word))hits.push({line:i+1,word});
  }
  return hits;
}

test('report language scanner excludes final methodology chapter and labelled human review paragraphs',()=>{
  assert.deepEqual(violations('## 本月重點\n文字不能推論\n\n**人工審閱**：可能補充\n\n## 期間、來源與需要留意的數字\n這裡不能比較'),[{line:2,word:'不能'}]);
});

const preview=path.join('docs','previews','2026-09-redraft.md');
const selectedReport=process.env.REPORT_FILE||(fs.existsSync(preview)?preview:null);
test('selected draft or approved report contains no forbidden wording in its body',{skip:!selectedReport},()=>{
  const file=selectedReport;
  const markdown=fs.readFileSync(file,'utf8');
  assert.deepEqual(violations(markdown),[],`${file} 的正文出現禁用語`);
});

test('published-report checker detects prohibited wording before publication',()=>{
  assert.deepEqual(violations('## 金控\n原因可能與市場有關\n\n## 期間、來源與需要留意的數字\n'),[{line:2,word:'可能'}]);
});
