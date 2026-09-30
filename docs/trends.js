'use strict';

const A = ProfitAnalytics;
let comparisonRules;
let trendFilter = 'all';
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
  zero_base: '零基期', zero_to_profit: '零轉盈', zero_to_loss: '零轉虧', flat: '持平', low_base: '低基期',
};
function trendNumber(n) { return n == null ? '—' : new Intl.NumberFormat('zh-TW', { minimumFractionDigits: state.displayUnit === '億元' ? 1 : 0, maximumFractionDigits: 1 }).format(convertUnit(n, '百萬元', state.displayUnit)); }
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
  return [...names].map(([code, name]) => trendRow(p, code, name));
}
// Only comparisons displayed on this page contribute notes and filters.
function trendRow(period, code, name) {
  const r = A.row(monthCache, comparisonRules, period, code, name);
  r.notes = [...new Set([r.mom, r.yoy].filter(c => c.reason && c.status !== 'missing').map(c => c.reason))];
  return r;
}
function validMonthlyDelta(r) {
  return ['missing', 'incomparable'].includes(r.mom.status) ? null : r.mom.delta;
}
function monthlyDeltaHtml(r) {
  const delta = validMonthlyDelta(r);
  return `<span class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${signedNumber(delta)}</span>`;
}
function trendHighlights(rows) {
  const available = rows.filter(r => validMonthlyDelta(r) !== null);
  const up = available.filter(r => r.mom.delta > 0).sort((a,b) => b.mom.delta-a.mom.delta);
  const down = available.filter(r => r.mom.delta < 0).sort((a,b) => a.mom.delta-b.mom.delta);
  const turns = available.filter(r => ['loss_to_profit','profit_to_loss'].includes(r.mom.status))
    .sort((a,b) => Math.abs(b.mom.delta)-Math.abs(a.mom.delta));
  return [up[0], down[0], ...turns, ...available.filter(r => r.mom.delta !== 0)
    .sort((a,b) => Math.abs(b.mom.delta)-Math.abs(a.mom.delta))]
    .filter((r,i,all) => r && all.findIndex(x => x?.code === r.code) === i).slice(0,4);
}
function visibleTrendRows() {
  const rows = allTrendRows().filter(r => trendFilter === 'all' ||
    (trendFilter === 'up' && r.mom.direction > 0) || (trendFilter === 'down' && r.mom.direction < 0) ||
    (trendFilter === 'turn' && ['loss_to_profit', 'profit_to_loss', 'zero_to_profit', 'zero_to_loss'].includes(r.mom.status)) ||
    (trendFilter === 'flag' && r.labels.length) ||
    (trendFilter === 'missing' && [r.mom, r.yoy].some(c => ['missing', 'incomparable'].includes(c.status))));
  const key = r => {
    const delta = validMonthlyDelta(r);
    if (state.sortMode === 'trend_amount') return r.monthly;
    if (delta === null) return null;
    if (state.sortMode === 'trend_up') return delta;
    if (state.sortMode === 'trend_down') return -delta;
    return Math.abs(delta);
  };
  if (state.sortMode === 'code') rows.sort((a,b) => a.code.localeCompare(b.code));
  else rows.sort((a,b) => (key(b) ?? -Infinity)-(key(a) ?? -Infinity) || a.code.localeCompare(b.code));
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
function setTrendWindow(value) { state.trendWindow = Number(value); if (detailCode) renderTrendDetail(detailCode, detailPeriod); }

function renderTrendDashboard() {
  if (!comparisonRules || !state.data) return;
  const rows = visibleTrendRows(), all = allTrendRows();
  const p = state.data.report_period, unit = state.displayUnit;
  const valid = all.filter(r => r.monthly !== null).length;
  const comparable = all.filter(r => !['missing', 'incomparable'].includes(r.mom.status));
  const highlights = trendHighlights(all);
  document.getElementById('trend-root').innerHTML = `
    ${typeof monthlyReportHtml === 'function' ? monthlyReportHtml(p) : ''}
    <section class="trend-intro"><div><p class="eyebrow">${periodLabel(p)} · 趨勢重點</p><h2>先看變化，再看數字</h2><p>原始單月稅後淨利，不含 FVOCI 加計數。查看月增減金額、單月年增率與歷史走勢。</p></div><div class="coverage"><strong>${valid}<span> / ${all.length}</span></strong><span>家單月資料已取得</span></div></section>
    <div class="trend-breadth">與上月可比較 ${comparable.length} 家：<strong class="up">${comparable.filter(r => r.mom.direction > 0).length} 家增加</strong><strong class="down">${comparable.filter(r => r.mom.direction < 0).length} 家減少</strong><span>${comparable.filter(r => r.mom.direction === 0).length} 家持平</span><span>其餘 ${all.length - comparable.length} 家缺資料或口徑不同</span></div>
    <div class="trend-highlights">${highlights.map(r => `<button class="trend-highlight" onclick="openTrendCompany('${r.code}')"><span>${r.name} <small>${r.code}</small></span><strong>${r.mom.delta > 0 ? '增加' : '減少'} ${trendNumber(Math.abs(r.mom.delta))}<small>${unit} · MoM ${changeText(r.mom)}</small></strong><span>${r.labels.filter(label => label !== changeText(r.mom)).join(' · ') || '較上月獲利變化'}</span><span class="highlight-link">查看月份數字 →</span></button>`).join('') || '<p class="empty-trend">目前無可列示的月度增減。</p>'}</div>
    <section class="trend-section"><div class="trend-section-head"><div><h3>金控趨勢總覽</h3><p>點公司查看歷史數字；迷你圖為各公司獨立刻度。</p></div><div class="trend-tools"><label>篩選<select id="trend-filter" onchange="setTrendFilter(this.value)">${[['all','全部公司'],['up','較上月增加'],['down','較上月減少'],['turn','轉盈／轉虧'],['flag','有變化標記'],['missing','資料或口徑待留意']].map(([v,t]) => `<option value="${v}" ${trendFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div></div>
    <p class="trend-unit">單位：${unitFullLabel(unit)} · ${periodAd(p)} · 顯示 ${rows.length} 家 <span>← 窄螢幕可左右滑動</span></p>
    <div class="trend-table-wrap"><table class="trend-table"><thead><tr><th>公司</th><th>當月獲利</th><th>較上月增減金額</th><th>MoM</th><th>單月 YoY</th><th>近 12 月走勢</th><th>變化標記／口徑</th></tr></thead><tbody>${rows.map(r => `<tr id="trend-row-${r.code}"><th><button class="company-link" onclick="openTrendCompany('${r.code}')">${r.name}</button><small>${r.code}</small></th><td class="num ${r.monthly < 0 ? 'negative' : ''}">${trendNumber(r.monthly)}${r.monthly === null ? '<small>未取得當月數</small>' : ''}</td><td class="num">${monthlyDeltaHtml(r)}</td><td class="num">${metricHtml(r.mom,false)}</td><td class="num">${metricHtml(r.yoy,false)}</td><td><button class="spark-button" aria-label="查看${r.name}歷史趨勢" onclick="openTrendCompany('${r.code}')">${sparkline(r)}</button></td><td class="trend-tags">${r.labels.map(s => `<span>${s}</span>`).join('') || '<span class="muted">—</span>'}${r.notes.length ? `<button class="basis-flag" onclick="openTrendCompany('${r.code}')" title="${escapeHtml(r.notes.join('；'))}">比較說明 ${r.notes.length}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-trend">沒有符合篩選的公司。請切換「全部公司」。</td></tr>'}</tbody></table></div></section>
    <section id="trend-detail" class="trend-detail ${detailCode ? '' : 'hidden'}" aria-live="polite"></section>
    <section class="trend-section"><div class="trend-section-head"><div><h3>過去 12 個月，各月獲利月增減</h3><p>每格為該月 MoM；點選查看當月、前月獲利及增減金額。月度方向不同僅供追查，不代表特定業務的影響。</p></div></div><div class="heat-legend"><span class="heat-negative">較上月減少</span><span>持平</span><span class="heat-positive">較上月增加</span><span>顏色於 ±50% 飽和；轉盈、轉虧與低基期列文字；— 為缺資料或口徑不同</span></div>${heatmap(rows)}</section>
    ${methodologyHtml()}`;
  if (detailCode) renderTrendDetail(detailCode, detailPeriod || p);
  updatePeriodBadge();
  updateLastUpdated();
}

function heatmap(rows) {
  const periods = A.range(state.data.report_period,12);
  return `<div class="trend-table-wrap"><table class="heat-table"><thead><tr><th>公司</th>${periods.map(p=>`<th>${periodAd(p)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${r.name}</th>${periods.map(p=>{
    const c=A.comparison(monthCache,comparisonRules,r.code,[p],[A.shift(p,-1)]);
    const pct=c.pct;
    const alpha=pct===null?0:Math.min(Math.abs(pct)/50,1)*0.22;
    const bg=pct===null?'#f4f5f7':`rgba(${pct>=0?'31,111,84':'163,49,42'},${alpha})`;
    const text=pct===null?(['missing','incomparable'].includes(c.status)?'—':changeText(c)):`${pct>0?'+':''}${pct.toFixed(1)}%`;
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
  const chosen=trendRow(selectedPeriod,code,r.name);
  const lo=Math.min(0,...points.filter(A.finite)),hi=Math.max(0,...points.filter(A.finite)),span=hi-lo||1;
  const step=700/periods.length,y=v=>190-(v-lo)/span*150,zero=y(0);
  container.classList.remove('hidden');
  container.innerHTML=`<div class="trend-section-head"><div><p class="eyebrow">${r.code} · 個別公司</p><h3>${r.name}的獲利變化</h3></div><button class="btn btn-close" aria-label="關閉公司趨勢" onclick="closeTrendDetail()">✕</button></div>
    <div class="trend-tools"><label>顯示月份<select onchange="setTrendWindow(this.value)"><option value="6" ${state.trendWindow===6?'selected':''}>近 6 月</option><option value="12" ${state.trendWindow!==6?'selected':''}>近 12 月</option></select></label><label>查看數字<select id="detail-month" onchange="renderTrendDetail('${code}',this.value)">${periods.map(p=>`<option value="${p}" ${p===selectedPeriod?'selected':''}>${periodAd(p)}</option>`).join('')}</select></label><span>單位：${state.displayUnit} · 柱狀：單月獲利 · 點選柱狀查看數字</span></div>
    <svg class="history-chart" viewBox="0 0 780 235" role="img" aria-label="${r.name}各月單月獲利；可使用月份選單查看數字"><line x1="50" x2="750" y1="${zero}" y2="${zero}" stroke="#9aa3b2"/><text x="44" y="${zero+4}" text-anchor="end">0</text><text x="44" y="35" text-anchor="end">${trendNumber(hi)}</text>${points.map((v,i)=>v===null?'':`<rect onclick="renderTrendDetail('${code}','${periods[i]}')" style="cursor:pointer" x="${50+i*step+step*.18}" y="${Math.min(zero,y(v))}" width="${step*.64}" height="${Math.max(1,Math.abs(y(v)-zero))}" fill="${v<0?'#a3312a':'#1a3fa0'}" opacity="${periods[i]===selectedPeriod?1:.65}"><title>${periodAd(periods[i])}：${trendNumber(v)} ${state.displayUnit}</title></rect>`).join('')}${periods.map((p,i)=>`<text x="${50+(i+.5)*step}" y="218" text-anchor="middle">${periodAd(p)}</text>`).join('')}</svg>
    <div class="detail-metrics"><div><small>${periodAd(selectedPeriod)} 單月獲利</small><strong>${trendNumber(chosen.monthly)}</strong><p>${state.displayUnit}</p></div><div><small>${periodAd(A.shift(selectedPeriod,-1))} 前月獲利</small><strong>${trendNumber(chosen.mom.base)}</strong><p>${state.displayUnit}</p></div><div><small>較上月增減金額</small><strong>${monthlyDeltaHtml(chosen)}</strong><p>${state.displayUnit}</p></div>${[['MoM','mom'],['單月 YoY','yoy']].map(([label,key])=>`<div><small>${label}</small><strong>${metricHtml(chosen[key],false)}</strong><p>${escapeHtml(comparisonTitle(chosen[key]))}</p></div>`).join('')}</div>
    ${chosen.notes.length?`<div class="basis-explanation">${chosen.notes.map(n=>`<p>${escapeHtml(n)}</p>`).join('')}</div>`:''}
    <button class="btn trend-full-detail" onclick="openTrendOverview('${code}','${selectedPeriod}')">前往 ${periodAd(selectedPeriod)} 金控總覽：公告、子公司與新聞 →</button>`;

}

async function openTrendOverview(code, period) {
  // Keep the chosen history month when navigating to the source details.
  if (state.data?.report_period !== period) {
    document.getElementById('month-select').value = period;
    await loadData(period);
  }
  if (state.loading || state.data?.report_period !== period) return;
  document.getElementById('month-select').value = period;
  state.viewMode = 'holdings';
  document.querySelectorAll('.industry-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.view === 'holdings'));
  setPageMode('monthly');
  showDetail(code);
}

function methodologyHtml() {
  return `<details class="methodology"><summary>計算方式與標記規則</summary><ul>
    <li>資料來源為 MOPS 月自結。趨勢使用原始單月稅後淨利，不含 FVOCI 加計數；期間均以西元年／月顯示。</li>
    <li>月增減金額＝當月−前月；MoM＝（當月−前月）÷前月。負值、轉盈轉虧、零基期與低基期改列狀態及金額，不顯示誤導的百分比。低基期門檻為 15 百萬元與比較兩月獲利絕對值中位數的 10% 取較高者。</li>
    <li>單月 YoY＝（當月−去年同月）÷去年同月絕對值。會計新制與合併事件另註，YoY 仍列公告數變動率；去年同月為零或缺值時不計百分比。MoM 跨越口徑變更時停止比較。</li>
    <li>重點卡片優先列月增、月減金額最大的公司，再列轉盈、轉虧及其餘增減金額較大的公司；公司不重複，最多四家。預設依月增減金額絕對值排序。</li>
    <li>連續 3 次月增／月減需 4 個月完整可比資料；近 6 月新高／低需 6 個月且嚴格高於／低於其餘月份。標記描述歷史數字，不代表經營改善、惡化或未來預測。</li>
    <li>未公告與缺值不補零；走勢圖在缺值或口徑變更處斷線，各公司採獨立刻度。完整公告、子公司與新聞請至對應月份的金控總覽查閱。</li>
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
