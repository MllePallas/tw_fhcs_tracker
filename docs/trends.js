'use strict';

const A = ProfitAnalytics;
let comparisonRules;
let trendFilter = 'all';
let trendMetric = 'average';
let detailCode = null;
let detailPeriod = null;

async function loadComparisonRules() {
  const response = await fetch('./comparison-rules.json');
  if (!response.ok) throw new Error('比較口徑設定載入失敗');
  comparisonRules = await response.json();
}

async function loadTrendHistory() {
  await Promise.all((state.index?.months || []).map(m => fetchMonth(m.period)));
  // Derived comparisons are rebuilt in memory. Original announcement values stay intact.
  Object.values(monthCache).filter(Boolean).forEach(applyComparisonPolicy);
}

function applyComparisonPolicy(d) {
  const p = d.report_period, prior = A.shift(p, -12);
  const baseline = monthCache[prior];
  for (const c of d.companies || []) {
    if (c.report_month && c.report_month !== p) { c.error = true; c.error_msg = '資料月份不符，待更新'; }
    if (c.error) continue;
    const prev = A.company(monthCache, prior, c.code);
    const update = (h, b, name) => {
      if (!h) return;
      const cmp = A.reportedYoY(A.toNTM(h.cumulative_profit, c.unit), A.toNTM(b?.cumulative_profit, prev?.unit),
        A.reason(comparisonRules, c.code, A.yearMonths(p), A.yearMonths(prior), name));
      h.cumulative_profit_yoy_pct = cmp.pct;
      h.cumulative_profit_yoy_abs = convertUnit(cmp.delta, '百萬元', c.unit);
      h.cumulative_profit_yoy_status = cmp.status;
      h.cumulative_profit_yoy_reason = cmp.reason;
      if (h.fvoci_adjusted) {
        h.fvoci_adjusted.yoy_pct = null;
        h.fvoci_adjusted.yoy_abs = null;
        h.fvoci_adjusted.yoy_status = 'not_presented';
      }
    };
    update(c.holding_company, prev?.holding_company, null);
    for (const s of c.subsidiaries || []) {
      const b = prev?.subsidiaries?.find(x => x.name === s.name || x.name === comparisonRules.aliases[s.name]);
      update(s, b, s.name);
    }
  }
  if (d === state.data) state.baseline = baseline || null;
}

const STATUS_LABELS = {
  missing: '資料不足', incomparable: '口徑不同', different_basis: '不同口徑',
  loss_to_profit: '虧轉盈', profit_to_loss: '盈轉虧', loss_narrowing: '虧損縮小',
  loss_widening: '虧損擴大', loss_flat: '虧損持平', loss_to_zero: '虧損歸零',
  zero_to_profit: '零轉盈', zero_to_loss: '零轉虧', flat: '持平', low_base: '低基期',
};
const METRIC_LABELS = { average: '相對前 3 月平均', rolling: '近 3 月 vs 再前 3 月', yoy: '單月 YoY' };
function trendNumber(n) { return n == null ? '—' : new Intl.NumberFormat('zh-TW', { maximumFractionDigits: state.displayUnit === '億元' ? 2 : 1 }).format(convertUnit(n, '百萬元', state.displayUnit)); }
function signedNumber(n) { return n == null ? '—' : `${n > 0 ? '+' : ''}${trendNumber(n)}`; }
function changeText(cmp) {
  if (cmp.pct != null) return `${cmp.pct > 0 ? '+' : ''}${cmp.pct.toFixed(1)}%`;
  return STATUS_LABELS[cmp.status] || '—';
}
function comparisonTitle(c) {
  return `${c.currentPeriods?.map(periodAd).join('、') || ''} 對照 ${c.basePeriods?.map(periodAd).join('、') || ''}；本期 ${trendNumber(c.cur)}，基準 ${trendNumber(c.base)} ${state.displayUnit}。${c.reason || ''}${c.missing?.length ? `缺少 ${c.missing.map(periodAd).join('、')}` : ''}`;
}
function metricHtml(c, showAmount = true) {
  const comparable = !['missing', 'incomparable'].includes(c.status);
  return `<span class="trend-change ${comparable ? c.direction > 0 ? 'up' : c.direction < 0 ? 'down' : '' : ''}" title="${escapeHtml(comparisonTitle(c))}">${changeText(c)}</span>${showAmount && comparable ? `<small>${signedNumber(c.delta)} ${state.displayUnit}</small>` : ''}`;
}
function allTrendRows() {
  const p = state.data.report_period;
  // Include a missing current company using the closest available name, never its old value.
  const names = new Map();
  const earlier = Object.keys(monthCache).filter(k => k <= p && monthCache[k]).sort();
  for (const k of earlier) for (const c of monthCache[k].companies || []) names.set(c.code, c.name);
  return [...names].map(([code, name]) => A.row(monthCache, comparisonRules, p, code, name));
}
function visibleTrendRows() {
  let rows = allTrendRows().filter(r => trendFilter === 'all' ||
    (trendFilter === 'up' && r.mom.direction > 0) || (trendFilter === 'down' && r.mom.direction < 0) ||
    (trendFilter === 'turn' && ['loss_to_profit', 'profit_to_loss', 'zero_to_profit', 'zero_to_loss'].includes(r.mom.status)) ||
    (trendFilter === 'flag' && r.labels.length) || (trendFilter === 'missing' && [r.mom, r.average, r.rolling, r.yoy].some(c => ['missing', 'incomparable'].includes(c.status))));
  const validDelta = c => ['missing', 'incomparable'].includes(c.status) ? null : c.delta;
  const key = r => state.sortMode === 'trend_up' ? validDelta(r.mom) : state.sortMode === 'trend_down' ? (validDelta(r.mom) === null ? null : -r.mom.delta) : state.sortMode === 'trend_amount' ? r.monthly : r[trendMetric].pct === null ? null : Math.abs(r[trendMetric].pct);
  if (state.sortMode === 'code') rows.sort((a, b) => a.code.localeCompare(b.code));
  else rows.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || a.code.localeCompare(b.code));
  return rows;
}
function sparkline(r) {
  const vals = r.values.filter(A.finite);
  if (!vals.length) return '<span class="muted">尚無資料</span>';
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const y = v => 37 - (v - lo) / span * 32;
  let path = '', connected = false;
  r.values.forEach((v, i) => {
    const boundary = i > 0 && A.reason(comparisonRules, r.code, [r.periods[i]], [r.periods[i - 1]]);
    if (!A.finite(v)) { connected = false; return; }
    path += `${connected && !boundary ? 'L' : 'M'}${4 + i * 11},${y(v)} `;
    connected = true;
  });
  return `<svg class="sparkline" viewBox="0 0 130 44" role="img" aria-label="${escapeHtml(r.name)}近12月走勢，各公司獨立刻度，缺值與口徑變更處斷線"><line x1="3" x2="127" y1="${y(0)}" y2="${y(0)}" stroke="#d5d9e0"/><path d="${path}" fill="none" stroke="currentColor" stroke-width="2"/>${A.finite(r.monthly) ? `<circle cx="125" cy="${y(r.monthly)}" r="3" fill="currentColor"/>` : ''}</svg>`;
}
function setTrendFilter(value) { trendFilter = value; renderTrendDashboard(); }
function setTrendMetric(value) { trendMetric = value; renderTrendDashboard(); }
function setTrendWindow(value) { state.trendWindow = Number(value); if (detailCode) renderTrendDetail(detailCode); }

function renderTrendDashboard() {
  if (!comparisonRules || !state.data) return;
  const rows = visibleTrendRows(), all = allTrendRows();
  const p = state.data.report_period, unit = state.displayUnit;
  const valid = all.filter(r => r.monthly !== null).length;
  const comparable = all.filter(r => !['missing', 'incomparable'].includes(r.mom.status));
  const highlights = [
    ...all.filter(r => ['loss_to_profit', 'profit_to_loss'].includes(r.mom.status)),
    ...all.filter(r => r.mom.direction > 0 && r.average.direction < 0),
    ...all.filter(r => r.labels.some(s => s.startsWith('連續'))),
    ...all.filter(r => r.average.pct != null).sort((a, b) => Math.abs(b.average.pct) - Math.abs(a.average.pct)),
  ].filter((r, i, a) => a.findIndex(x => x.code === r.code) === i).slice(0, 4);
  document.getElementById('trend-root').innerHTML = `
    ${typeof monthlyReportHtml === 'function' ? monthlyReportHtml(p) : ''}
    <section class="trend-intro"><div><p class="eyebrow">${periodLabel(p)} · 趨勢重點</p><h2>先看變化，再看數字</h2><p>原始單月稅後淨利，不含 FVOCI 加計數。比較各公司自己的近期水準。</p></div><div class="coverage"><strong>${valid}<span> / ${all.length}</span></strong><span>家單月資料已取得</span></div></section>
    <div class="trend-breadth">與上月可比較 ${comparable.length} 家：<strong class="up">${comparable.filter(r => r.mom.direction > 0).length} 家增加</strong><strong class="down">${comparable.filter(r => r.mom.direction < 0).length} 家減少</strong><span>${comparable.filter(r => r.mom.direction === 0).length} 家持平</span><span>其餘 ${all.length - comparable.length} 家缺資料或口徑不同</span></div>
    <div class="trend-highlights">${highlights.map(r => `<button class="trend-highlight" onclick="openTrendCompany('${r.code}')"><span>${r.name} <small>${r.code}</small></span><strong>${changeText(r.mom)}<small>較上月 ${['missing', 'incomparable'].includes(r.mom.status) ? '—' : signedNumber(r.mom.delta)} ${unit}</small></strong><span>${r.average.status === 'normal' ? `相對前 3 月平均 ${changeText(r.average)}` : r.labels[0] || changeText(r.average)}</span><span class="highlight-link">查看月份數字 →</span></button>`).join('') || '<p class="empty-trend">目前資料不足，尚無可比較的變化摘要。</p>'}</div>
    <section class="trend-section"><div class="trend-section-head"><div><h3>金控趨勢總覽</h3><p>點公司查看歷史數字；迷你圖為各公司獨立刻度。</p></div><div class="trend-tools"><label>觀察指標<select id="trend-metric" onchange="setTrendMetric(this.value)">${Object.entries(METRIC_LABELS).map(([v, t]) => `<option value="${v}" ${trendMetric === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>篩選<select id="trend-filter" onchange="setTrendFilter(this.value)">${[['all','全部公司'],['up','較上月增加'],['down','較上月減少'],['turn','轉盈／轉虧'],['flag','有變化標記'],['missing','資料或口徑待留意']].map(([v,t]) => `<option value="${v}" ${trendFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div></div>
    <p class="trend-unit">單位：${unitFullLabel(unit)} · ${periodAd(p)} · 顯示 ${rows.length} 家 <span>← 窄螢幕可左右滑動</span></p>
    <div class="trend-table-wrap"><table class="trend-table"><thead><tr><th>公司</th><th>當月獲利</th><th>較上月增減</th><th>${METRIC_LABELS[trendMetric]}</th><th>近 12 月走勢</th><th>變化標記／口徑</th></tr></thead><tbody>${rows.map(r => `<tr id="trend-row-${r.code}"><th><button class="company-link" onclick="openTrendCompany('${r.code}')">${r.name}</button><small>${r.code}</small></th><td class="num ${r.monthly < 0 ? 'negative' : ''}">${trendNumber(r.monthly)}${r.monthly === null ? '<small>未取得當月數</small>' : ''}</td><td class="num">${metricHtml(r.mom)}</td><td class="num">${metricHtml(r[trendMetric])}</td><td><button class="spark-button" aria-label="查看${r.name}歷史趨勢" onclick="openTrendCompany('${r.code}')">${sparkline(r)}</button></td><td class="trend-tags">${r.labels.map(s => `<span>${s}</span>`).join('') || '<span class="muted">—</span>'}${r.notes.length ? `<button class="basis-flag" onclick="openTrendCompany('${r.code}')" title="${escapeHtml(r.notes.join('；'))}">口徑說明 ${r.notes.length}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-trend">沒有符合篩選的公司。請切換「全部公司」。</td></tr>'}</tbody></table></div></section>
    <section id="trend-detail" class="trend-detail ${detailCode ? '' : 'hidden'}" aria-live="polite"></section>
    <section class="trend-section"><div class="trend-section-head"><div><h3>本月增減集中在哪裡</h3><p>較上月增減金額；缺資料與不可比公司不列入。套用上方公司篩選。</p></div></div>${deltaChart(rows)}</section>
    <section class="trend-section"><div class="trend-section-head"><div><h3>過去 12 個月，何時偏離近期水準</h3><p>每格＝該月相對其前 3 月平均。百分比使用相同色階，金額不跨公司混比。</p></div></div><div class="heat-legend"><span class="heat-negative">低於均值</span><span>接近均值</span><span class="heat-positive">高於均值</span><span>顏色於 ±50% 飽和；— 為缺資料或口徑不同</span></div>${heatmap(rows)}</section>
    ${methodologyHtml()}`;
  if (detailCode) renderTrendDetail(detailCode, detailPeriod || p);
  updatePeriodBadge();
  updateLastUpdated();
}

function deltaChart(rows) {
  const available = rows.filter(r => !['missing','incomparable'].includes(r.mom.status)).sort((a,b) => b.mom.delta-a.mom.delta);
  const max = Math.max(1, ...available.map(r => Math.abs(r.mom.delta)));
  return `<div class="delta-chart"><div class="delta-axis"><span>減少 ←</span><span>→ 增加（${state.displayUnit}）</span></div>${available.map(r => `<button class="delta-row" onclick="openTrendCompany('${r.code}')" aria-label="${r.name}較上月${signedNumber(r.mom.delta)}${state.displayUnit}"><span>${r.name}</span><span class="delta-track"><i class="${r.mom.delta >= 0 ? 'delta-up' : 'delta-down'}" style="width:${Math.abs(r.mom.delta)/max*49}%;${r.mom.delta >= 0 ? 'left:50%' : 'right:50%'}"></i></span><strong class="${r.mom.delta >= 0 ? 'up' : 'down'}">${signedNumber(r.mom.delta)}</strong></button>`).join('') || '<p class="empty-trend">沒有可比較的公司。</p>'}</div>`;
}
function heatmap(rows) {
  const periods = A.range(state.data.report_period,12);
  return `<div class="trend-table-wrap"><table class="heat-table"><thead><tr><th>公司</th>${periods.map(p=>`<th>${periodAd(p)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${r.name}</th>${periods.map(p=>{
    const c=A.comparison(monthCache,comparisonRules,r.code,[p],A.range(A.shift(p,-1),3),true);
    const pct=c.pct;
    const alpha=pct===null?0:Math.min(Math.abs(pct)/50,1)*0.22;
    const bg=pct===null?'#f4f5f7':`rgba(${pct>=0?'31,111,84':'163,49,42'},${alpha})`;
    const text=pct===null?(['missing','incomparable'].includes(c.status)?'—':changeText(c)):`${pct>0?'+':''}${pct.toFixed(0)}%`;
    return `<td><button style="background:${bg}" title="${escapeHtml(comparisonTitle(c))}" aria-label="${r.name} ${periodAd(p)} ${changeText(c)}" onclick="openTrendCompany('${r.code}','${p}')">${text}</button></td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function openTrendCompany(code, period = state.data.report_period) {
  detailCode = code;
  state.trendWindow = state.trendWindow || 12;
  if (period < A.range(state.data.report_period, state.trendWindow)[0]) state.trendWindow = 12;
  renderTrendDetail(code,period);
  document.getElementById('trend-detail').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeTrendDetail() { detailCode=null; detailPeriod=null; document.getElementById('trend-detail').classList.add('hidden'); }
function renderTrendDetail(code, selectedPeriod = state.data.report_period) {
  const container=document.getElementById('trend-detail');
  if (!container) return;
  const r=allTrendRows().find(r=>r.code===code);
  if (!r) return;
  const periods=A.range(state.data.report_period,state.trendWindow||12);
  if (!periods.includes(selectedPeriod)) selectedPeriod = periods.at(-1);
  detailPeriod = selectedPeriod;
  const points=periods.map(p=>A.value(monthCache,p,code));
  const averages=periods.map(p=>{
    const months=A.range(p,3), c=A.complete(monthCache,months,code);
    return c.sum===null||A.reason(comparisonRules,code,months,[])?null:c.sum/3;
  });
  const chosen=A.row(monthCache,comparisonRules,selectedPeriod,code,r.name);
  const src=A.company(monthCache,selectedPeriod,code);
  const lo=Math.min(0,...points.filter(A.finite),...averages.filter(A.finite)),hi=Math.max(0,...points.filter(A.finite),...averages.filter(A.finite)),span=hi-lo||1;
  const step=700/periods.length,y=v=>190-(v-lo)/span*150,zero=y(0);
  let path='',connected=false;
  averages.forEach((v,i)=>{if(v===null){connected=false;return;}path+=`${connected?'L':'M'}${50+(i+.5)*step},${y(v)} `;connected=true;});
  const current=A.reconcile(monthCache,comparisonRules,code,A.yearMonths(selectedPeriod));
  container.classList.remove('hidden');
  container.innerHTML=`<div class="trend-section-head"><div><p class="eyebrow">${r.code} · 個別公司</p><h3>${r.name}的獲利變化</h3></div><button class="btn btn-close" aria-label="關閉公司趨勢" onclick="closeTrendDetail()">✕</button></div>
    <div class="trend-tools"><label>顯示月份<select onchange="setTrendWindow(this.value)"><option value="6" ${state.trendWindow===6?'selected':''}>近 6 月</option><option value="12" ${state.trendWindow!==6?'selected':''}>近 12 月</option></select></label><label>查看數字<select id="detail-month" onchange="renderTrendDetail('${code}',this.value)">${periods.map(p=>`<option value="${p}" ${p===selectedPeriod?'selected':''}>${periodAd(p)}</option>`).join('')}</select></label><span>單位：${state.displayUnit} · 藍柱：單月 · 深色線：含當月的 3 月移動平均</span></div>
    <svg class="history-chart" viewBox="0 0 780 235" role="img" aria-label="${r.name}單月獲利與3月移動平均；完整數字見下方月份表"><line x1="50" x2="750" y1="${zero}" y2="${zero}" stroke="#9aa3b2"/><text x="44" y="${zero+4}" text-anchor="end">0</text><text x="44" y="35" text-anchor="end">${trendNumber(hi)}</text>${points.map((v,i)=>v===null?'':`<rect x="${50+i*step+step*.18}" y="${Math.min(zero,y(v))}" width="${step*.64}" height="${Math.max(1,Math.abs(y(v)-zero))}" fill="${v<0?'#a3312a':'#1a3fa0'}" opacity="${periods[i]===selectedPeriod?1:.65}"><title>${periodAd(periods[i])}：${trendNumber(v)} ${state.displayUnit}</title></rect>`).join('')}<path d="${path}" fill="none" stroke="#152b35" stroke-width="2.5"/>${periods.map((p,i)=>`<text x="${50+(i+.5)*step}" y="218" text-anchor="middle">${p.slice(4)}</text>`).join('')}</svg>
    <div class="detail-metrics"><div><small>${periodAd(selectedPeriod)} 單月獲利</small><strong>${trendNumber(chosen.monthly)}</strong></div>${[['較上月','mom'],['相對前 3 月平均','average'],['近 3 月 vs 前 3 月','rolling'],['單月 YoY','yoy']].map(([label,key])=>`<div><small>${label}</small><strong>${metricHtml(chosen[key])}</strong><p>${escapeHtml(comparisonTitle(chosen[key]))}</p></div>`).join('')}</div>
    ${chosen.notes.length?`<div class="basis-explanation">${chosen.notes.map(n=>`<p>${escapeHtml(n)}</p>`).join('')}</div>`:''}
    <div class="reconciliation"><strong>今年單月加總與公告累計核對</strong><p>1–${Number(selectedPeriod.split('/')[1])} 月單月加總 ${trendNumber(current.sum)}；公告累計 ${trendNumber(current.cumulative)}；差額（累計 − 加總）${signedNumber(current.delta)} ${state.displayUnit}。</p><p>${escapeHtml(current.note||'數值在公告四捨五入容差內。')} 趨勢使用原始單月公告數；期間比較使用累計軋差。</p></div>
    <details class="history-data" open><summary>各月原始數字與公告</summary><div class="trend-table-wrap"><table><thead><tr><th>月份</th><th>單月獲利</th><th>3 月移動平均</th><th>原始公告／狀態</th></tr></thead><tbody>${periods.map((p,i)=>{const c=A.company(monthCache,p,code);return `<tr><th><button class="company-link" onclick="renderTrendDetail('${code}','${p}')">${periodAd(p)}</button></th><td class="num">${trendNumber(points[i])}</td><td class="num">${trendNumber(averages[i])}</td><td>${c?.source_url?`<a href="${escapeHtml(c.source_url)}" target="_blank" rel="noopener">${dateAd(c.announcement_date)||'原始公告'} ↗</a>`:'未取得公告'}${comparisonRules.revisions[`${code}|${p}`]?'<small>公告累計重編</small>':''}</td></tr>`;}).join('')}</tbody></table></div></details>
    ${src?.holding_company?.fvoci_adjusted?`<details class="history-data"><summary>FVOCI 補充揭露（獨立口徑）</summary><p>單月 ${fvociDisplay(src.holding_company.fvoci_adjusted,src.unit,state.displayUnit).monthlyDisp}；累計 ${fvociDisplay(src.holding_company.fvoci_adjusted,src.unit,state.displayUnit).cumulDisp} ${state.displayUnit}。不納入上述趨勢與成長率。</p><p>${escapeHtml(src.holding_company.fvoci_adjusted.source_quote||'依公司補充揭露數。')}</p></details>`:''}
    <button class="btn trend-full-detail" onclick="showDetail('${code}')">查看 ${periodAd(state.data.report_period)} 子公司明細與新聞</button>`;
}

function methodologyHtml() {
  return `<details class="methodology"><summary>計算方式、比較口徑與標記規則</summary><ul>
    <li>所有計算先轉為百萬元；顯示與匯出可切換億元。資料來源為 MOPS 月自結公告，各月保留原公告值。</li>
    <li>MoM＝（當月−上月）÷上月；相對前 3 月平均的基準不含當月。近 3 月比較為兩段互不重疊的 3 個月單月加總；跨年不使用累計相減。</li>
    <li>單月、累計與期間 YoY＝（本期−去年同期）÷去年同期絕對值，列示百分比；去年同期為零時顯示 —，缺值時標示資料不足。MoM 與近期均值比較的負值、跨零及低基期則列狀態與差額。低基期＝基期絕對值不高於 15 百萬元（合計依月數放大），或不高於比較窗口單月絕對值中位數的 10%。</li>
    <li>任一月份缺資料，整段比較停算；未公告、抓取失敗均不補零。迷你圖遇缺值、合併或會計口徑變更斷線；各公司獨立刻度僅供觀察形狀。</li>
    <li>金控與壽險稅後淨利 YoY 按各期公告數列示，合併與會計新制不取代變動率，事件另供參考：${Object.values(comparisonRules.mergers).map(e=>`<a href="${e.source}" target="_blank" rel="noopener">${e.label}</a>`).join('；')}；<a href="${comparisonRules.accounting.source}" target="_blank" rel="noopener">2026 年壽險新制</a>。MoM 與近期均值比較跨越上述事件時仍停算百分比。</li>
    <li>FVOCI 加計數與原始損益分開；金控與壽險加計列的累計 YoY 留白。門檻值保留「逾／突破」，不當精確值計算。加計數不納入近期趨勢。</li>
    <li>連續 3 次月增／月減需 4 個月完整可比資料；近 6 月新高／低需 6 個月且嚴格高於／低於其餘月份。偏離均值標記採 ±20%，為篩選規則，不代表統計顯著或未來預測。</li>
    <li>單月加總與累計軋差分別揭露。合庫金單月含非控制權益、累計歸屬母公司業主，兩者不混用。其他差異先標待核對；已知重編另列說明。</li>
    <li>完整月報單月 EPS 僅顯示公告值；未揭露留空。期間 EPS 為累計 EPS 軋差推算，可能受股本變動影響。</li>
    </ul></details>`;
}

function comparisonExcel(c) {
  return c.pct !== null ? {v:c.pct/100,t:'n',z:'"+"0.0%;"-"0.0%',s:{...XS.yoy(c.pct)}} : xText(changeText(c),XS.noteCell);
}
function trendSheet(matrix, options) {
  const cols = options.cols;
  const rows = matrix.map((row, index) => {
    let lines = 1;
    row.forEach((cell, c) => {
      if (!cell || cell.t !== 's') return;
      const length = [...String(cell.v)].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
      lines = Math.max(lines, Math.ceil(length / Math.max(8, (cols[c]?.wch || 20) - 3)));
      cell.s = { ...cell.s, alignment: { ...cell.s?.alignment, horizontal:'left', vertical:'center', wrapText:true } };
    });
    return { hpx: Math.max(index === 0 ? 42 : 28, lines * 18 + 10) };
  });
  const sheet = xSheet(matrix, { ...options, rows });
  sheet['!autofilter'] = { ref:sheet['!ref'] };
  return sheet;
}
function appendTrendSheets(wb,XLSX) {
  const p=state.data.report_period, rows=visibleTrendRows();
  const header=['代號','公司',`當月 ${periodAd(p)} (${state.displayUnit})`,'較上月增減金額','MoM','前3月平均','相對前3月平均','近3月合計','再前3月合計','近3月增減率','去年同月','單月YoY','變化標記','口徑／資料說明'];
  const matrix=[header.map(s=>xText(s,XS.headCol()))];
  for(const r of rows) matrix.push([xText(r.code),xText(r.name),xNum(convertUnit(r.monthly,'百萬元',state.displayUnit)),xNum(['missing','incomparable'].includes(r.mom.status)?null:convertUnit(r.mom.delta,'百萬元',state.displayUnit)),comparisonExcel(r.mom),xNum(convertUnit(r.average.base,'百萬元',state.displayUnit)),comparisonExcel(r.average),xNum(convertUnit(r.rolling.cur,'百萬元',state.displayUnit)),xNum(convertUnit(r.rolling.base,'百萬元',state.displayUnit)),comparisonExcel(r.rolling),xNum(convertUnit(r.yoy.base,'百萬元',state.displayUnit)),comparisonExcel(r.yoy),xText(r.labels.join('；')),xText([...r.notes,...[r.mom,r.average,r.rolling,r.yoy].filter(c=>c.status==='missing').map(comparisonTitle)].join('；'))]);
  XLSX.utils.book_append_sheet(wb,trendSheet(matrix,{cols:header.map((_,i)=>({wch:i>11?65:i===1?16:22}))}),'趨勢重點');
  const data=[['代號','公司','資料月份','單月獲利','公告累計','單月加總至本月','累計減單月加總','資料狀態／口徑','來源公告','單位'].map(s=>xText(s,XS.headCol()))];
  for(const r of rows) for(const month of A.range(p,15)) {
    const c=A.company(monthCache,month,r.code),rec=A.reconcile(monthCache,comparisonRules,r.code,A.yearMonths(month));
    data.push([xText(r.code),xText(r.name),xText(periodAd(month)),xNum(convertUnit(A.value(monthCache,month,r.code),'百萬元',state.displayUnit)),xNum(convertUnit(A.value(monthCache,month,r.code,'cumulative_profit'),'百萬元',state.displayUnit)),xNum(convertUnit(rec.sum,'百萬元',state.displayUnit)),xNum(convertUnit(rec.delta,'百萬元',state.displayUnit)),xText(!c?'未取得資料':rec.note||'原始公告數'),xText(c?.source_url||''),xText(state.displayUnit)]);
  }
  XLSX.utils.book_append_sheet(wb,trendSheet(data,{cols:[{wch:9},{wch:18},{wch:14},...Array.from({length:4},()=>({wch:22})),{wch:70},{wch:80},{wch:12}]}),'歷史原始數據');
  const method=[['項目','說明'],['報告月份',periodAd(p)],['單位',state.displayUnit],['顯示篩選',trendFilter],['前3月平均基準',A.range(A.shift(p,-1),3).map(periodAd).join('、')],['近3月比較',`${A.range(p,3).map(periodAd).join('、')} vs ${A.range(A.shift(p,-3),3).map(periodAd).join('、')}`],['計算口徑','趨勢使用原始單月公告數；期間比較為累計軋差；不含FVOCI加計數。'],['YoY','（本期－去年同期）÷去年同期絕對值。原始稅後淨利列示百分比，會計新制及合併事件另註。零基期為 —，缺值標示資料不足；金控與壽險加計 FVOCI 累計 YoY 留白。'],['近期比較百分比','MoM 與近期均值：基期為正且高於低基期門檻時計算。負值、跨零、低基期改列狀態及差額。'],['低基期','不高於15百萬元×基期月數，或比較窗口單月絕對值中位數10%×基期月數。平均比較月數以1計。'],['可比性','缺值不補零。MoM 與近期均值檢查整段窗口，跨併購、過渡月或2026壽險新制不計百分比；YoY 照列公告數變動率。'],['變化標記','連3次月增減須4月；近6月高低須6月且嚴格創高低；相對前3月均值偏離±20%標示。'],['資料更正','原公告單月加總與累計軋差各自保留，差異另標示；合庫金兩者口徑不同。'],['來源','台灣金控月自結獲利追蹤（Mandy Chao），https://github.com/MllePallas/tw_fhcs_tracker，CC BY 4.0。原始公告見歷史原始數據。']];
  XLSX.utils.book_append_sheet(wb,trendSheet(method.map((row,i)=>row.map(s=>xText(s,i===0?XS.headCol():XS.text))),{cols:[{wch:25},{wch:110}]}),'比較口徑');
}

function trendSnapshot() {
  const rows=visibleTrendRows(),canvas=document.createElement('canvas');
  canvas.width=2400;canvas.height=(160+rows.length*76+140)*2;
  const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.fillStyle='#fff';ctx.fillRect(0,0,1200,canvas.height/2);
  ctx.fillStyle='#101418';ctx.font='bold 24px Microsoft JhengHei';ctx.fillText(`金控趨勢重點 · ${periodAd(state.data.report_period)}`,30,42);
  ctx.font='14px Microsoft JhengHei';ctx.fillText(`單位：${state.displayUnit} · 原始單月自結數，不含 FVOCI 加計數 · ${METRIC_LABELS[trendMetric]}`,30,70);
  const x=[30,195,350,565,800];ctx.fillStyle='#eef1f9';ctx.fillRect(20,90,1160,42);ctx.fillStyle='#3d4653';ctx.font='bold 15px Microsoft JhengHei';
  ['公司','當月獲利','較上月增減',METRIC_LABELS[trendMetric],'變化／口徑'].forEach((t,i)=>ctx.fillText(t,x[i],117));
  rows.forEach((r,i)=>{const y=160+i*76;ctx.fillStyle='#101418';ctx.font='bold 17px Microsoft JhengHei';ctx.fillText(r.name,x[0],y);ctx.fillText(trendNumber(r.monthly),x[1],y);ctx.fillText(changeText(r.mom),x[2],y);ctx.fillText(changeText(r[trendMetric]),x[3],y);ctx.font='13px Microsoft JhengHei';ctx.fillStyle='#6b7684';ctx.fillText(r.code,x[0],y+23);if(!['missing','incomparable'].includes(r.mom.status))ctx.fillText(`${signedNumber(r.mom.delta)} ${state.displayUnit}`,x[2],y+23);ctx.fillText(`基準 ${trendNumber(r[trendMetric].base)}`,x[3],y+23);const labels=[...r.labels,r.notes.length?'另有口徑說明，詳見網站':''].filter(Boolean);ctx.fillText(labels[0]||'—',x[4],y);ctx.fillText(labels[1]||'',x[4],y+23);ctx.strokeStyle='#e6e8ec';ctx.beginPath();ctx.moveTo(20,y+40);ctx.lineTo(1180,y+40);ctx.stroke();});
  const y=170+rows.length*76;ctx.fillStyle='#6b7684';ctx.font='13px Microsoft JhengHei';ctx.fillText(`基準月份：${comparisonTitle(rows[0]?.[trendMetric]||{status:'missing'}) .split('；')[0]}`,30,y);ctx.fillText('YoY 按公告數列變動率；MoM 與近期均值遇跨制、低基期及虧損另列狀態。',30,y+25);ctx.fillText('資料來源：台灣金控月自結獲利追蹤（Mandy Chao）· MOPS · CC BY 4.0',30,y+50);ctx.fillText('https://tw-fhcs-tracker.vercel.app/',30,y+75);
  return canvas;
}
