/* One calculation path for browser Excel exports and GitHub monthly reports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analytics.js'));
  else root.AnalysisPack = factory(root.ProfitAnalytics);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (A) {
  'use strict';
  const roster = {'2880':'華南金','2881':'富邦金','2882':'國泰金','2883':'凱基金','2884':'玉山金','2885':'元大金','2886':'兆豐金','2887':'台新新光金','2889':'國票金','2890':'永豐金','2891':'中信金','2892':'第一金','5880':'合庫金'};
  const ad = p => String(p || '').replace(/^(\d{2,3})[/-](\d{1,2})/, (_,y,m) => `${Number(y)+1911}/${m.padStart(2,'0')}`);
  const roc = p => String(p).replace(/^(\d{4})[/-](\d{1,2})$/,(_,y,m)=>`${Number(y)-1911}/${m.padStart(2,'0')}`);
  function dates(text) {
    return String(text || '').replace(/(?<!\d)(?:民國\s*)?(\d{3})年/g,(_,y)=>`${Number(y)+1911}年`)
      .replace(/(?<!\d)(\d{3})\/(\d{1,2})(?!\d)/g,(_,y,m)=>`${Number(y)+1911}/${m.padStart(2,'0')}`);
  }
  const yi = (v,u) => { const n=A.toNTM(v,u); return n===null?null:n/100; };
  const kind = name => /人壽/.test(name)?'life':/銀行/.test(name)?'bank':/證券/.test(name)?'securities':'other';
  function cmp(cur,base,note='') {
    const c=A.reportedYoY(cur,base,note);
    return {base:c.base,delta:c.delta,pct:c.pct,status:c.status,note:c.reason};
  }
  function build(history,rules,requested) {
    const period=roc(requested), current=history[period];
    if (!current || current.report_period!==period) throw new Error('找不到所選月份資料');
    const before=A.shift(period,-1), prior=A.shift(period,-12), months=A.range(period,24);
    const pack={schema_version:1,period:ad(period),unit:'新台幣億元',source:'MOPS 月自結',
      data_updated_at:current.last_updated||'',coverage:{expected:13,available:0,missing:[]},
      holdings:[],subsidiaries:[],attribution:[],history:[],markets:[],news:[],limitations:[],
      methodology:['金額為新台幣億元；顯示小數一位，計算保留原始精度。EPS 為元。',
        'YoY 與 MoM＝（本期－基期）÷基期絕對值；零基期及缺值不計百分比。跨零另註轉盈／轉虧。',
        '前3月平均不含當月；近3月合計與再前3月合計不重疊；缺任一必要月份不計算。',
        '原始稅後淨利 YoY 照列；合併或認列起點變動排除未調整 YoY 排名，單純更名不排除。',
        '金控與壽險加計 FVOCI 累計 YoY 留白；下界不作精確差額。',
        '子公司變動為公告稅後淨利變化，不等同母公司持股加權貢獻；其他為觀察殘差，不認定費用原因。',
        '新聞摘要為二次整理，未經原文逐句核實；與公告數字矛盾時以公告為準並列待核對。',
        '市場同向不代表因果；手續費、VaR、避險成本等未揭露項目需財報／管理帳。']};
    const entity=(c,name)=>name?c?.subsidiaries?.find(s=>s.name===name||s.name===rules.aliases?.[name]):c?.holding_company;
    const get=(p,code,name)=>{const c=A.company(history,p,code);return {c,h:entity(c,name)};};
    function row(code,name=null) {
      const {c,h}=get(period,code,name),prev=get(before,code,name),old=get(prior,code,name);
      const monthly=yi(h?.monthly_profit,c?.unit),cumulative=yi(h?.cumulative_profit,c?.unit);
      const monthNote=A.reason(rules,code,[period],[before],name);
      const yoyNote=A.reason(rules,code,A.yearMonths(period),A.yearMonths(prior),name);
      const rankNote=A.reason({...rules,accounting:null},code,A.yearMonths(period),A.yearMonths(prior),name);
      const recent=A.range(A.shift(period,-1),3).map(p=>{const d=get(p,code,name);return yi(d.h?.monthly_profit,d.c?.unit);});
      const avg=recent.every(A.finite)?recent.reduce((a,b)=>a+b,0)/3:null;
      const rolling=A.comparison(history,rules,code,A.range(period,3),A.range(A.shift(period,-3),3),false,name);
      const a=h?.fvoci_adjusted;
      const adjMonthly=a?.value_type==='lower_bound'?null:yi(a?.monthly_profit,c?.unit);
      const noteAvg=A.reason(rules,code,[period],A.range(before,3),name);
      const mom=cmp(monthly,yi(prev.h?.monthly_profit,prev.c?.unit),monthNote);
      const markers=[];
      if(monthly>0&&mom.base<0)markers.push('虧轉盈');
      if(monthly<0&&mom.base>0)markers.push('盈轉虧');
      if(!monthNote&&Math.abs(mom.pct)>=15)markers.push('MoM 達 ±15%');
      const deviation=cmp(monthly,avg,noteAvg);
      if(!noteAvg&&Math.abs(deviation.pct)>=20)markers.push('偏離前3月均值 ±20%');
      if(!monthNote&&!noteAvg&&mom.delta*deviation.delta<0)markers.push('月變化與近期水準背離');
      return {code,parent:c?.name||roster[code],name:name||c?.name||roster[code],industry:name?kind(name):'holding',
        monthly,cumulative,monthly_eps:h?.monthly_eps??null,cumulative_eps:h?.cumulative_eps??null,
        mom,yoy:cmp(cumulative,yi(old.h?.cumulative_profit,old.c?.unit),yoyNote),
        monthly_yoy:cmp(monthly,yi(old.h?.monthly_profit,old.c?.unit)),
        average3:avg,deviation,rolling3:{current:rolling.cur===null?null:rolling.cur/100,base:rolling.base===null?null:rolling.base/100,pct:rolling.pct,note:dates(rolling.reason)},
        yoy_rank_eligible:!rankNote&&A.finite(cumulative)&&A.finite(old.h?.cumulative_profit)&&old.h.cumulative_profit>0,
        rank_note:dates(rankNote),markers,source_url:c?.source_url||'',announcement_date:ad(c?.announcement_date),
        fvoci:a?{monthly:yi(a.monthly_profit,c.unit),cumulative:yi(a.cumulative_profit,c.unit),
          value_type:a.value_type||'exact',prefix:a.display_prefix||'逾',monthly_prefix:a.monthly_display_prefix||a.display_prefix||'逾',
          // Only subtract exact, same-period, same-entity disclosed after-tax totals.
          disposal_monthly:adjMonthly!==null&&monthly!==null?adjMonthly-monthly:null,
          disposal_method:'由同一期加計後金額減原始稅後淨利計算，需留意來源是否同為稅後數',
          quote:dates(a.source_quote),source_url:a.source_url||'',yoy:null}:null};
    }
    for(const [code,name] of Object.entries(roster)) {
      const c=A.company(history,period,code),h=row(code);
      pack.holdings.push(h);
      if(h.monthly!==null&&h.cumulative!==null)pack.coverage.available++;
      else pack.coverage.missing.push(`${h.name}：${c?'單月或累計缺值':'未公告／擷取失敗／期別不符'}`);
      for(const sub of c?.subsidiaries||[]) pack.subsidiaries.push(row(code,sub.name));
      const prev=A.company(history,before,code);
      const currentSubs=c?.subsidiaries||[],previousSubs=prev?.subsidiaries||[];
      const matched=currentSubs.map(s=>({s,b:entity(prev,s.name)}));
      const complete=!!c&&!!prev&&currentSubs.length>0&&matched.every(({s,b})=>A.finite(s.monthly_profit)&&A.finite(b?.monthly_profit))&&previousSubs.every(b=>currentSubs.some(s=>s.name===b.name||rules.aliases?.[s.name]===b.name));
      const groups={life:0,bank:0,securities:0};
      if(complete)for(const {s,b} of matched){const k=kind(s.name);if(k in groups)groups[k]+=yi(s.monthly_profit,c.unit)-yi(b.monthly_profit,prev.unit);}
      const ok=complete&&h.mom.delta!==null&&!h.mom.note;
      pack.attribution.push({code,name:h.name,delta:h.mom.delta,life:ok?groups.life:null,bank:ok?groups.bank:null,securities:ok?groups.securities:null,
        other:ok?h.mom.delta-groups.life-groups.bank-groups.securities:null,note:ok?'其他含母公司費用、合併沖銷、非主要子公司及持股差異；為觀察殘差。':'子公司配對缺漏或合併影響，僅列金控變化，不估算拆解。'});
      for(const p of months) {
        const d=A.company(history,p,code);
        if(!d){pack.history.push({period:ad(p),code,parent:name,name,industry:'holding',monthly:null,cumulative:null,status:'資料不足'});continue;}
        for(const [e,k] of [[d.holding_company,'holding'],...(d.subsidiaries||[]).map(s=>[s,kind(s.name)])])if(e){
          pack.history.push({period:ad(p),code,parent:d.name,name:k==='holding'?d.name:e.name,industry:k,monthly:yi(e.monthly_profit,d.unit),cumulative:yi(e.cumulative_profit,d.unit),monthly_eps:e.monthly_eps??null,cumulative_eps:e.cumulative_eps??null,source_url:d.source_url||'',status:'原始公告數'});
        }
        if(d.news_summary&&d.news_summary!=='無相關說明')pack.news.push({id:`news-${ad(p).replace('/','-')}-${code}`,period:ad(p),code,name:d.name,
          summary:dates(d.news_summary),generated_at:d.news_generated_at||'',manual:!!d.news_manual,
          sources:(d.news_sources||[]).map(s=>({title:dates(s.title),url:s.url,published_at:ad(s.published_at||s.date||''),type:s.type||'新聞摘要來源（未逐句核實）'}))});
      }
    }
    for(const p of months){const m=history[p]?.market_summary;if(!m||m.period!==p)continue;
      for(const [key,v] of Object.entries(m.items||{}))pack.markets.push({period:ad(p),key,...v});
    }
    if(pack.coverage.missing.length)pack.limitations.push(`公告資料 ${pack.coverage.available}/13 家；${pack.coverage.missing.join('；')}。`);
    const marketKeys=pack.markets.filter(m=>m.period===pack.period).map(m=>m.key);
    for(const key of ['taiex','spx','us10y','usdtwd','taiex_turnover'])if(!marketKeys.includes(key))pack.limitations.push(`本月市場資料缺少 ${key}。`);
    const missingNews=pack.holdings.filter(h=>!pack.news.some(n=>n.period===pack.period&&n.code===h.code)).map(h=>h.name);
    if(missingNews.length)pack.limitations.push(`本月新聞摘要未取得：${missingNews.join('、')}；不推測原因。`);
    pack.limitations.push('新聞來源發布日期未提供者列為未取得；摘要生成時間不等同發布時間。');
    return pack;
  }
  return {build,ad,roc,dates,roster};
});
