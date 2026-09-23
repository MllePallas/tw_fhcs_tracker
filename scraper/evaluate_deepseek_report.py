"""Generate unpublished DeepSeek report drafts for comparison with existing reports."""
import json
import os
import subprocess
from pathlib import Path

# The legacy deepseek-v4-flash alias now routes to this canonical Flash model.
os.environ.setdefault('MONTHLY_REPORT_DEEPSEEK_MODEL','deepseek-flash')

from monthly_report import ROOT, generate_commentary, render_report, report_clients
from news_summary import _load_dotenv
from report_sources import collect

PERIODS=('2026/06','2026/07','2026/08')
OUTPUT=ROOT/'.test-output'/'deepseek-evaluation'


def main():
    _load_dotenv()
    writer,reviewer,writer_model,reviewer_model=report_clients('deepseek')
    OUTPUT.mkdir(parents=True,exist_ok=True)
    results=[]
    for period in PERIODS:
        stem=period.replace('/','-')
        stage='build-pack'
        try:
            pack=json.loads(subprocess.check_output(
                ['node',str(ROOT/'scripts/build-analysis-pack.cjs'),period],encoding='utf-8',cwd=ROOT))
            stage='collect-sources'
            sources=collect(pack)
            stage='generate-and-review'
            commentary=generate_commentary(pack,writer,sources,reviewer,writer_model,reviewer_model)
            stage='render'
            markdown,_=render_report(pack,commentary,sources)
            (OUTPUT/f'{stem}.md').write_text(markdown,encoding='utf-8')
            (OUTPUT/f'{stem}.analysis.json').write_text(
                json.dumps(commentary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            results.append({'period':period,'status':'validated','writer':writer_model,'reviewer':reviewer_model,
                            'reference':f'docs/reports/{stem}.md','draft':f'{stem}.md'})
        except Exception as exc:
            # Do not write API responses or credentials into the downloadable artifact.
            results.append({'period':period,'status':'failed','stage':stage,'error_type':type(exc).__name__,
                            'http_status':getattr(exc,'status_code',None)})
    (OUTPUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    summary=['| 月份 | 結果 | 階段 | 錯誤類型 | HTTP 狀態 |','| --- | --- | --- | --- | --- |']
    for result in results:
        print(f"{result['period']}: {result['status']}",flush=True)
        notice='; '.join(f'{key}={result.get(key) or "—"}' for key in
                         ('status','stage','error_type','http_status'))
        print(f"::notice title=DeepSeek Flash {result['period']}::{notice}",flush=True)
        summary.append('| '+ ' | '.join(str(result.get(k) or '—') for k in
                       ('period','status','stage','error_type','http_status'))+' |')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as handle:
            handle.write('## DeepSeek Flash 未發布報告測試\n\n'+'\n'.join(summary)+'\n')
    if any(r['status']!='validated' for r in results):raise SystemExit(1)


if __name__=='__main__':main()
