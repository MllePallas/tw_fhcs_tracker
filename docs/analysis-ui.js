'use strict';
const monthReports = Object.create(null);
async function loadMonthReport(period) {
  const entry=reportForPeriod(period);
  if(!entry){monthReports[period]={entry:null,text:''};return;}
  try {
    const response=await fetch(`./reports/${encodeURIComponent(entry.file)}?_=${Date.now()}`);
    if(!response.ok)throw new Error('尚未取得報告');
    monthReports[period]={entry,text:AnalysisPack.dates(await response.text())};
  }catch(e){monthReports[period]={entry,text:'',error:'報告暫時無法載入，請稍後重新整理。'};}
}
function monthlyReportHtml(period) {
  const report=monthReports[period];
  const entry=report?.entry;
  if (!entry) return '';
  const month=periodAd(period);
  const href=/^\d{4}-\d{2}\.html$/.test(entry.html_file||'')
    ? `./reports/${entry.html_file}` : `./report.html?period=${month.replace('/','-')}`;
  return `<section class="trend-section monthly-analysis"><a class="monthly-report-link" href="${href}">${month} 金控自結獲利分析 ↗</a>${entry.data_changed?'<p class="report-warning">資料已有更新，報告文字保留人工修訂；請核對數字。</p>':''}</section>`;
}
function appendAnalysisSheets(wb,XLSX) {
  const pack=AnalysisPack.build(monthCache,comparisonRules,state.data.report_period);
  const n=v=>v==null?xText('—'):{v,t:'n',z:'#,##0.0;[Red]-#,##0.0',s:XS.num(v)};
  const pc=v=>v==null?xText('—'):{v:v/100,t:'n',z:'"+"0.0%;"-"0.0%',s:XS.yoy(v)};
  const txt=v=>xText(AnalysisPack.dates(v));
  function sheet(name,headers,rows,widths){
    const matrix=[headers.map(s=>xText(s,XS.headCol())),...rows];
    XLSX.utils.book_append_sheet(wb,trendSheet(matrix,{cols:headers.map((_,i)=>({wch:widths?.[i]||24}))}),name);
  }
  sheet('分析使用說明',['項目','內容'],[
    ['報導月份',pack.period],['來源',pack.source],['金額單位',pack.unit+'；顯示一位小數，儲存完整精度；EPS 為元'],
    ['公告完整度',`${pack.coverage.available}/13`],['缺漏',pack.coverage.missing.join('；')||'無'],
    ...pack.methodology.map(s=>['計算規則',s]),...pack.limitations.map(s=>['資料限制',s]),
    ['分析指令','請以本資料包撰寫本月一句話摘要及金控、壽險、銀行、證券四段分析。優先 MoM ±15%、相對前3月均值偏離 ±20%、月增減金額前三大及轉盈轉虧。數字與新聞分開核實，引用新聞來源；區分公司揭露、媒體報導、可能推論。不得補值或把市場方向認定為公司獲利原因。所有期間用西元年/月。'],
  ].map(r=>r.map(txt)),[25,110]);
  const metrics=r=>[txt(pack.period),txt(r.code),txt(r.parent),txt(r.name),n(r.monthly),n(r.mom.base),n(r.mom.delta),pc(r.mom.pct),n(r.cumulative),pc(r.yoy.pct),n(r.average3),pc(r.deviation.pct),n(r.rolling3.current),n(r.rolling3.base),pc(r.rolling3.pct),txt(r.yoy_rank_eligible?'可納入':'不納入'),txt(r.rank_note),txt(r.markers.join('；')),txt(r.source_url)];
  const heads=['月份','代號','集團','公司','單月億元','前月億元','月增減億元','MoM','累計億元','累計 YoY','前三月平均億元','相對均值','近三月合計億元','再前三月合計億元','近三月增減率','YoY 排名資格','排名註記','變化標記','公告來源'];
  sheet('分析金控指標',heads,pack.holdings.map(metrics));
  sheet('分析子公司指標',heads,pack.subsidiaries.map(metrics));
  sheet('子公司變動拆解',['月份','代號','金控','金控增減億元','壽險增減億元','銀行增減億元','證券增減億元','其他億元','說明'],pack.attribution.map(r=>[txt(pack.period),txt(r.code),txt(r.name),n(r.delta),n(r.life),n(r.bank),n(r.securities),n(r.other),txt(r.note)]),[15,10,18,22,22,22,22,22,85]);
  sheet('近24月金控與子公司',['月份','代號','集團','公司','類別','單月億元','累計億元','單月 EPS 元','累計 EPS 元','資料狀態','公告來源'],pack.history.map(r=>[txt(r.period),txt(r.code),txt(r.parent),txt(r.name),txt(r.industry),n(r.monthly),n(r.cumulative),xEps(r.monthly_eps),xEps(r.cumulative_eps),txt(r.status),txt(r.source_url)]));
  sheet('新聞摘要',['月份','代號','公司','摘要','摘要生成時間','人工整理','證據層級','來源識別','期間檢查'],pack.news.map(r=>[txt(r.period),txt(r.code),txt(r.name),txt(r.summary),txt(r.generated_at),txt(r.manual?'是':'否'),txt('二次整理，需核對原文'),txt(r.id),txt(r.quality_note||'未發現來源標題有異期；仍需核對原文')]),[15,10,18,110,28,15,35,35,70]);
  sheet('新聞來源',['月份','代號','公司','來源識別','標題','網址','發布日期','來源類別'],pack.news.flatMap(r=>r.sources.map(s=>[txt(r.period),txt(r.code),txt(r.name),txt(r.id),txt(s.title),txt(s.url),txt(s.published_at||'未取得'),txt(s.type)])),[15,10,18,35,70,90,20,45]);
  sheet('近24月市場',['月份','指標','本期值','前期值','MoM','殖利率變動 bps','資料日期','來源'],pack.markets.map(r=>[txt(r.period),txt(r.key),n(r.value??r.value_pct??r.value_yi),n(r.prev_value??r.prev_value_pct??r.prev_value_yi),pc(r.pct_change),n(r.bps_change),txt(r.date||r.period),txt(r.source)]));
  sheet('FVOCI補充揭露',['月份','代號','公司','單月加計後億元','累計加計後億元','數值類型','單月加計差額億元','計算說明','原揭露摘要','來源','累計 YoY'],[...pack.holdings,...pack.subsidiaries].filter(r=>r.fvoci).map(r=>{const a=r.fvoci;return[txt(pack.period),txt(r.code),txt(r.name),a.value_type==='lower_bound'?txt(`${a.monthly_prefix} ${a.monthly??'—'}`):n(a.monthly),a.value_type==='lower_bound'?txt(`${a.prefix} ${a.cumulative??'—'}`):n(a.cumulative),txt(a.value_type),n(a.disposal_monthly),txt(a.disposal_method),txt(a.quote),txt(a.source_url),txt('')];}),[15,10,20,25,25,18,25,70,100,90,20]);
  const report=monthReports[state.data.report_period];
  sheet('本月分析報告',['項目','內容'],[
    [txt('月份'),txt(pack.period)], [txt('版本'),txt(report?.entry?.manual?'人工修訂版':'自動產製')],
    ...((report?.text||'本月分析報告尚未生成；可使用本資料包於公司 Copilot 分析。').split(/\n\n+/).map((s,i)=>[txt(`段落 ${i+1}`),txt(s)])),
  ],[20,120]);
}
