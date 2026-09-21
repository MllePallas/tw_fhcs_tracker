"""Management report: deterministic metrics, grounded narrative, editable Markdown."""
import json
import re
from decimal import Decimal, ROUND_HALF_UP

GROUPS = [('holding','金控'),('life','壽險'),('bank','銀行'),('securities','證券')]
MARKETS = {'taiex':'台股加權指數','spx':'S&P 500','us10y':'美國10年期公債殖利率',
           'usdtwd':'美元兌台幣','taiex_turnover':'集中市場日均成交額'}


def number(value):
    if value is None:return '—'
    rounded=Decimal(str(value)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
    return f"{abs(rounded) if rounded==0 else rounded:,.1f}"


def pct(value):
    if value is not None and abs(value)<.05:return '0.0%'
    return '—' if value is None else ('+' if value>0 else '−' if value<0 else '')+number(abs(value))+'%'


def signed(value):
    if value is None:return '—'
    if abs(value)<.05:return '0.0'
    return ('+' if value>0 else '−' if value<0 else '')+number(abs(value))


def mom(row):
    c,b=row['monthly'],row['mom']['base']
    if c is not None and b is not None and c*b<0:return '虧轉盈' if c>0 else '盈轉虧'
    return pct(row['mom']['pct'])


def table(headers,rows):
    clean=lambda v:str(v).replace('|','／').replace('\n',' ')
    return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join('---' for _ in headers)+' |']+
        ['| '+' | '.join(clean(v) for v in row)+' |' for row in rows])


def grouped(pack):
    return {'holding':pack['holdings'],**{key:[r for r in pack['subsidiaries'] if r['industry']==key] for key,_ in GROUPS[1:]}}


def aggregate(rows,exclude=()):
    paired=[r for r in rows if r['name'] not in exclude and r['monthly'] is not None and r['mom']['base'] is not None and not r['mom']['note']]
    if not paired:return {'n':0,'current':None,'base':None,'delta':None,'pct':None}
    current=sum(Decimal(str(r['monthly'])) for r in paired)
    base=sum(Decimal(str(r['mom']['base'])) for r in paired)
    return {'n':len(paired),'current':float(current),'base':float(base),'delta':float(current-base),
            'pct':float((current-base)/abs(base)*100) if base else None}


def market_change(item):
    if not item:return None
    suffix='_pct' if item['key']=='us10y' else '_yi' if item['key']=='taiex_turnover' else ''
    current,base=item.get('value'+suffix),item.get('prev_value'+suffix)
    if current is None or base is None:return item.get('bps_change' if item['key']=='us10y' else 'pct_change')
    if item['key']=='us10y':return float((Decimal(str(current))-Decimal(str(base)))*100)
    return (current-base)/abs(base)*100 if base else None


def market_value(item,previous=False):
    key=item['key'];suffix='_pct' if key=='us10y' else '_yi' if key=='taiex_turnover' else ''
    value=item.get(('prev_value' if previous else 'value')+suffix)
    if value is None:return '—'
    digits=3 if key in ('us10y','usdtwd') else 1
    return f"{Decimal(str(value)).quantize(Decimal(10)**-digits,rounding=ROUND_HALF_UP):,.{digits}f}"


def context(pack,sources):
    """All numbers in AI prose must reference these preformatted metric tokens."""
    facts={}; rows=[]; groups=grouped(pack)
    def add(key,label,value):facts[key]={'label':label,'value':value}
    add('period','報導月份',pack['period'])
    for i,row in enumerate(pack['holdings']+pack['subsidiaries']):
        rid=f'r{i}'
        values={'monthly':number(row['monthly']),'base':number(row['mom']['base']),
                'delta':signed(row['mom']['delta']),'mom':mom(row),'cumulative':number(row['cumulative']),
                'yoy':pct(row['yoy']['pct']),'average3':number(row['average3']), 'deviation':pct(row['deviation']['pct'])}
        for key,value in values.items():add(rid+'.'+key,row['name']+' '+key,value)
        rows.append({'id':rid,'name':row['name'],'code':row['code'],'industry':row['industry'],
            'raw':{'monthly':row['monthly'],'base':row['mom']['base'],'delta':row['mom']['delta'],'mom':row['mom']['pct']},
            'values':values,'markers':row['markers'],'rank_note':row['rank_note'],
            'mom_note':row['mom']['note'],'yoy_rank_eligible':row['yoy_rank_eligible']})
    totals={}
    exclusions={}
    for key,label in GROUPS:
        a=aggregate(groups[key]);totals[key]=a
        for field in ['n','current','base','delta','pct']:
            val=str(a[field]) if field=='n' else pct(a[field]) if field=='pct' else signed(a[field]) if field=='delta' else number(a[field])
            add(key+'.'+field,label+'可比合計 '+field,val)
        paired=[r for r in groups[key] if r['mom']['delta'] is not None and not r['mom']['note']]
        leaders=sorted(paired,key=lambda r:abs(r['mom']['delta']),reverse=True)[:3]
        for count in range(1,len(leaders)+1):
            selected=leaders[:count];names=[r['name'] for r in selected];aid=f'{key}.exclude{count}'
            ex=aggregate(groups[key],names);exclusions[aid]={'excluded':names,**ex}
            add(aid+'.pct',label+'排除'+'、'.join(names)+'後月增率',pct(ex['pct']))
            share=sum(r['mom']['delta'] for r in selected)/a['delta']*100 if a['delta'] else None
            add(aid+'.share','、'.join(names)+'占群體淨增減額比重',pct(share))
    for item in pack['markets']:
        if item['period']==pack['period']:
            add('market.'+item['key'],MARKETS.get(item['key'],item['key'])+'月變動',
                signed(market_change(item))+' bps' if item['key']=='us10y' else pct(market_change(item)))
    return {'period':pack['period'],'coverage':pack['coverage'],'limitations':pack['limitations'],
            'rows':rows,'totals':totals,'exclusions':exclusions,'facts':facts,
            'attribution':pack['attribution'],'history':[r for r in pack['history'] if r['industry']=='holding' and r['period']>=shift(pack['period'],-2)],
            'evidence':sources}


def shift(period,n):
    y,m=map(int,period.split('/'));y,m=divmod(y*12+m-1+n,12)
    return f'{y:04d}/{m+1:02d}'


class ValidationError(ValueError):pass


def validate(value,ctx):
    if not isinstance(value,dict) or set(value)!={'headline','sections','securities'}:raise ValidationError('需要 headline、sections、securities')
    if not isinstance(value['sections'],list) or len(value['sections'])!=4:raise ValidationError('必須有四個 sections')
    def text(s,limit):
        if not isinstance(s,str) or not 1<=len(s)<=limit:raise ValidationError('文字長度不符合規範')
        def replace(m):
            if m[1] not in ctx['facts']:raise ValidationError('數字代碼不存在')
            return ''
        stripped=re.sub(r'\{\{([^{}]+)\}\}',replace,s)
        if re.search(r'\d|https?://|[<>{}]',stripped):raise ValidationError('數字必須使用 facts 代碼；不可含網址、HTML 或無效代碼')
        if re.search(r'[零〇一二兩三四五六七八九十百千萬億點]+(?:億元|萬元|千元|倍)|百分之[零〇一二三四五六七八九十百點]+',stripped):
            raise ValidationError('不可用中文數字繞過 facts 代碼填入金額、比例或倍數')
        if re.search(r'合併後非完整|本月為合併|本月含.*範圍調整|YoY不具可比',s):
            raise ValidationError('基期限制由程式表註提供；不可把去年合併基期或母公司事件套成當月或子公司異動')
    def item(v):
        if not isinstance(v,dict) or set(v)!={'text','sources'}:raise ValidationError('項目必須有 text 和 sources')
        text(v['text'],700)
        if not isinstance(v['sources'],list) or any(k not in ctx['evidence'] for k in v['sources']):raise ValidationError('引用不存在')
        # Causality requires a specific source; empty citations only for numerical observations.
        if re.search(r'提存|處分|自營|承銷|避險|股利|淨利差|手續費|投資收益',v['text']) and not v['sources']:
            raise ValidationError('業務原因必須引用新聞依據；無來源時只寫數字現象')
    item(value['headline'])
    for section in value['sections']:
        if not isinstance(section,dict) or set(section)!={'title','paragraphs'}:raise ValidationError('section 欄位錯誤')
        text(section['title'],100)
        if not isinstance(section['paragraphs'],list) or not 1<=len(section['paragraphs'])<=4:raise ValidationError('每節一至四段')
        for v in section['paragraphs']:item(v)
    names={r['name'] for r in ctx['rows'] if r['industry']=='securities'}
    seen=set()
    if not isinstance(value['securities'],list):raise ValidationError('securities 必須是陣列')
    for v in value['securities']:
        if not isinstance(v,dict) or set(v)!={'name','text','sources','basis'}:raise ValidationError('券商欄位錯誤')
        if v['name'] not in names or v['name'] in seen:raise ValidationError('券商名稱不符或重複')
        seen.add(v['name']);item({'text':v['text'],'sources':v['sources']})
        if not v['sources'] or v['basis'] not in ['單月原因','累計／年增線索']:raise ValidationError('券商原因需引述來源與適用期間')
    return value


def resolve(text,ctx):
    return re.sub(r'\{\{([^{}]+)\}\}',lambda m:ctx['facts'][m[1]]['value'],text)


def cited(item,ctx):
    result=resolve(item['text'],ctx)
    seen=set()
    for key in dict.fromkeys(item['sources']):
        s=ctx['evidence'][key];label=s.get('title') or s['kind']
        if s['url'] in seen:continue
        seen.add(s['url'])
        label=re.sub(r'[\[\]|\n]',' ',label)[:70]
        date=s.get('published_at','')[:10].replace('-','/')
        result+=f" [{label}{'・'+date if date else ''}]({s['url']})"
    return result


def security_direction(row,market):
    if row['monthly'] is None or row['mom']['base'] is None:return '缺單月數，無法判讀'
    if row['mom']['note']:return '前後期範圍有變，暫不推論業務原因'
    delta=row['mom']['delta']
    if market is None:return '市場成交資料缺漏，暫不作方向比較'
    if market<0 and delta>0:
        return ('量縮下轉盈' if row['monthly']>0 and row['mom']['base']<0 else '量縮逆勢增利')+'，研判其他業務或收支改善；具體項目待確認'
    if market>0 and delta<0:return '量增卻減利，研判其他業務或收支拖累；具體項目待確認'
    if market*delta>0:return '與量能方向一致；業務別影響待拆解'
    return '獲利與量能變動幅度不同，追蹤其他業務及收支'


def render(pack,commentary=None,sources=None):
    ctx=context(pack,sources or {}); groups=grouped(pack)
    headline=cited(commentary['headline'],ctx) if commentary else '本月數字與趨勢已更新；新聞原因分析暫未完成。'
    lines=[f"# {pack['period']} 金控自結獲利分析",'', '## 本月重點','',headline,'']
    lines += [f"已取得 {pack['coverage']['available']}/13 家完整單月與累計資料。金額為新台幣億元；來源：MOPS 月自結。",'']
    if pack['coverage']['missing']:lines += ['**資料缺漏：**'+'；'.join(pack['coverage']['missing']),'']
    for i,(key,label) in enumerate(GROUPS):
        rows=sorted(groups[key],key=lambda r:r['monthly'] if r['monthly'] is not None else -1e30,reverse=True)
        title=resolve(commentary['sections'][i]['title'],ctx) if commentary else label+'獲利變化'
        lines += [f'## {i+1}. {title}','']
        a=aggregate(rows)
        if a['n']:
            lines += [f"{a['n']}家可比{label}單月合計{number(a['current'])}億元，前月{number(a['base'])}億元，增減{signed(a['delta'])}億元，MoM {pct(a['pct'])}。",'']
        if commentary:
            for item in commentary['sections'][i]['paragraphs']:lines += [cited(item,ctx),'']
        if key=='holding':
            lines += ['### 金控獲利總覽','',table(['金控','單月淨利','MoM','月增減','累計淨利','累計YoY','累計EPS'],
                [[r['name'],number(r['monthly']),mom(r),signed(r['mom']['delta']),number(r['cumulative']),pct(r['yoy']['pct']),f"{r['cumulative_eps']:.2f}" if r['cumulative_eps'] is not None else '—'] for r in rows]),'']
            eligible=[r for r in rows if r['yoy_rank_eligible'] and r['yoy']['pct'] is not None]
            if eligible:
                best=max(eligible,key=lambda r:r['yoy']['pct']);lines += [f"可比公司累計YoY最高：{best['name']} {pct(best['yoy']['pct'])}。",'']
            excluded=[r['name']+'：'+r['rank_note'] for r in rows if r['rank_note']]
            lines += ['*基期或認列範圍影響：'+('；'.join(excluded) if excluded else '無已知異動')+'。相關公司原始YoY照列，不納入未調整的跨公司成長率排名。*','']
            att=sorted([r for r in pack['attribution'] if r['delta'] is not None],key=lambda r:abs(r['delta']),reverse=True)[:6]
            lines += ['### 月變動最大的六家：子公司拆解','',table(['金控','金控增減','壽險增減','銀行增減','證券增減','其他'],
                [[r['name']]+[signed(r[k]) for k in ['delta','life','bank','securities','other']] for r in att]),'',
                '*其他含母公司費用、合併沖銷、非主要子公司及持股差異，屬觀察殘差；子公司配對不足時列缺值，不強行配平。*','']
            periods=[shift(pack['period'],n) for n in [-2,-1,0]]
            focus={r['code'] for r in att}
            trend=[]
            for r in rows:
                if r['code'] not in focus:continue
                values=[next((v['monthly'] for v in pack['history'] if v['period']==p and v['code']==r['code'] and v['industry']=='holding'),None) for p in periods]
                direction='資料不足'
                if all(v is not None for v in values):
                    x,y,z=values;direction='連續回升' if x<y<z else '連續回落' if x>y>z else '回升但未回到前期' if z>y and z<x else '回落但仍高於前期' if z<y and z>x else '單月反向變動或持平'
                trend.append([r['name']]+[number(v) for v in values]+[direction])
            lines += ['### 最近三個月趨勢','',table(['金控']+periods+['判讀'],trend),'']
            market=[m for m in pack['markets'] if m['period']==pack['period'] and m['key'] in MARKETS]
            lines += ['### 本月市場概況','',table(['指標','前月','本月','月變動'],[[MARKETS[m['key']]+'（'+{'taiex':'點','spx':'點','us10y':'%','usdtwd':'元／美元','taiex_turnover':'億元'}[m['key']]+'）',
                market_value(m,True),market_value(m),
                signed(market_change(m))+' bps' if m['key']=='us10y' else pct(market_change(m))] for m in market]),'',
                '*指數、匯率及殖利率為月底值；成交額為集中市場日均值（億元）。殖利率變動以bps表示，美元兌台幣下跌表示台幣升值。來源：Yahoo Finance、TWSE。*','']
        elif key=='life':
            def adjusted(r,field):
                a=r['fvoci'] or {};value=a.get(field)
                return ((a.get('prefix','逾') if field=='cumulative' else a.get('monthly_prefix','逾')) if a.get('value_type')=='lower_bound' and value is not None else '')+number(value)
            lines += ['### 壽險稅後淨利與加計FVOCI後數字','',table(['壽險公司','單月淨利','MoM','單月FVOCI差額','單月加計後','累計淨利','累計YoY','累計加計後','加計後YoY'],
                [[r['name'],number(r['monthly']),mom(r),number((r['fvoci'] or {}).get('disposal_monthly')),adjusted(r,'monthly'),number(r['cumulative']),pct(r['yoy']['pct']),adjusted(r,'cumulative'),''] for r in rows]),'',
                '*FVOCI差額依同月加計後數減原始淨利計算，下界不作精確差額；加計後數為對保留盈餘影響。加計後YoY留白；原始淨利YoY照列。未揭露數字列—。*','']
        elif key=='bank':
            lines += ['### 銀行單月與累計獲利','',table(['銀行','單月淨利','MoM','月增減','累計淨利','累計YoY'],
                [[r['name'],number(r['monthly']),mom(r),signed(r['mom']['delta']),number(r['cumulative']),pct(r['yoy']['pct'])] for r in rows]),'']
        else:
            market=next((m for m in pack['markets'] if m['period']==pack['period'] and m['key']=='taiex_turnover'),None)
            notes={v['name']:v for v in commentary['securities']} if commentary else {}
            def reading(r):
                if r['monthly'] is None or r['mom']['base'] is None:return '缺單月數，無法判讀'
                if r['name'] in notes:
                    n=notes[r['name']];return cited(n,ctx)+'（'+n['basis']+'）'
                return security_direction(r,market_change(market))+'（方向判讀）'
            lines += ['### 券商獲利變動：已揭露原因與追蹤項目','',table(['證券公司','單月淨利','MoM','月增減','累計淨利','獲利變動解讀'],
                [[r['name'],number(r['monthly']),mom(r),signed(r['mom']['delta']),number(r['cumulative']),reading(r)] for r in rows]),'',
                f"*市場日均成交額MoM {pct(market_change(market))}。以經紀市占率與費率大致穩定為前提，量能作為經紀收入方向參考；獲利背離時追蹤非經紀業務及費用、稅負等收支。未披露的業務別金額不估算。*",'']
    lines += ['## 資料說明','']
    lines += ['- '+s for s in pack['limitations']]
    lines += ['- 媒體報導為主要蒐集來源，官網新聞稿補充核對；不等待官網上稿。媒體引述公司說明可直接採用，年增或累計資訊不當作已證實的單月原因。',
              '- 財務計算統一採MOPS月自結；新聞用於解釋原因，發生差異時不覆蓋原始數字。來源日期未取得不等於未公告。',
              '- 群體MoM只使用兩期都有數字且可比較的相同公司；缺值不補零。金控與子公司合計不可相加。',
              '- MoM與YoY＝（本期−基期）÷基期絕對值；零基期不計，跨零MoM列轉盈／轉虧。前三月平均不含當月。',
              '- 本文可直接編輯月份Markdown檔；自動排程保留人工修訂，原始資料更新另作提示。','']
    return '\n'.join(lines),re.sub(r'\s*\[[^\]]+\]\([^)]*\)','',headline)
