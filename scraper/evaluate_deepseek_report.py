"""Compare unpublished DeepSeek report drafts on the same monthly evidence."""
import hashlib
import json
import os
import subprocess
import time

from monthly_report import ROOT, generate_commentary, render_report, report_clients
from monthly_report_v2 import ValidationError
from news_summary import _load_dotenv
from report_sources import collect

PERIODS=tuple(p.strip() for p in os.environ.get('REPORT_PERIODS','2026/06,2026/07,2026/08').split(',') if p.strip())
MODELS=('deepseek-flash','deepseek-v4-pro')
OUTPUT=ROOT/'.test-output'/'deepseek-evaluation'


def main():
    _load_dotenv()
    writer,reviewer,_,reviewer_model=report_clients('deepseek')
    OUTPUT.mkdir(parents=True,exist_ok=True)
    results=[]
    prompt=(ROOT/'scraper/monthly_report_prompt.txt').read_text(encoding='utf-8')
    for period in PERIODS:
        stem=period.replace('/','-')
        pack=json.loads(subprocess.check_output(
            ['node',str(ROOT/'scripts/build-analysis-pack.cjs'),period],encoding='utf-8',cwd=ROOT))
        # Fetch articles once per month: both models receive identical data and news.
        sources=collect(pack)
        evidence_hash=hashlib.sha256(json.dumps(
            {'pack':pack,'sources':sources,'prompt':prompt},ensure_ascii=False,sort_keys=True
        ).encode('utf-8')).hexdigest()
        for writer_model in MODELS:
            prefix=f'{stem}.{writer_model}'
            stage='generate-and-review'
            rejected=[]
            started=time.monotonic()
            try:
                def remember_review(draft,issues):
                    if issues:rejected.append({'draft':draft,'issues':issues})
                commentary=generate_commentary(pack,writer,sources,reviewer,writer_model,reviewer_model,
                                                on_review=remember_review)
                stage='render'
                markdown,_=render_report(pack,commentary,sources)
                (OUTPUT/f'{prefix}.md').write_text(markdown,encoding='utf-8')
                (OUTPUT/f'{prefix}.analysis.json').write_text(
                    json.dumps(commentary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
                results.append({'period':period,'status':'validated','writer':writer_model,'reviewer':reviewer_model,
                                'evidence_hash':evidence_hash,'elapsed_seconds':round(time.monotonic()-started,1),
                                'reference':f'docs/reports/{stem}.md','draft':f'{prefix}.md'})
            except Exception as exc:
                # Do not write raw API responses or credentials into the artifact.
                if rejected:
                    (OUTPUT/f'{prefix}.rejected.analysis.json').write_text(
                        json.dumps({'period':period,'review_attempts':rejected},ensure_ascii=False,indent=2)+'\n',
                        encoding='utf-8')
                    try:
                        rejected_markdown,_=render_report(pack,rejected[-1]['draft'],sources)
                        (OUTPUT/f'{prefix}.rejected.md').write_text(
                            '# 未通過語意複核：僅供診斷，不可發布\n\n'+rejected_markdown,encoding='utf-8')
                    except Exception:
                        pass
                results.append({'period':period,'status':'failed','writer':writer_model,'reviewer':reviewer_model,
                                'evidence_hash':evidence_hash,'elapsed_seconds':round(time.monotonic()-started,1),
                                'stage':stage,'error_type':type(exc).__name__,
                                'error_detail':str(exc).replace('\n',' ')[:120] if isinstance(exc,ValidationError) else None,
                                'http_status':getattr(exc,'status_code',None)})
    (OUTPUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    summary=['| 月份 | 模型 | 結果 | 秒數 | 階段 | 錯誤類型 |','| --- | --- | --- | ---: | --- | --- |']
    for result in results:
        print(f"{result['period']} {result['writer']}: {result['status']}",flush=True)
        notice='; '.join(f'{key}={result.get(key) or "—"}' for key in
                         ('status','stage','error_type','error_detail','http_status'))
        print(f"::notice title={result['writer']} {result['period']}::{notice}",flush=True)
        summary.append('| '+ ' | '.join(str(result.get(k) or '—') for k in
                       ('period','writer','status','elapsed_seconds','stage','error_type'))+' |')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as handle:
            handle.write('## DeepSeek Flash／Pro 未發布報告對照\n\n'+'\n'.join(summary)+'\n')
    if any(r['status']!='validated' for r in results):raise SystemExit(1)


if __name__=='__main__':main()
