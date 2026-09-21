"""Publish reproducible monthly reports; never overwrite a manually edited report.

The JS analysis pack is also used by the browser Excel export. The model writes
commentary only; all financial tables and numerical highlights are deterministic.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / 'docs' / 'reports'
MODEL = os.environ.get('MONTHLY_REPORT_MODEL', 'claude-sonnet-4-6')
SECTION_NAMES = ['金控獲利綜觀', '壽險子公司', '銀行子公司', '證券子公司']


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def number(value, suffix=''):
    return '—' if value is None else f"{Decimal(str(value)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):,}{suffix}"


def pct(value):
    return '—' if value is None else f'{value:+.1f}%'


def mom_text(row):
    label = '虧轉盈' if row['monthly'] is not None and row['monthly'] > 0 and row['mom']['base'] is not None and row['mom']['base'] < 0 else '盈轉虧' if row['monthly'] is not None and row['monthly'] < 0 and row['mom']['base'] is not None and row['mom']['base'] > 0 else ''
    return pct(row['mom']['pct']) + ('（' + label + '）' if label else '')


def clean(text):
    # Markdown is rendered as escaped text on the site. Keep one table cell/line.
    return str(text or '').replace('|', '／').replace('\n', ' ').strip()


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                     ['| ' + ' | '.join(clean(v) for v in row) + ' |' for row in rows])


def evidence(pack):
    """Allowlisted facts and news excerpts, identified individually for citations."""
    result = {}
    for row in pack['holdings'] + pack['subsidiaries']:
        key = f"{row['code']}-{row['name']}"
        result[key] = {'text': f"{row['name']} 單月 {number(row['monthly'])} 億元、MoM {pct(row['mom']['pct'])}、月增減 {number(row['mom']['delta'])} 億元、累計 {number(row['cumulative'])} 億元、累計 YoY {pct(row['yoy']['pct'])}。前三月均值 {number(row['average3'])} 億元，相對均值 {pct(row['deviation']['pct'])}；近三月合計 {number(row['rolling3']['current'])} 億元，再前三月 {number(row['rolling3']['base'])} 億元。變化標記：{'、'.join(row['markers'])}。比較註記：{row['rank_note']} {row['mom']['note']}", 'url': row['source_url']}
        if row['fvoci']:
            result[key+'-fvoci']={'text':json.dumps(row['fvoci'],ensure_ascii=False),'url':row['fvoci']['source_url'],'type':'FVOCI 補充揭露，與原始稅後淨利分開'}
    for item in pack['attribution']:
        result[item['code']+'-attribution']={'text':json.dumps(item,ensure_ascii=False),'url':'','type':'公告數字計算的子公司變化及其他殘差'}
    for item in pack['news']:
        if item['period'] == pack['period']:
            result[item['id']] = {'text': item['summary'], 'url': next((s['url'] for s in item['sources'] if s.get('url')), ''), 'type': '既有新聞摘要，非逐句核實的原文'}
    for item in pack['markets']:
        if item['period'] == pack['period']:
            result['market-' + item['key']] = {'text': json.dumps(item, ensure_ascii=False), 'url': '', 'type': '市場背景，不代表公司獲利因果'}
    return result


def validate_commentary(value, sources):
    if not isinstance(value, dict) or set(value) != {'sections'} or len(value['sections']) != 4:
        raise ValueError('Invalid commentary sections')
    for section in value['sections']:
        if not isinstance(section, list) or len(section) > 3:
            raise ValueError('Invalid paragraph count')
        for item in section:
            if not isinstance(item, dict) or set(item) != {'text', 'sources'}:
                raise ValueError('Invalid commentary item')
            if not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 350:
                raise ValueError('Invalid commentary length')
            if not isinstance(item['sources'], list) or not item['sources'] or any(s not in sources for s in item['sources']):
                raise ValueError('Unknown evidence reference')
            # Numbers are in generated tables. Prose cannot invent/recompute them.
            if re.search(r'\d|https?://|[<>]', item['text']):
                raise ValueError('Commentary must use qualitative text and provided references')
    return value['sections']


def generate_commentary(pack, client):
    sources = evidence(pack)
    prompt = (ROOT / 'scraper' / 'monthly_report_prompt.txt').read_text(encoding='utf-8')
    response = client.messages.create(model=MODEL, max_tokens=4000, temperature=0,
        system=prompt,
        messages=[{'role': 'user', 'content': json.dumps({'period': pack['period'], 'limitations': pack['limitations'], 'evidence': sources}, ensure_ascii=False)}])
    text = ''.join(block.text for block in response.content if getattr(block, 'type', '') == 'text').strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
    return validate_commentary(json.loads(text), sources)


def render_report(pack, commentary=None):
    holdings = pack['holdings']
    available = [r for r in holdings if r['monthly'] is not None]
    movers = sorted([r for r in holdings if r['mom']['delta'] is not None and not r['mom']['note']], key=lambda r: abs(r['mom']['delta']), reverse=True)
    if movers:
        r = movers[0]
        attribution=next(a for a in pack['attribution'] if a['code']==r['code'])
        parts=[(label,attribution[k]) for k,label in [('life','壽險'),('bank','銀行'),('securities','證券'),('other','其他殘差')] if attribution[k] is not None]
        driver='子公司資料不足，無法完整拆解'
        if parts:
            label,change=max(parts,key=lambda p:abs(p[1]))
            driver=f"最大分項變動為{label}{'增加' if change>=0 else '減少'} {number(abs(change))} 億元"
        headline = f"{pack['period']} 以{r['name']}單月變動最顯著，較前月{'增加' if r['mom']['delta'] >= 0 else '減少'} {number(abs(r['mom']['delta']))} 億元，{driver}；具體原因須對照公司／新聞說明。"
    else:
        headline = f"{pack['period']} 已取得 {pack['coverage']['available']}/13 家完整單月與累計資料，前期資料不足或存在比較限制，尚無法辨識最大月變化。"
    lines = [f"# {pack['period']} 金控月獲利分析報告", '',
             f"來源：MOPS 月自結；金額：新台幣億元（小數一位），EPS：元。已取得 {pack['coverage']['available']}/13 家完整單月與累計資料。", '',
             '## 本月一句話重點', '', headline, '', '## 資料完整性與限制', '']
    lines += ['- ' + s for s in pack['limitations']]
    sources = evidence(pack)
    def prose(index):
        if not commentary:
            return
        lines.extend(['', '### 新聞與市場解讀', ''])
        for item in commentary[index]:
            refs = []
            for key in item['sources']:
                url = sources[key]['url']
                refs.append(f'[{key}]({url})' if url.startswith(('https://', 'http://')) else clean(key))
            lines.append('- ' + clean(item['text']) + '（依據：' + '、'.join(refs) + '）')
    lines += ['', '## 1. 金控獲利綜觀', '', table(['公司','單月稅後淨利','MoM','累計獲利','累計 YoY','累計 EPS'],
        [[r['name'],number(r['monthly']),mom_text(r),number(r['cumulative']),pct(r['yoy']['pct']),('—' if r['cumulative_eps'] is None else f"{r['cumulative_eps']:.2f}")] for r in holdings]), '']
    for title, rows, field in [('單月金額最高',available,lambda r:r['monthly']),('MoM 最高',[r for r in holdings if r['mom']['pct'] is not None and r['mom']['base']>0 and not r['mom']['note']],lambda r:r['mom']['pct']),('可比公司累計 YoY 最高',[r for r in holdings if r['yoy_rank_eligible']],lambda r:r['yoy']['pct'])]:
        if rows:
            r=max(rows,key=field)
            lines.append(f"- {title}：{r['name']} {number(field(r))}{' 億元' if title=='單月金額最高' else '%'}（限已取得且符合比較條件者）。")
    excluded=[r['name']+'：'+r['rank_note'] for r in holdings if r['rank_note']]
    lines.append('- 基期不可比、排除未調整 YoY 排名：' + ('；'.join(excluded) if excluded else '無已知合併／認列起點變動。'))
    attention = [r for r in holdings if r['markers'] or r in movers[:3]]
    lines += ['', '### 本月值得注意的變化', '', table(['公司','前月','當月','增減億元','前三月平均','相對均值','近三月合計','再前三月合計','觀察'],
        [[r['name'],number(r['mom']['base']),number(r['monthly']),number(r['mom']['delta']),number(r['average3']),pct(r['deviation']['pct']),number(r['rolling3']['current']),number(r['rolling3']['base']),'、'.join(r['markers']) or '月變動金額前三大'] for r in attention]), '',
        '### 最大月變動的子公司拆解', '']
    chosen={r['code'] for r in movers[:3]}
    lines.append(table(['金控','金控增減','壽險增減','銀行增減','證券增減','其他','說明'],
        [[r['name'],number(r['delta']),number(r['life']),number(r['bank']),number(r['securities']),number(r['other']),r['note']] for r in pack['attribution'] if r['code'] in chosen]))
    prose(0)
    market={m['key']:m for m in pack['markets'] if m['period']==pack['period']}
    for index, category in enumerate(['life','bank','securities'],1):
        rows=[r for r in pack['subsidiaries'] if r['industry']==category]
        lines += ['',f'## {index+1}. {SECTION_NAMES[index]}','']
        if category=='life':
            def adjusted(r):
                a=r['fvoci']
                return '—' if not a or a['monthly'] is None else (a['monthly_prefix']+' ' if a['value_type']=='lower_bound' else '')+number(a['monthly'])
            lines.append(table(['公司','單月稅後淨利','加計差額（計算值）','加計後對保留盈餘影響'],
                [[r['name'],number(r['monthly']),number(r['fvoci']['disposal_monthly']) if r['fvoci'] else '—',adjusted(r)] for r in rows]))
            lines += ['', '加計差額為同月補充揭露總額減原始稅後淨利；不是另行取得的處分利益明細。下界或未揭露單月加計數時留缺值。FVOCI 累計 YoY 留白。']
        elif category=='bank':
            lines.append(table(['公司','單月獲利','MoM','累計 YoY','前三月均值','與均值比較'],
                [[r['name'],number(r['monthly']),mom_text(r),pct(r['yoy']['pct']),number(r['average3']),pct(r['deviation']['pct'])] for r in rows]))
            lines += ['', '月度波動與累計成長分開判讀；呆帳回收、費用沖回、稅務及財管手續費等原因須有明確揭露，否則月自結無法判讀，需財報／管理帳。']
        else:
            lines.append(table(['公司','單月獲利','MoM','台股指數 MoM','日均成交額 MoM'],
                [[r['name'],number(r['monthly']),mom_text(r),pct(market.get('taiex',{}).get('pct_change')),pct(market.get('taiex_turnover',{}).get('pct_change'))] for r in rows]))
            lines += ['', '元大證券可作觀察參考，但整體獲利包含不同業務，不能視為純經紀收益或市場報酬；未提供當期市占來源，故不套用固定市占比例。']
        prose(index)
        related={r['code'] for r in rows}
        news=[n for n in pack['news'] if n['period']==pack['period'] and n['code'] in related]
        if news:
            lines += ['', '相關公司新聞：'+ '、'.join(sorted({n['name'] for n in news}))+'；摘要與來源見下方，需核對子公司及損益期間。']
    lines += ['', '## 本月市場對照', '', table(['指標','月底值／月日均值','變動','資料日期','來源'],
        [[m['key'],number(m.get('value',m.get('value_pct',m.get('value_yi')))),number(m.get('bps_change'),' bps') if m['key']=='us10y' else pct(m.get('pct_change')),m.get('date',pack['period']),m.get('source','')] for m in market.values()]), '',
        '市場指標僅提供方向背景；債券、匯率與股票變化的實際損益影響須以公司揭露為據。', '', '## 公司新聞摘要與來源', '']
    for item in pack['news']:
        if item['period']!=pack['period']:
            continue
        lines += [f"### {item['name']}", '', '以下為既有新聞摘要（二次整理，未逐句核實）；摘要生成時間：'+item['generated_at'], '', item['summary'], '']
        for s in item['sources']:
            url=s.get('url','')
            if url.startswith(('https://','http://')):
                lines.append(f"- [{clean(s['title'])}]({url})；發布日期：{s['published_at'] or '未取得'}。")
    lines += ['', '## 計算及資料說明', ''] + ['- '+v for v in pack['methodology']]
    return '\n'.join(lines)+'\n', headline


def publish(pack, output=REPORTS, client=None, overwrite_manual=False):
    output=Path(output); output.mkdir(parents=True,exist_ok=True)
    stem=pack['period'].replace('/','-'); md=output/f'{stem}.md'; meta_path=output/f'{stem}.meta.json'
    previous=json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.exists() else {}
    serialized=json.dumps(pack,ensure_ascii=False,indent=2)+'\n'
    # Generation timestamps are not substantive input changes.
    content=json.loads(serialized);content.pop('data_updated_at',None)
    for n in content['news']:n.pop('generated_at',None)
    version=digest(Path(__file__).read_text(encoding='utf-8')+(ROOT/'scraper/monthly_report_prompt.txt').read_text(encoding='utf-8'))
    input_hash=digest(json.dumps(content,ensure_ascii=False,sort_keys=True)+version)
    (output/f'{stem}.pack.json').write_text(serialized,encoding='utf-8')
    manual=md.exists() and digest(md.read_text(encoding='utf-8'))!=previous.get('output_hash')
    if manual and not overwrite_manual:
        meta={**previous,'period':pack['period'],'manual':True,'data_changed':previous.get('input_hash')!=input_hash}
        headline=re.search(r'## 本月一句話重點\s*\n+([^\n]+)',md.read_text(encoding='utf-8'))
        if headline:meta['headline']=headline.group(1).strip()
    elif not overwrite_manual and previous.get('input_hash')==input_hash and md.exists() and (previous.get('ai_status')=='generated' or client is None or previous.get('attempts',0)>=3):
        return previous
    else:
        commentary=None;status='data-and-news';error=''
        attempts=previous.get('attempts',0) if previous.get('input_hash')==input_hash else 0
        if client is not None:
            attempts+=1
            try:
                commentary=generate_commentary(pack,client);status='generated'
            except Exception as exc:
                # No secrets, response text or endpoint headers in public output/logs.
                error=type(exc).__name__;status='fallback'
        text,headline=render_report(pack,commentary)
        md.write_text(text,encoding='utf-8')
        meta={'period':pack['period'],'input_hash':input_hash,'output_hash':digest(text),'headline':headline,
              'generated_at':datetime.now(timezone.utc).isoformat(),'ai_status':status,'ai_error_type':error,
              'attempts':attempts,'model':MODEL if commentary else None,'manual':False,'data_changed':False}
    meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    index_file=output/'index.json'
    index=json.loads(index_file.read_text(encoding='utf-8')) if index_file.exists() else {'reports':[]}
    entry={**meta,'file':md.name,'pack_file':f'{stem}.pack.json','title':f"{pack['period']} 金控月獲利分析報告",'source':'自動產製（數據＋新聞）'+('＋AI 解讀' if meta.get('ai_status')=='generated' else '')}
    index['reports']=[entry]+[r for r in index.get('reports',[]) if r['period'] not in [pack['period'], f"{int(pack['period'][:4])-1911}{pack['period'][4:]}"]]
    index['reports'].sort(key=lambda r:r['period'],reverse=True)
    index['_readme']='報告期間使用西元 YYYY/MM。編輯月份 .md 後，排程自動保留人工修改；meta 標示資料是否已更新。'
    index_file.write_text(json.dumps(index,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return meta


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--period',help='西元 YYYY/MM；省略則使用最新資料月份')
    parser.add_argument('--all',action='store_true',help='更新所有歷史報告；歷史月用數據與新聞版，最新月份才呼叫 AI')
    parser.add_argument('--no-ai',action='store_true',help='只生成數字分析與既有新聞摘要')
    parser.add_argument('--overwrite-manual',action='store_true',help='明確覆蓋人工修訂，預設保留')
    args=parser.parse_args()
    if args.overwrite_manual and (args.all or not args.period):
        parser.error('--overwrite-manual 必須指定單一 --period，不能批次覆蓋')
    index=json.loads((ROOT/'docs/data/index.json').read_text(encoding='utf-8'))
    if args.period:
        from periods import storage_period
        periods=[storage_period(args.period)]
    else:
        periods=[m['period'] for m in index['months']] if args.all else [index['latest']]
    for period in periods:
        command=['node',str(ROOT/'scripts/build-analysis-pack.cjs'),period]
        pack=json.loads(subprocess.check_output(command,encoding='utf-8',cwd=ROOT))
        client=None
        if not args.no_ai and os.environ.get('ANTHROPIC_API_KEY') and (not args.all or period==index['latest']):
            import anthropic
            client=anthropic.Anthropic(timeout=90,max_retries=1)
        meta=publish(pack,client=client,overwrite_manual=args.overwrite_manual)
        print(json.dumps({k:meta.get(k) for k in ['period','ai_status','manual','data_changed','ai_error_type']},ensure_ascii=False))


if __name__=='__main__':
    main()
