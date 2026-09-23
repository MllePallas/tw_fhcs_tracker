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
        try:
            pack=json.loads(subprocess.check_output(
                ['node',str(ROOT/'scripts/build-analysis-pack.cjs'),period],encoding='utf-8',cwd=ROOT))
            sources=collect(pack)
            commentary=generate_commentary(pack,writer,sources,reviewer,writer_model,reviewer_model)
            markdown,_=render_report(pack,commentary,sources)
            (OUTPUT/f'{stem}.md').write_text(markdown,encoding='utf-8')
            (OUTPUT/f'{stem}.analysis.json').write_text(
                json.dumps(commentary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            results.append({'period':period,'status':'validated','writer':writer_model,'reviewer':reviewer_model,
                            'reference':f'docs/reports/{stem}.md','draft':f'{stem}.md'})
        except Exception as exc:
            # Do not write API responses or credentials into the downloadable artifact.
            results.append({'period':period,'status':'failed','error_type':type(exc).__name__})
    (OUTPUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for result in results:print(f"{result['period']}: {result['status']}")
    if any(r['status']!='validated' for r in results):raise SystemExit(1)


if __name__=='__main__':main()
