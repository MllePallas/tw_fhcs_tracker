// app.js — 台灣金控月自結獲利追蹤器前端邏輯

'use strict';

// ── 設定 ──────────────────────────────────────────────
const CONFIG = {
  indexUrl:  './data/index.json',
  latestUrl: './data/latest.json',
};

// ── 全域狀態 ───────────────────────────────────────────
let state = {
  data: null,
  baseline: null,        // 去年同期資料（圖表對照用；缺檔時為 null）
  index: null,
  reports: [],           // 月度分析報告索引（docs/reports/index.json）
  displayUnit: '百萬元',
  sortMode: 'code',
  viewMode: 'holdings',    // 'holdings' | 'bank' | 'life' | 'securities'
  mobileLayout: 'table',   // 手機版型：'table'（預設，完整總表）| 'card'
  barChart: null,
  cumulChart: null,
  // ── 草稿新增 ──
  pageMode: 'monthly',     // 完整月報（預設）、趨勢重點、期間比較
  periodSel: null,         // 期間比較目前選取的期間（buildPeriodOptions 產生）
  periodOptions: [],       // 期間選項清單
  prevMonth: null,         // 上月資料（MoM 欄與變動拆解用；缺檔為 null）
};

// 手機版型切換：預設「總表」＝與桌機相同的完整表格（橫向捲動、公司名固定），
// 使用者可切到「卡片」。桌機不受影響（切換鈕僅手機顯示）。
function setMobileLayout(mode) {
  state.mobileLayout = mode === 'card' ? 'card' : 'table';
  document.body.classList.toggle('ml-card', state.mobileLayout === 'card');
  document.querySelectorAll('.mobile-view-toggle .mv-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mv === state.mobileLayout);
  });
  renderTable();
}

// ── 年份顯示：資料內部一律民國年，顯示層一律西元年 ──────
// 期別比較（如 period < '115/07'）務必用原始民國年字串，不可用轉換後的值。
function adYear(rocYear) {
  return parseInt(rocYear, 10) + 1911;
}
// "115/06" → "2026/06"
function periodAd(period) {
  const m = String(period || '').match(/^(\d{2,3})\/(\d{1,2})$/);
  return m ? `${adYear(m[1])}/${m[2].padStart(2, '0')}` : (period || '');
}
// "115/06" → "2026年6月"
function periodLabel(period) {
  const m = String(period || '').match(/^(\d{2,3})\/(\d{1,2})$/);
  return m ? `${adYear(m[1])}年${parseInt(m[2], 10)}月` : (period || '');
}
// "115/07/14" → "2026/07/14"
function dateAd(d) {
  const m = String(d || '').match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  return m ? `${adYear(m[1])}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : (d || '');
}
// ISO 時間字串 → "2026/07/15"（西元、補零）
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
// ISO 時間字串 → "2026/07/15 16:34"
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// "115/06" → "114/06"（去年同期，仍為民國年，供載入 baseline 檔用）
function prevYearPeriod(period) {
  const m = String(period || '').match(/^(\d{2,3})\/(\d{1,2})$/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10) - 1).padStart(3, '0')}/${m[2].padStart(2, '0')}`;
}

// ── 視角切換 ───────────────────────────────────────────
function setView(mode) {
  state.viewMode = mode;
  document.querySelectorAll('.industry-tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  renderAll();
  resetTableScroll();
}

// 手機的表格可橫向捲動；切換視角／月份後回到最左邊，避免停在上一個視角的捲動位置
function resetTableScroll() {
  const tc = document.querySelector('.table-container');
  if (tc) tc.scrollLeft = 0;
}

// 產業分類（依子公司名稱判斷）
function classifyIndustry(name) {
  if (!name) return null;
  if (name.includes('銀行')) return 'bank';
  if (name.includes('人壽')) return 'life';
  if (name.includes('證券')) return 'securities';
  return null;
}

// 公告 YoY 顯示變動率；近期比較的狀態標籤保留供其他指標使用。
// abs 在 JSON 中與 cumul 同單位（百萬元），顯示時跟著 displayUnit 換算
function formatYoY(pct, abs, status, sourceUnit, displayUnit) {
  if (status === 'not_presented') return { disp: '', cls: '' };
  if (status && status !== 'normal' && STATUS_LABELS[status]) {
    const label = STATUS_LABELS[status];
    const blocked = ['missing', 'incomparable', 'different_basis'].includes(status);
    const v = convertUnit(abs, sourceUnit, displayUnit);
    return { disp: blocked || v == null ? label : `${label} ${v > 0 ? '+' : ''}${formatNum(v)}`, cls: blocked ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '' };
  }
  if (pct == null) return { disp: '—', cls: '' };
  if (status === 'loss_to_profit' || status === 'profit_to_loss') {
    const label = status === 'loss_to_profit' ? '虧轉盈' : '盈轉虧';
    const cls = status === 'loss_to_profit' ? 'positive' : 'negative';
    if (abs != null) {
      const a = convertUnit(abs, sourceUnit, displayUnit);
      const sign = a >= 0 ? '+' : '';
      return { disp: `${label} ${sign}${formatNum(a)}`, cls };
    }
    return { disp: label, cls };
  }
  const cls = pct >= 0 ? 'positive' : 'negative';
  const sign = pct >= 0 ? '+' : '';
  return { disp: `${sign}${pct.toFixed(1)}%`, cls };
}

// 加計FVOCI股票處分利益後獲利顯示（壽險子公司與金控合併層級共用）。
// 多數金控（富邦、凱基）揭露具體數字 → 顯示數字 + YoY。
// 少數（國泰，以「對保留盈餘影響數」揭露）僅給區間/門檻 → value_type==='lower_bound'，
// 以「逾/突破 X」表示下界、不顯示 YoY（門檻值與去年精確值相除會得出假精度的百分比，語意誤導，故省略）。
// 當月數（monthly_profit）為選填：新聞有揭露（如凱基）才有，缺漏顯示 —。
// lower_bound 的當月數也是門檻值，須帶前綴（monthly_display_prefix，可與累計用字不同，
// 例：國泰人壽 115/07「單月逾160億、累計突破1,400億」），否則會被誤讀為精確值。
function fvociDisplay(a, sourceUnit, displayUnit) {
  const v = convertUnit(a.cumulative_profit, sourceUnit, displayUnit);
  const mv = convertUnit(a.monthly_profit, sourceUnit, displayUnit);
  const monthlyDisp = mv != null ? formatNum(mv) : '—';
  if (a.value_type === 'lower_bound') {
    const prefix = a.display_prefix || '逾';
    const mPrefix = a.monthly_display_prefix || prefix;
    const boundMonthly = mv != null ? `${mPrefix} ${formatNum(mv)}` : '—';
    return { monthlyDisp: boundMonthly, cumulDisp: `${prefix} ${formatNum(v)}`, yoyDisp: a.yoy_status === 'not_presented' ? '' : '—', isBound: true };
  }
  const yoyDisp = formatYoY(a.yoy_pct, a.yoy_abs, a.yoy_status, sourceUnit, displayUnit).disp;
  return { monthlyDisp, cumulDisp: formatNum(v), yoyDisp, isBound: false };
}

// FVOCI 加計列的標籤：表格一律統一顯示「加上FVOCI股票處分利益」。
// 國泰金控新聞稿實際用語為「對保留盈餘影響數」（存於 data 的 fvoci_adjusted.label，
// 並於註腳說明），但表格上不逐家換字，以維持橫向比較的一致性。
// 手機的固定欄位很窄 → 以 CSS 切換為縮寫（.fv-full / .fv-abbr），不需重繪。
const FVOCI_LABEL_TEXT = '（加上FVOCI股票處分利益）';   // 純文字版（Excel 匯出用）
function fvociRowLabel() {
  return `<span class="fv-full">${FVOCI_LABEL_TEXT}</span><span class="fv-abbr">＋FVOCI</span>`;
}

// FVOCI 註腳文字（壽險視角＝壽險子公司揭露；金控總覽＝金控合併層級揭露）
const FVOCI_FOOTNOTE = '壽險稅後淨利 YoY 按原始公告數計算；加計 FVOCI 股票處分利益列的累計 YoY 留白。各期未揭露金額以 — 表示，逾／突破保留為下界。';
const FVOCI_FOOTNOTE_HOLDINGS = '金控加計 FVOCI 股票處分利益列的累計 YoY 留白。單月與累計各依當期揭露；未揭露金額為 —，逾／突破表示下界。完整數字與引文見公司詳情。';
const FVOCI_FOOTNOTE_DETAIL = FVOCI_FOOTNOTE_HOLDINGS;

// All comparison windows use comparison-rules.json.
function showMergerNote(code, period) {
  return !!comparisonRules && !!A.reason(comparisonRules, code, A.yearMonths(period), A.yearMonths(A.shift(period, -12)));
}

// 金控層級併購／重大異動備註（前端靜態，不依賴爬蟲資料，重爬不會遺失）。
// 顯示於詳情面板底部。key = 金控代號。
const COMPANY_NOTES = {
  "2887": "元富證券於 2026/04/06 併入台新證券，台新證券數字自此含元富證券。",
  "2890": "京城銀行自 2025/10 起併入永豐金月自結獲利公告；2026 年累計與 2025 年累計合併範圍不同；YoY 仍依各期公告數計算。",
};

// YoY 排序鍵：虧轉盈 > 正成長 > 負成長 > 盈轉虧；同 tier 內依 pct 排序
function yoyTier(pct, status) {
  if (status === 'loss_to_profit') return 3;
  if (status === 'profit_to_loss') return 0;
  if (pct == null) return -1;
  return pct >= 0 ? 2 : 1;
}
function compareYoYDesc(aPct, aStatus, bPct, bStatus) {
  const at = yoyTier(aPct, aStatus);
  const bt = yoyTier(bPct, bStatus);
  if (at !== bt) return bt - at;
  return (bPct ?? -Infinity) - (aPct ?? -Infinity);
}

// 取出某產業的所有子公司列（含父金控資訊）。src 預設本期資料，圖表對照時傳入 baseline。
function getIndustryRows(industry, src) {
  const source = src || state.data;
  if (!source) return [];
  const rows = [];
  for (const c of source.companies || []) {
    if (c.error) continue;
    for (const s of c.subsidiaries || []) {
      if (classifyIndustry(s.name) !== industry) continue;
      rows.push({
        parent_name: c.name,
        parent_code: c.code,
        name: s.name,
        unit: c.unit,
        monthly_profit: s.monthly_profit,
        cumulative_profit: s.cumulative_profit,
        cumulative_profit_yoy_pct: s.cumulative_profit_yoy_pct,
        cumulative_profit_yoy_abs: s.cumulative_profit_yoy_abs,
        cumulative_profit_yoy_status: s.cumulative_profit_yoy_status,
        fvoci_adjusted: s.fvoci_adjusted || null,
      });
    }
  }
  return rows;
}

const VIEW_TITLES = {
  bank:       '銀行',
  life:       '壽險',
  securities: '證券',
};

// ── 啟動 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadComparisonRules().then(() => { setSortOptionsForMode(state.pageMode); return loadIndex(); }).catch(e => {
    document.getElementById('trend-root').textContent = `${e.message}，請重新整理後重試。`;
    showStatus('error', e.message);
  });
});

// ── 月份索引載入 ────────────────────────────────────────
async function loadIndex() {
  await loadReportIndex();
  try {
    const resp = await fetch(CONFIG.indexUrl + '?_=' + Date.now());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.index = await resp.json();
    renderMonthSelector(state.index.months);
    buildPeriodOptions();        // 草稿新增：期間比較選項
    renderPeriodSelector();
    // 預設載入最新月份
    await loadData(state.index.latest);
  } catch (e) {
    // index.json 不存在時，直接載入 latest.json
    renderMonthSelector([]);
    await loadData(null);
  }
}

// ── 月份選單渲染 ───────────────────────────────────────
function renderMonthSelector(months) {
  const sel = document.getElementById('month-select');
  if (!months || months.length === 0) {
    sel.innerHTML = '<option value="">最新月報</option>';
    return;
  }
  sel.innerHTML = months.map((m, i) => {
    const label = periodLabel(m.period);
    const tag   = i === 0 ? ' ★ 最新' : '';
    const count = m.success_count != null ? ` (${m.success_count}/13)` : '';
    return `<option value="${m.period}">${label}${count}${tag}</option>`;
  }).join('');
}

// ── 月份切換事件 ───────────────────────────────────────
async function onMonthChange() {
  const period = document.getElementById('month-select').value;
  await loadData(period || null);
}

// ── 資料載入 ───────────────────────────────────────────
let dataLoadVersion = 0;
async function loadData(period) {
  const version = ++dataLoadVersion;
  state.loading = true;
  showStatus('info', '正在載入所選月份與歷史資料…');
  closeDetail();
  detailCode = null;
  document.getElementById('trend-root').innerHTML = '<p class="loading-cell">正在載入所選月份…</p>';
  const url = period
    ? `./data/${period.replace('/', '-')}.json?_=${Date.now()}`
    : CONFIG.latestUrl + '?_=' + Date.now();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const next = await resp.json();
    if (version !== dataLoadVersion) return;
    if (period && next.report_period !== period) throw new Error('資料月份不符');
    state.data = next;
    monthCache[state.data.report_period] = state.data;   // 草稿新增：共用月份快取
    await loadTrendHistory();
    if (typeof loadMonthReport === 'function') await loadMonthReport(next.report_period);
    if (version !== dataLoadVersion) return;
    state.baseline = monthCache[prevYearPeriod(next.report_period)] || null;
    state.prevMonth = monthCache[prevMonthPeriod(next.report_period)] || null;
    state.loading = false;
    showStatus('', '');
    // 換月時關閉詳情面板：面板內容屬於前一個月份，留著會與表頭月份不一致
    closeDetail();
    renderAll();
    resetTableScroll();
  } catch (e) {
    if (version !== dataLoadVersion) return;
    state.loading = false;
    state.data = null;
    document.getElementById('trend-root').textContent = `無法載入所選月份：${e.message}。請重試或選擇其他月份。`;
    showStatus('error', `⚠️ 無法載入資料：${e.message}`);
    document.getElementById('main-tbody').innerHTML =
      `<tr><td colspan="6" class="loading-cell" style="color:#e53e3e">資料載入失敗</td></tr>`;
    document.getElementById('mobile-cards').innerHTML =
      `<div class="m-empty" style="color:#e53e3e">資料載入失敗</div>`;
  }
}

// ── 月度分析報告索引 ───────────────────────────────────
// 報告放在 docs/reports/，由 docs/reports/index.json 索引；此處只負責決定
// 「這個月份有沒有報告」與連結網址，內容渲染在 report.html。索引不存在時靜默略過。
async function loadReportIndex() {
  state.reports = [];
  try {
    const resp = await fetch(`./reports/index.json?_=${Date.now()}`);
    if (!resp.ok) return;
    const idx = await resp.json();
    if (idx && Array.isArray(idx.reports)) state.reports = idx.reports;
  } catch (e) {
    // 尚未建立報告索引 → 不顯示連結
  }
}

function reportForPeriod(period) {
  const want = periodAd(String(period || '').replace('-', '/'));
  return (state.reports || []).find(r => periodAd(String(r.period || '').replace('-', '/')) === want) || null;
}

// ── 去年同期資料（圖表對照用） ──────────────────────────
// 檔案不存在（如最早的月份、或 baseline 尚未歸檔）時靜默略過，圖表只顯示本期。
async function loadBaseline(period) {
  state.baseline = null;
  const prev = prevYearPeriod(period);
  if (!prev) return;
  try {
    const resp = await fetch(`./data/${prev.replace('/', '-')}.json?_=${Date.now()}`);
    if (!resp.ok) return;
    const b = await resp.json();
    if (b && Array.isArray(b.companies)) state.baseline = b;
  } catch (e) {
    // 無基期資料 → 圖表僅顯示本期
  }
}

// ── 主渲染 ─────────────────────────────────────────────
function renderAll() {
  if (!state.data || state.loading) return;
  state.displayUnit = document.getElementById('unit-select').value;
  state.sortMode    = document.getElementById('sort-select').value;
  renderMarketSummary();
  renderSummaryCards();
  if (state.pageMode === 'trend') { renderTrendDashboard(); return; }

  // 草稿新增：期間比較模式走獨立渲染流程
  if (state.pageMode === 'period') { renderPeriodAll(); return; }

  updatePeriodBadge();
  updateLastUpdated();
  renderMarketSummary();
  renderSummaryCards();
  renderTable();
  renderChart();
}

// ── 本月市場概況卡片 ───────────────────────────────────
function renderMarketSummary() {
  const section = document.getElementById('market-section');
  const m = state.data && state.data.market_summary;
  if (!m || !m.items) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const meta = document.getElementById('market-meta');
  const period = periodLabel(m.period || state.data.report_period) + '底';
  const ts = m.generated_at ? fmtDate(m.generated_at) : '';
  meta.textContent = `${period}收盤｜更新：${ts}｜資料：Yahoo Finance、TWSE`;

  const cards = [];
  const it = m.items;

  if (it.usdtwd && it.usdtwd.value != null) {
    cards.push(marketCard({
      label: '美元兌台幣',
      value: it.usdtwd.value.toFixed(3),
      unit: '',
      changeText: pctText(it.usdtwd.pct_change, '較上月底'),
      pct: it.usdtwd.pct_change,
    }));
  }
  if (it.taiex && it.taiex.value != null) {
    cards.push(marketCard({
      label: '加權指數',
      value: formatNum(it.taiex.value),
      unit: '點',
      changeText: pctText(it.taiex.pct_change, '較上月底'),
      pct: it.taiex.pct_change,
    }));
  }
  if (it.taiex_turnover && it.taiex_turnover.value_yi != null) {
    cards.push(marketCard({
      label: '台股集中市場日均成交額',
      value: formatNum(it.taiex_turnover.value_yi),
      unit: '億',
      changeText: pctText(it.taiex_turnover.pct_change, '較上月底'),
      pct: it.taiex_turnover.pct_change,
    }));
  }
  if (it.spx && it.spx.value != null) {
    cards.push(marketCard({
      label: '美股 S&P 500',
      value: formatNum(it.spx.value),
      unit: '',
      changeText: pctText(it.spx.pct_change, '較上月底'),
      pct: it.spx.pct_change,
    }));
  }
  if (it.us10y && it.us10y.value_pct != null) {
    cards.push(marketCard({
      label: '美國 10Y 公債殖利率',
      value: it.us10y.value_pct.toFixed(2),
      unit: '%',
      changeText: bpsText(it.us10y.bps_change, '較上月底'),
      pct: it.us10y.bps_change,
    }));
  }

  document.getElementById('market-cards').innerHTML = cards.join('');
}

function marketCard({ label, value, unit, changeText, pct }) {
  const cls = pct == null ? 'neutral' : (pct > 0 ? 'positive' : (pct < 0 ? 'negative' : 'neutral'));
  return `
    <div class="market-card ${cls}">
      <div class="market-card-label">${label}</div>
      <div class="market-card-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
      <div class="market-card-change ${cls}">${changeText}</div>
    </div>
  `;
}

function pctText(pct, prefix) {
  if (pct == null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${prefix} ${sign}${pct.toFixed(2)}%`;
}

function bpsText(bps, prefix) {
  if (bps == null) return '—';
  const sign = bps > 0 ? '+' : '';
  return `${prefix} ${sign}${bps} bps`;
}

// 表格金額單位全名（跟著單位選單）。EPS 欄位另標「元」，不受此影響。
function unitFullLabel(u) {
  return u === '億元' ? '新台幣億元' : '新台幣百萬元';
}

function renderTable() {
  if (!state.data) return;
  state.displayUnit = document.getElementById('unit-select').value;
  state.sortMode    = document.getElementById('sort-select').value;

  const hint = document.getElementById('table-unit-hint');
  if (hint) {
    const prevPer = state.prevMonth?.report_period;
    const momHint = (state.viewMode === 'holdings' && prevPer)
      ? `｜MoM＝與上月（${periodAd(prevPer)}）自結比較` : '';
    hint.textContent = `單位：${unitFullLabel(state.displayUnit)}（EPS 為元）${momHint}`;
  }

  // 依視角掛上 class，供 CSS 控制各欄等寬（金控總覽 vs 產業視角欄數不同）
  const tableEl = document.getElementById('main-table');
  if (tableEl) {
    tableEl.classList.toggle('view-holdings', state.viewMode === 'holdings');
    tableEl.classList.toggle('view-industry', state.viewMode !== 'holdings');
  }

  // 卡片只在手機且切到卡片模式時才需要產生（桌機／總表模式下容器是隱藏的）
  const cardsEl = document.getElementById('mobile-cards');
  const needCards = cardsEl && getComputedStyle(cardsEl).display !== 'none';

  if (state.viewMode === 'holdings') {
    renderHoldingsTable();
    if (needCards) renderHoldingsCards();
  } else {
    renderIndustryTable(state.viewMode);
    if (needCards) renderIndustryCards(state.viewMode);
  }
}

// 13 家金控總覽（原本的表格）
function renderHoldingsTable() {
  const period = state.data.report_period || '';
  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th rowspan="2" class="col-code">代號</th>
      <th rowspan="2" class="col-name">金控</th>
      <th colspan="4" class="col-group">稅後淨利（公告口徑）</th>
      <th colspan="2" class="col-group">稅後 EPS (元)</th>
      <th rowspan="2" class="col-source">公告日期</th>
    </tr>
    <tr>
      <th class="col-monthly">當月 (${periodAd(period)})</th>
      <th class="col-monthly">當月 MoM</th>
      <th class="col-cumulative">累計</th>
      <th class="col-cumulative">累計 YoY</th>
      <th class="col-monthly col-eps">當月</th>
      <th class="col-cumulative col-eps">累計</th>
    </tr>`;
  const companies = sortCompanies([...state.data.companies]);
  document.getElementById('main-tbody').innerHTML = companies.map(renderRow).join('');

  // 金控層級 FVOCI 加計列註腳（有實際出現加計列才顯示）
  const tfoot = document.getElementById('main-tfoot');
  const hasFvoci = companies.some(c => !c.error && c.holding_company?.fvoci_adjusted?.cumulative_profit != null);
  if (tfoot) {
    // 註腳包一層 span：手機橫向捲動時用它限制寬度，避免文字被推到可視範圍外
    tfoot.innerHTML = hasFvoci
      ? `<tr><td colspan="9" class="table-footnote"><span><sup>*</sup> ${FVOCI_FOOTNOTE_HOLDINGS}</span></td></tr>`
      : '';
  }
}

// 產業視角（銀行 / 壽險 / 證券）
function renderIndustryTable(industry) {
  const period = state.data.report_period || '';
  const rows = sortIndustryRows(getIndustryRows(industry));
  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th class="col-code">集團</th>
      <th class="col-name">${VIEW_TITLES[industry]}子公司</th>
      <th class="col-monthly">當月 (${periodAd(period)})</th>
      <th class="col-cumulative">累計</th>
      <th class="col-cumulative">累計 YoY</th>
    </tr>`;

  if (rows.length === 0) {
    document.getElementById('main-tbody').innerHTML =
      `<tr><td colspan="5" class="loading-cell">此期間無${VIEW_TITLES[industry]}資料</td></tr>`;
    return;
  }

  const unit = state.displayUnit;
  let hasFvoci = false;
  document.getElementById('main-tbody').innerHTML = rows.map(r => {
    const m = convertUnit(r.monthly_profit, r.unit, unit);
    const c = convertUnit(r.cumulative_profit, r.unit, unit);
    const mClass = (m ?? 0) >= 0 ? 'positive' : 'negative';
    const cClass = (c ?? 0) >= 0 ? 'positive' : 'negative';

    const yi = formatYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs, r.cumulative_profit_yoy_status, r.unit, unit);
    let yoyClass = yi.cls;
    let yoyDisp = yi.disp;
    if (yi.disp === '—' && showMergerNote(r.parent_code, period)) {
      yoyDisp = '<span class="yoy-note">2025/07 正式合併</span>';
    }
    if (yi.disp === '—' && r.name.includes('京城') && showMergerNote('2890', period)) {
      yoyDisp = '<span class="yoy-note">2025/10 併入獲利公告</span>';
    }

    const main = `<tr>
      <td><a class="company-link" onclick="showDetail('${r.parent_code}')">${r.parent_name}</a></td>
      <td class="col-entity">${r.name}</td>
      <td class="num ${mClass}">${m != null ? formatNum(m) : '—'}</td>
      <td class="num ${cClass}">${c != null ? formatNum(c) : '—'}</td>
      <td class="num yoy ${yoyClass}">${yoyDisp}</td>
    </tr>`;

    // 壽險專屬：僅在有揭露 FVOCI 影響數的子公司下方加一行（目前富邦、凱基）
    // 數字以淡藍色 + 較小字呈現，避免干擾主表的排序視覺
    let adj = '';
    const a = r.fvoci_adjusted;
    if (industry === 'life' && a && a.cumulative_profit != null) {
      hasFvoci = true;
      const fd = fvociDisplay(a, r.unit, unit);
      const tip = a.source_quote
        ? ` title="${escapeHtml(a.source_quote)}"`
        : '';
      adj = `<tr class="fvoci-row">
        <td></td>
        <td class="fvoci-label"${tip}>${fvociRowLabel()}<sup>*</sup></td>
        <td class="num fvoci-num">${fd.monthlyDisp}</td>
        <td class="num fvoci-num">${fd.cumulDisp}</td>
        <td class="num fvoci-num">${fd.yoyDisp}</td>
      </tr>`;
    }

    return main + adj;
  }).join('');

  // 壽險表格底部加註腳（只有實際出現 FVOCI 列時才顯示）
  const tfoot = document.getElementById('main-tfoot');
  if (tfoot) {
    if (industry === 'life' && hasFvoci) {
      tfoot.innerHTML = `<tr><td colspan="5" class="table-footnote"><span><sup>*</sup> ${FVOCI_FOOTNOTE}</span></td></tr>`;
    } else {
      tfoot.innerHTML = '';
    }
  }
}

// 產業列排序（用既有 sortMode 對映）
function sortIndustryRows(arr) {
  switch (state.sortMode) {
    case 'monthly_desc':
      return arr.sort((a, b) => (b.monthly_profit ?? -Infinity) - (a.monthly_profit ?? -Infinity));
    case 'monthly_asc':
      return arr.sort((a, b) => (a.monthly_profit ?? Infinity) - (b.monthly_profit ?? Infinity));
    case 'cumulative_desc':
      return arr.sort((a, b) => (b.cumulative_profit ?? -Infinity) - (a.cumulative_profit ?? -Infinity));
    case 'cumul_yoy_desc':
      return arr.sort((a, b) => compareYoYDesc(
        a.cumulative_profit_yoy_pct, a.cumulative_profit_yoy_status,
        b.cumulative_profit_yoy_pct, b.cumulative_profit_yoy_status,
      ));
    case 'eps_cumul_desc':  // 子公司無 EPS，回退到代號
    case 'code':
    default:
      return arr.sort((a, b) => a.parent_code.localeCompare(b.parent_code));
  }
}

function renderRow(c) {
  if (c.error) {
    return `<tr class="error-row">
      <td class="col-code">${c.code}</td>
      <td><span class="company-link">${c.name}</span></td>
      <td colspan="6" class="center row-note">${c.error_msg || '資料待更新'}</td>
      <td class="center row-note">—</td>
    </tr>`;
  }

  const h       = c.holding_company || {};
  const monthly = convertUnit(h.monthly_profit, c.unit, state.displayUnit);
  const cumul   = convertUnit(h.cumulative_profit, c.unit, state.displayUnit);

  const mClass  = monthly >= 0 ? 'positive' : 'negative';
  const cClass  = cumul   >= 0 ? 'positive' : 'negative';

  const mDisplay = monthly  != null ? formatNum(monthly)  : '—';
  const cDisplay = cumul    != null ? formatNum(cumul)     : '—';

  // 累計 YoY（main.py 預先寫入 holding_company.cumulative_profit_yoy_pct/_abs/_status）
  // 衍生 YoY 已按完整比較窗口的共用口徑重算。
  const period = state.data.report_period || '';
  const unit = state.displayUnit;
  const yi = formatYoY(h.cumulative_profit_yoy_pct, h.cumulative_profit_yoy_abs, h.cumulative_profit_yoy_status, c.unit, unit);
  let yoyClass = yi.cls;
  let yoyDisp = yi.disp;
  if (yi.disp === '—' && c.code === '2887' && showMergerNote('2887', period)) {
    yoyDisp = '<span class="yoy-note">2025/07 正式合併</span>';
  }
  // 永豐金的累計合併範圍不同時保留醒目提示。
  if (yi.disp !== '—' && c.code === '2890' && showMergerNote('2890', period)) {
    yoyDisp += '<br><span class="yoy-note">京城銀 2025/10 併入獲利公告</span>';
  }

  // 單月 EPS 僅使用公告值，未揭露留空。
  const epsM = h.monthly_eps ?? null;
  const epsC = h.cumulative_eps;
  const epsMClass = (epsM ?? 0) >= 0 ? 'positive' : 'negative';
  const epsCClass = (epsC ?? 0) >= 0 ? 'positive' : 'negative';
  const epsMDisp = epsM != null ? formatEps(epsM) : '—';
  const epsCDisp = epsC != null ? formatEps(epsC) : '—';

  const annDate = dateAd(c.announcement_date) || '公告';
  const sourceLink = c.source_url
    ? `<a class="source-link" href="${c.source_url}" target="_blank" rel="noopener" title="於公開資訊觀測站檢視原始公告">${annDate}</a>`
    : (dateAd(c.announcement_date) || '—');

  const nameCell = `<a class="company-link" onclick="showDetail('${c.code}')">${c.name}</a>`;

  // 草稿新增：當月 MoM（與上月自結比較；併購跨期不比較）
  const momI = holdingMomInfo(c);

  // 金控層級 FVOCI 加計列（115/06 起富邦／凱基揭露「加計FVOCI後獲利」、
  // 國泰揭露「對保留盈餘影響數」，皆為金控合併層級數字；缺當月數顯示 —）
  let adjRow = '';
  const a = h.fvoci_adjusted;
  if (a && a.cumulative_profit != null) {
    const fd = fvociDisplay(a, c.unit, unit);
    const tip = a.source_quote ? ` title="${escapeHtml(a.source_quote)}"` : '';
    const adjEpsC = a.cumulative_eps != null ? formatEps(a.cumulative_eps) : '';
    adjRow = `<tr class="fvoci-row">
      <td></td>
      <td class="fvoci-label"${tip}>${fvociRowLabel()}<sup>*</sup></td>
      <td class="num fvoci-num">${fd.monthlyDisp}</td>
      <td class="num fvoci-num"></td>
      <td class="num fvoci-num">${fd.cumulDisp}</td>
      <td class="num fvoci-num">${fd.yoyDisp}</td>
      <td class="num fvoci-num"></td>
      <td class="num fvoci-num">${adjEpsC}</td>
      <td></td>
    </tr>`;
  }

  return `<tr>
    <td class="col-code">${c.code}</td>
    <td>${nameCell}</td>
    <td class="num ${mClass}">${mDisplay}</td>
    <td class="num mom ${momI.cls}">${momI.disp}</td>
    <td class="num ${cClass}">${cDisplay}</td>
    <td class="num yoy ${yoyClass}">${yoyDisp}</td>
    <td class="num ${epsMClass}">${epsMDisp}</td>
    <td class="num ${epsCClass}">${epsCDisp}</td>
    <td class="center col-source">${sourceLink}</td>
  </tr>` + adjRow;
}

// EPS 用兩位小數顯示（負數用括號）
function formatEps(n) {
  if (n == null) return '—';
  if (n < 0) return '(' + Math.abs(n).toFixed(2) + ')';
  return n.toFixed(2);
}

// ── 手機卡片視圖（A2'） ──────────────────────────────────
function renderHoldingsCards() {
  const companies = sortCompanies([...state.data.companies]);
  const el = document.getElementById('mobile-cards');
  el.innerHTML = companies.map(renderHoldingCard).join('');

  // 金控層級 FVOCI 註腳（有實際出現加計區塊才加）
  if (companies.some(c => !c.error && c.holding_company?.fvoci_adjusted?.cumulative_profit != null)) {
    el.insertAdjacentHTML('beforeend',
      `<div class="m-footnote"><sup>*</sup> ${FVOCI_FOOTNOTE_HOLDINGS}</div>`);
  }
}

function renderHoldingCard(c) {
  if (c.error) {
    return `<div class="m-card error">
      <div class="m-card-head">
        <div class="m-card-titles">
          <div class="m-card-sub">${c.code}</div>
          <div class="m-card-name">${c.name}</div>
        </div>
      </div>
      <div class="m-card-error">${c.error_msg || '資料待更新'}</div>
    </div>`;
  }

  const h = c.holding_company || {};
  const period = state.data.report_period || '';
  const unit = state.displayUnit;
  const monthly = convertUnit(h.monthly_profit, c.unit, unit);
  const cumul   = convertUnit(h.cumulative_profit, c.unit, unit);

  const yi = formatYoY(h.cumulative_profit_yoy_pct, h.cumulative_profit_yoy_abs, h.cumulative_profit_yoy_status, c.unit, unit);
  let yoyClass = yi.cls, yoyDisp = yi.disp;
  if (yi.disp === '—' && c.code === '2887' && showMergerNote('2887', period)) {
    yoyDisp = '合併前';
  }
  if (yi.disp !== '—' && c.code === '2890' && showMergerNote('2890', period)) {
    yoyDisp += '<span class="yoy-note" style="display:block">京城銀 2025/10 併入</span>';
  }

  const epsC = h.cumulative_eps;
  const epsCDisp = epsC != null ? formatEps(epsC) : '—';
  const epsCClass = (epsC ?? 0) >= 0 ? 'positive' : 'negative';
  const momI2 = holdingMomInfo(c);   // 草稿新增

  const mClass = (monthly ?? 0) >= 0 ? 'positive' : 'negative';
  const cClass = (cumul   ?? 0) >= 0 ? 'positive' : 'negative';

  // 金控層級 FVOCI 加計區塊（淡藍色弱化，不干擾主排序）
  let adjBlock = '';
  const a = h.fvoci_adjusted;
  if (a && a.cumulative_profit != null) {
    const fd = fvociDisplay(a, c.unit, unit);
    const yoyPart = fd.isBound || !fd.yoyDisp ? '' : `<div>YoY：${fd.yoyDisp}</div>`;
    const monthlyPart = fd.monthlyDisp !== '—' ? `<div>當月：${fd.monthlyDisp}</div>` : '';
    adjBlock = `
    <div class="m-fvoci">
      <div class="m-fvoci-label">${fvociRowLabel()}<sup>*</sup></div>
      <div class="m-fvoci-vals">
        ${monthlyPart}
        <div>累計：${fd.cumulDisp}</div>
        ${yoyPart}
      </div>
    </div>`;
  }

  return `<div class="m-card" onclick="showDetail('${c.code}')">
    <div class="m-card-head">
      <div class="m-card-titles">
        <div class="m-card-sub">${c.code}</div>
        <div class="m-card-name">${c.name}</div>
      </div>
      <span class="m-card-arrow">›</span>
    </div>
    <div class="m-card-grid">
      <div class="m-cell">
        <div class="m-cell-label">當月 (${periodAd(period)})</div>
        <div class="m-cell-value ${mClass}">${monthly != null ? formatNum(monthly) : '—'}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 YTD</div>
        <div class="m-cell-value ${cClass}">${cumul != null ? formatNum(cumul) : '—'}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 YoY</div>
        <div class="m-cell-value yoy ${yoyClass}">${yoyDisp}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 EPS</div>
        <div class="m-cell-value ${epsCClass}">${epsCDisp}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">當月 MoM</div>
        <div class="m-cell-value yoy ${momI2.cls}">${momI2.disp}</div>
      </div>
    </div>
    ${adjBlock}
  </div>`;
}

function renderIndustryCards(industry) {
  const period = state.data.report_period || '';
  const rows = sortIndustryRows(getIndustryRows(industry));
  const el = document.getElementById('mobile-cards');

  if (rows.length === 0) {
    el.innerHTML = `<div class="m-empty">此期間無${VIEW_TITLES[industry]}資料</div>`;
    return;
  }

  const unit = state.displayUnit;
  el.innerHTML = rows.map(r => {
    const m = convertUnit(r.monthly_profit, r.unit, unit);
    const cu = convertUnit(r.cumulative_profit, r.unit, unit);
    const mClass = (m ?? 0) >= 0 ? 'positive' : 'negative';
    const cClass = (cu ?? 0) >= 0 ? 'positive' : 'negative';

    const yi = formatYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs, r.cumulative_profit_yoy_status, r.unit, unit);
    let yoyClass = yi.cls, yoyDisp = yi.disp;
    if (yi.disp === '—' && showMergerNote(r.parent_code, period)) {
      yoyDisp = '合併前';
    }
    if (yi.disp === '—' && r.name.includes('京城') && showMergerNote('2890', period)) {
      yoyDisp = '<span class="yoy-note">2025/10 併入</span>';
    }

    // 壽險專屬：僅在有揭露 FVOCI 影響數時顯示（淡藍色弱化，不干擾主排序）
    let adjBlock = '';
    const a = r.fvoci_adjusted;
    if (industry === 'life' && a && a.cumulative_profit != null) {
      const fd = fvociDisplay(a, r.unit, unit);
      const yoyPart = fd.isBound || !fd.yoyDisp ? '' : `<div>YoY：${fd.yoyDisp}</div>`;
      const monthlyPart = fd.monthlyDisp !== '—' ? `<div>當月：${fd.monthlyDisp}</div>` : '';
      adjBlock = `
      <div class="m-fvoci">
        <div class="m-fvoci-label">${fvociRowLabel()}<sup>*</sup></div>
        <div class="m-fvoci-vals">
          ${monthlyPart}
          <div>累計：${fd.cumulDisp}</div>
          ${yoyPart}
        </div>
      </div>`;
    }

    return `<div class="m-card" onclick="showDetail('${r.parent_code}')">
      <div class="m-card-head">
        <div class="m-card-titles">
          <div class="m-card-sub">${r.parent_name}</div>
          <div class="m-card-name">${r.name}</div>
        </div>
        <span class="m-card-arrow">›</span>
      </div>
      <div class="m-card-grid m-card-grid-3">
        <div class="m-cell">
          <div class="m-cell-label">當月 (${periodAd(period)})</div>
          <div class="m-cell-value ${mClass}">${m != null ? formatNum(m) : '—'}</div>
        </div>
        <div class="m-cell">
          <div class="m-cell-label">累計 YTD</div>
          <div class="m-cell-value ${cClass}">${cu != null ? formatNum(cu) : '—'}</div>
        </div>
        <div class="m-cell">
          <div class="m-cell-label">累計 YoY</div>
          <div class="m-cell-value yoy ${yoyClass}">${yoyDisp}</div>
        </div>
      </div>
      ${adjBlock}
    </div>`;
  }).join('');

  // 壽險手機卡片底部加註腳（只有實際出現 FVOCI 區塊時才加）
  if (industry === 'life' && rows.some(r => r.fvoci_adjusted && r.fvoci_adjusted.cumulative_profit != null)) {
    el.insertAdjacentHTML('beforeend',
      `<div class="m-footnote"><sup>*</sup> ${FVOCI_FOOTNOTE}</div>`);
  }
}

// ── 摘要卡片：金控／壽險／銀行／證券「累計獲利第一」 ─────────
// 壽險以原始 P&L（不含FVOCI加計數）排名，卡片標籤註明「不含FVOCI」。
function leaderFromCompanies(companies, unit) {
  let best = null;
  for (const c of companies) {
    const h = c.holding_company || {};
    const v = h.cumulative_profit;
    if (v == null) continue;
    if (!best || v > best.raw) {
      best = {
        raw: v,
        name: c.name,
        amount: convertUnit(v, c.unit, unit),
        yoy: formatYoY(h.cumulative_profit_yoy_pct, h.cumulative_profit_yoy_abs,
                       h.cumulative_profit_yoy_status, c.unit, unit),
      };
    }
  }
  return best;
}

function leaderFromIndustry(industry, unit) {
  let best = null;
  for (const r of getIndustryRows(industry)) {
    const v = r.cumulative_profit;
    if (v == null) continue;
    if (!best || v > best.raw) {
      best = {
        raw: v,
        name: r.name,
        amount: convertUnit(v, r.unit, unit),
        yoy: formatYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs,
                       r.cumulative_profit_yoy_status, r.unit, unit),
      };
    }
  }
  return best;
}

function leaderCard(label, leader, unit) {
  if (!leader) {
    return `<div class="card leader-card">
      <div class="card-label">${label}</div>
      <div class="card-value">—</div>
      <div class="card-sub"></div>
    </div>`;
  }
  const yoyHtml = leader.yoy.disp !== '—'
    ? `YoY <span class="${leader.yoy.cls}">${leader.yoy.disp}</span>`
    : 'YoY —';
  return `<div class="card leader-card">
    <div class="card-label">${label}</div>
    <div class="card-value">${leader.name}</div>
    <div class="card-sub"><span class="leader-amount">${formatNum(leader.amount)} ${unit}</span><span class="card-sub-sep">｜</span>${yoyHtml}</div>
  </div>`;
}

// 公告家數門檻：不到這個家數就不顯示「第一名」。
// 月初只有少數幾家公告時，排名會隨當日公告順序跳動，容易被誤讀為當期真實排名。
const LEADER_CARDS_MIN_COMPANIES = 10;

function renderSummaryCards() {
  const d = state.data;
  const unit = state.displayUnit;
  const companies = d.companies.filter(c => !c.error && c.holding_company);
  const el = document.getElementById('summary-cards');

  if (companies.length < LEADER_CARDS_MIN_COMPANIES) {
    // 直接留白會讓人以為是壞掉了 → 說明「為什麼還沒出現」與還差幾家
    el.classList.add('is-pending');
    el.innerHTML = `<div class="summary-pending">
      本月已取得 <strong>${companies.length} / 13</strong> 家金控公告。
      待 ${LEADER_CARDS_MIN_COMPANIES} 家以上公告後，才顯示金控／壽險／銀行／證券的累計獲利第一名——
      家數不足時的排名會隨公告先後跳動，容易誤導。下方表格與圖表不受影響，已公告者即時呈現。
    </div>`;
    return;
  }

  el.classList.remove('is-pending');
  el.innerHTML = [
    leaderCard('金控累計獲利第一', leaderFromCompanies(companies, unit), unit),
    leaderCard('壽險累計獲利第一（不含FVOCI）', leaderFromIndustry('life', unit), unit),
    leaderCard('銀行累計獲利第一', leaderFromIndustry('bank', unit), unit),
    leaderCard('證券累計獲利第一', leaderFromIndustry('securities', unit), unit),
  ].join('');
}

// ── 簡易 markdown 渲染（**bold**、## 標題、段落） ────────
function escapeHtml(s) {
  return (typeof AnalysisPack === 'undefined' ? String(s) : AnalysisPack.dates(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(typeof AnalysisPack === 'undefined' ? md : AnalysisPack.dates(md));
  // **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 列表項：行首 - 開頭
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.+?<\/li>(?:\n<li>.+?<\/li>)*)/g, '<ul>$1</ul>');
  // ## 標題 (在段落分隔之前處理)
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  // 雙換行 → 段落；單換行 → 換行
  const blocks = html.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol)/.test(p.trim())) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  });
  return blocks.join('');
}

// ── 子公司明細面板 ─────────────────────────────────────
function showDetail(code) {
  const c = state.data.companies.find(x => x.code === code);
  if (!c) return;

  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');

  title.textContent = `${c.name} (${c.code}) — 詳細資訊`;

  const subs = c.subsidiaries || [];
  const unit = state.displayUnit;
  const h = c.holding_company || {};
  const hm  = convertUnit(h.monthly_profit,  c.unit, unit);
  const hcu = convertUnit(h.cumulative_profit, c.unit, unit);

  // ── 新聞摘要區塊 ──
  let newsHtml = '';
  if (c.news_summary) {
    const sources = c.news_sources || [];
    const sourcesHtml = sources.length
      ? `<div class="news-sources"><span class="news-sources-label">延伸閱讀</span><ul class="news-sources-list">${sources.slice(0, 3).map(s =>
          `<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.url)}</a></li>`
        ).join('')}</ul></div>`
      : '';
    const ts = c.news_generated_at ? fmtDate(c.news_generated_at) : '';
    newsHtml = `
      <div class="news-summary">
        <div class="news-summary-header">
          <span>媒體新聞摘要</span>
          ${ts ? `<span class="news-summary-time">${ts} 生成</span>` : ''}
        </div>
        <div class="news-summary-body">${renderMarkdown(c.news_summary)}</div>
        ${sourcesHtml}
      </div>`;
  }

  // ── 子公司表格區塊 ──
  let tableHtml = '';
  if (subs.length === 0) {
    tableHtml = '<p class="detail-footnote">無子公司明細資料</p>';
  } else {
    const subEntries = subs.map(s => ({
      name: s.name,
      monthly: convertUnit(s.monthly_profit, c.unit, unit),
      cumul:   convertUnit(s.cumulative_profit, c.unit, unit),
      isLife: classifyIndustry(s.name) === 'life',
      fvoci:  s.fvoci_adjusted || null,
    }));
    const allMonthly = subEntries.map(s => s.monthly || 0);
    const maxAbs = Math.max(...allMonthly.map(Math.abs), 1);
    let hasFvoci = false;

    const rows = subEntries.map(s => {
      const mc = (s.monthly || 0) >= 0 ? 'positive' : 'negative';
      const cc = (s.cumul   || 0) >= 0 ? 'positive' : 'negative';
      const barPct = Math.abs((s.monthly || 0) / maxAbs * 100).toFixed(1);
      const barColor = (s.monthly || 0) >= 0 ? 'rgba(26,63,160,.55)' : 'rgba(163,49,42,.55)';
      const main = `<tr>
        <td style="min-width:90px">${s.name}</td>
        <td class="num ${mc}">${s.monthly != null ? formatNum(s.monthly) : '—'}</td>
        <td class="detail-bar-cell">
          <div class="detail-bar" style="background:${barColor};width:${barPct}%"></div>
        </td>
        <td class="num ${cc}">${s.cumul != null ? formatNum(s.cumul) : '—'}</td>
      </tr>`;

      // 僅在壽險子公司且有揭露 FVOCI 影響數時加一行（淡靛藍弱化）
      if (!s.isLife || !s.fvoci || s.fvoci.cumulative_profit == null) return main;
      hasFvoci = true;
      const fd = fvociDisplay(s.fvoci, c.unit, unit);
      const tip = s.fvoci.source_quote
        ? ` title="${escapeHtml(s.fvoci.source_quote)}"`
        : '';
      const adj = `<tr class="fvoci-row">
        <td class="fvoci-label detail-fvoci-label"${tip}>${fvociRowLabel()}<sup>*</sup></td>
        <td class="num fvoci-num detail-fvoci-num">${fd.monthlyDisp}</td>
        <td></td>
        <td class="num fvoci-num detail-fvoci-num">${fd.cumulDisp}</td>
      </tr>`;
      return main + adj;
    }).join('');

    // 金控合併層級 FVOCI 加計列（緊接「（合併）」列之後）
    let hAdjRow = '';
    const hAdj = h.fvoci_adjusted;
    if (hAdj && hAdj.cumulative_profit != null) {
      hasFvoci = true;
      const fd = fvociDisplay(hAdj, c.unit, unit);
      const tip = hAdj.source_quote ? ` title="${escapeHtml(hAdj.source_quote)}"` : '';
      hAdjRow = `<tr class="fvoci-row">
        <td class="fvoci-label detail-fvoci-label"${tip}>${fvociRowLabel()}<sup>*</sup></td>
        <td class="num fvoci-num detail-fvoci-num">${fd.monthlyDisp}</td>
        <td></td>
        <td class="num fvoci-num detail-fvoci-num">${fd.cumulDisp}</td>
      </tr>`;
    }

    const fvociFootnote = hasFvoci
      ? `<p class="detail-footnote"><sup>*</sup> ${FVOCI_FOOTNOTE_DETAIL}</p>`
      : '';

    tableHtml = `
      <table class="detail-table">
        <thead>
          <tr>
            <th class="th-left">子公司</th>
            <th>當月 (${unit})</th>
            <th></th>
            <th>累計 (${unit})</th>
          </tr>
        </thead>
        <tbody>
          <tr class="detail-total">
            <td>${c.name}（合併）</td>
            <td class="num">${hm != null ? formatNum(hm) : '—'}</td>
            <td></td>
            <td class="num">${hcu != null ? formatNum(hcu) : '—'}</td>
          </tr>
          ${hAdjRow}
          ${rows}
        </tbody>
      </table>${fvociFootnote}`;
  }

  const relevantNotes = [...new Set([c.holding_company?.cumulative_profit_yoy_reason,
    comparisonRules.basis_notes[c.code], comparisonRules.revisions[`${c.code}|${state.data.report_period}`],
    COMPANY_NOTES[c.code]].filter(Boolean))];
  const noteHtml = relevantNotes.map(note => `<p class="detail-note"><strong>口徑：</strong>${escapeHtml(note)}</p>`).join('');

  // 草稿新增：單月獲利變動拆解（MoM 歸因）
  const momHtml = momAttributionHtml(c);

  content.innerHTML = `
    ${momHtml}
    ${newsHtml}
    ${tableHtml}
    ${noteHtml}
    <p class="detail-meta">
      公告日期：${dateAd(c.announcement_date) || '—'} ｜ 來源：<a href="${c.source_url||'#'}" target="_blank" rel="noopener">公開資訊觀測站 ↗</a>
    </p>
  `;

  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
}

// ── 長條圖（本期 vs 去年同期） ─────────────────────────
// 排序仍依「本期數值」由大到小；去年同期為對照數列，缺基期（如尚未合併、
// 子公司當年不存在）該欄留空，不以 0 補值以免誤讀為零獲利。
const CHART_COLORS = {
  current: 'rgba(26, 63, 160, .92)',   // brand blue：本期
  prior:   'rgba(154, 163, 178, .55)', // 中性灰：去年同期
};

// 合併事件另列註記；YoY 與去年同期柱仍使用各期公告數。
// 例：2887 台新新光金 2025/07 合併，115/07 之前的去年同期只有台新金單體，兩者不同一實體。

function priorComparable(key, period) {
  const [code, name] = key.split('|');
  return !A.reason(comparisonRules, code, [period], [A.shift(period, -12)], name || null);
}

// 取某資料集在目前視角下的列（key 用於跨期對應）
function chartRowsOf(src, kind) {
  if (!src) return [];
  const unit = state.displayUnit;
  const field = kind === 'monthly' ? 'monthly_profit' : 'cumulative_profit';
  if (state.viewMode === 'holdings') {
    return (src.companies || [])
      .filter(c => !c.error && c.holding_company && c.holding_company[field] != null)
      .map(c => ({
        key: c.code,
        name: c.name,
        value: convertUnit(c.holding_company[field], c.unit, unit),
      }));
  }
  return getIndustryRows(state.viewMode, src)
    .filter(r => r[field] != null)
    .map(r => ({
      key: `${r.parent_code}|${r.name}`,
      name: r.name,
      value: convertUnit(r[field], r.unit, unit),
    }));
}

function chartSeries(kind) {
  const period = state.data.report_period || '';
  const cur = chartRowsOf(state.data, kind).sort((a, b) => b.value - a.value);
  const prevMap = new Map(chartRowsOf(state.baseline, kind).map(r => [r.key, r.value]));
  const missing = [];
  const prior = cur.map(r => {
    if (!prevMap.has(r.key)) { missing.push(r.name); return null; }
    return prevMap.get(r.key);
  });
  return { labels: cur.map(r => r.name), current: cur.map(r => r.value), prior, missing };
}

function renderChart() {
  if (typeof Chart === 'undefined') { showStatus('warning','比較圖表元件未載入；表格與趨勢圖仍可使用。'); return; }
  const unit = state.displayUnit;
  const period = state.data.report_period || '';
  const prevPeriod = prevYearPeriod(period);
  const scopeLabel = state.viewMode === 'holdings' ? '金控' : VIEW_TITLES[state.viewMode];

  const curLabel   = `${periodAd(period)} 當月`;
  const priorLabel = prevPeriod ? `${periodAd(prevPeriod)} 當月（去年同期）` : '去年同期';
  const curCumLabel   = `${adYear(period.split('/')[0])} 年累計`;
  const priorCumLabel = prevPeriod ? `${adYear(prevPeriod.split('/')[0])} 年同期累計` : '去年同期累計';

  document.getElementById('bar-chart-title').textContent =
    `${scopeLabel}當月獲利比較（${periodAd(period)} vs 去年同期）`;
  document.getElementById('cumul-chart-title').textContent =
    `${scopeLabel}累計獲利比較（本年累計 vs 去年同期累計）`;

  const monthly = chartSeries('monthly');
  const cumulative = chartSeries('cumulative');

  state.barChart = renderBarChart('bar-chart', state.barChart, monthly, curLabel, priorLabel, unit);
  state.cumulChart = renderBarChart('cumul-chart', state.cumulChart, cumulative, curCumLabel, priorCumLabel, unit);

  // 缺基期者揭露（M&A 尚未對齊、當年尚未納入公告等），避免讀者誤以為去年為零
  setChartNote('bar-chart-note', monthly.missing);
  setChartNote('cumul-chart-note', cumulative.missing);
}

function setChartNote(id, missing) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!missing || missing.length === 0) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = `${missing.join('、')}：去年同期資料不足，未列對照；不視為零。`;
  el.classList.remove('hidden');
}

function renderBarChart(canvasId, prevChart, series, curLabel, priorLabel, unit) {
  if (prevChart) prevChart.destroy();
  const hasPrior = series.prior.some(v => v != null);

  const datasets = [{
    label: curLabel,
    data: series.current,
    backgroundColor: CHART_COLORS.current,
    borderRadius: 2,
    maxBarThickness: 34,
  }];
  if (hasPrior) {
    datasets.push({
      label: priorLabel,
      data: series.prior,
      backgroundColor: CHART_COLORS.prior,
      borderRadius: 2,
      maxBarThickness: 34,
    });
  }

  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: { labels: series.labels, datasets },
    options: {
      responsive: true,
      // false + 容器固定高度：讓畫布填滿整個卡片寬度
      // （true 時 Chart.js 會為了維持長寬比而縮窄畫布，右側留下大片空白）
      maintainAspectRatio: false,
      layout: { padding: { top: 4 } },
      plugins: {
        legend: {
          display: hasPrior,
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            pointStyle: 'rect',
            color: '#3d4653',
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(16,20,24,.92)',
          padding: 10,
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
          callbacks: {
            label: c => c.raw == null
              ? ` ${c.dataset.label}：無基期資料`
              : ` ${c.dataset.label}：${formatNum(c.raw)} ${unit}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#5a6472', font: { size: 11 } },
        },
        y: {
          border: { display: false },
          grid: { color: '#eceef2' },
          ticks: { color: '#5a6472', font: { size: 11 }, callback: v => formatNum(v) },
        },
      },
    },
  });
}

// ── 輔助函數 ───────────────────────────────────────────
function updatePeriodBadge() {
  if (state.pageMode === 'period' && state.periodSel) {
    document.getElementById('period-badge').textContent = `${state.periodSel.label}｜期間比較`;
    return;
  }
  const p = state.data?.report_period;
  document.getElementById('period-badge').textContent = p ? `${periodLabel(p)} · ${state.pageMode === 'trend' ? '趨勢重點' : '完整月報'}` : '—';
}

function updateLastUpdated() {
  const ts = state.data?.last_updated;
  if (!ts) return;
  document.getElementById('last-updated').textContent = `最後更新：${fmtDateTime(ts)}`;
}

function showStatus(type, msg) {
  const bar = document.getElementById('status-bar');
  bar.className = `status-bar ${type}`;
  bar.textContent = msg;
  if (!msg) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
}

function sortCompanies(arr) {
  const unit = state.displayUnit;
  switch (state.sortMode) {
    case 'monthly_desc':
      return arr.sort((a, b) => {
        const av = convertUnit(a.holding_company?.monthly_profit, a.unit, unit) ?? -Infinity;
        const bv = convertUnit(b.holding_company?.monthly_profit, b.unit, unit) ?? -Infinity;
        return bv - av;
      });
    case 'monthly_asc':
      return arr.sort((a, b) => {
        const av = convertUnit(a.holding_company?.monthly_profit, a.unit, unit) ?? Infinity;
        const bv = convertUnit(b.holding_company?.monthly_profit, b.unit, unit) ?? Infinity;
        return av - bv;
      });
    case 'cumulative_desc':
      return arr.sort((a, b) => {
        const av = convertUnit(a.holding_company?.cumulative_profit, a.unit, unit) ?? -Infinity;
        const bv = convertUnit(b.holding_company?.cumulative_profit, b.unit, unit) ?? -Infinity;
        return bv - av;
      });
    case 'eps_cumul_desc':
      return arr.sort((a, b) => {
        const av = a.holding_company?.cumulative_eps ?? -Infinity;
        const bv = b.holding_company?.cumulative_eps ?? -Infinity;
        return bv - av;
      });
    case 'cumul_yoy_desc':
      return arr.sort((a, b) => compareYoYDesc(
        a.holding_company?.cumulative_profit_yoy_pct,
        a.holding_company?.cumulative_profit_yoy_status,
        b.holding_company?.cumulative_profit_yoy_pct,
        b.holding_company?.cumulative_profit_yoy_status,
      ));
    case 'mom_desc': {   // 草稿新增：當月 MoM（轉盈 > 正 > 負 > 轉虧）
      return arr.sort((a, b) => {
        const am = holdingMomInfo(a), bm = holdingMomInfo(b);
        return compareYoYDesc(am.pct, am.status, bm.pct, bm.status);
      });
    }
    case 'code':
    default:
      return arr.sort((a, b) => a.code.localeCompare(b.code));
  }
}

// 單位轉換
const UNIT_MULTIPLIER = {
  '千元':  1,
  '百萬元': 1000,
  '億元':  100000,
};

function convertUnit(value, fromUnit, toUnit) {
  if (value == null) return null;
  const from = UNIT_MULTIPLIER[fromUnit] || 1;
  const to   = UNIT_MULTIPLIER[toUnit]   || 1;
  return (value * from) / to;
}

// ── 表格圖片輸出（手機「存成圖片」） ─────────────────────
// 目的：管理層要把當月總表直接截圖分享，但手機螢幕放不下整張表。
// 作法：用 Canvas 依「當前月份／視角／單位」即時重繪一張完整表格圖，
//       版面比照桌機表格，但**不含公告日期欄**（分享時用不到，且會擠壓數字欄）。
// 不使用 html2canvas：sticky 欄位與陰影在截圖函式庫下容易變形，且省一個外部相依。

const SNAP = {
  scale: 2,                 // 輸出 2 倍解析度，手機上放大看仍清晰
  width: 1100,              // CSS px（實際輸出 2200px 寬）
  padX: 40,
  font: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", -apple-system, sans-serif',
  // 色票與 style.css 的色彩系統一致
  c: {
    bg: '#ffffff', surfaceAlt: '#fafbfc', border: '#e6e8ec', borderStrong: '#d5d9e0',
    ink: '#101418', ink2: '#3d4653', muted: '#6b7684',
    primary: '#1a3fa0', primaryBg: '#eef1f9',
    pos: '#1f6f54', neg: '#a3312a',
    fvoci: '#4a5a8f', fvociBg: '#f7f8fc',
  },
};

let _snapshotBlob = null;   // 供下載／分享重複使用

function snapFont(weight, size, italic) {
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${SNAP.font}`;
}

function snapDrawText(ctx, text, x, y, font, color, align) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// 中文無空白可斷 → 逐字量測換行
function snapWrap(ctx, text, maxWidth, font) {
  ctx.font = font;
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// 取得目前視角要畫的欄位定義與資料列（與網頁表格同來源，故數字必定一致）
function snapBuildModel() {
  const d = state.data;
  const unit = state.displayUnit;
  const period = d.report_period || '';
  const inner = SNAP.width - SNAP.padX * 2;

  if (state.viewMode === 'holdings') {
    const cols = [
      { key: 'code',    title: '代號',  w: 88,  align: 'left' },
      { key: 'name',    title: '金控',  w: 152, align: 'left' },
      { key: 'monthly', title: `當月 (${periodAd(period)})`, w: 180, align: 'right', group: '稅後淨利（公告口徑）' },
      { key: 'mom', title: 'MoM', w: 180, align: 'right', group: '稅後淨利（公告口徑）' },
      { key: 'cumul',   title: '累計',  w: 180, align: 'right', group: '稅後淨利（公告口徑）' },
      { key: 'yoy',     title: '累計 YoY', w: 180, align: 'right', group: '稅後淨利（公告口徑）' },
      { key: 'epsM',    title: '當月',  w: 120, align: 'right', group: '稅後 EPS (元)' },
      { key: 'epsC',    title: '累計',  w: 120, align: 'right', group: '稅後 EPS (元)' },
    ];
    const rows = [];
    for (const c of sortCompanies([...(d.companies || [])])) {
      if (c.error) {
        rows.push({ type: 'error', code: c.code, name: c.name, msg: c.error_msg || '資料待更新' });
        continue;
      }
      const h = c.holding_company || {};
      const epsM = h.monthly_eps ?? null;
      const yi = formatYoY(h.cumulative_profit_yoy_pct, h.cumulative_profit_yoy_abs,
                           h.cumulative_profit_yoy_status, c.unit, unit);
      let note = null, yoyDisp = yi.disp, yoyCls = yi.cls;
      if (yi.disp === '—' && c.code === '2887' && showMergerNote('2887', period)) {
        yoyDisp = ''; note = '2025/07 正式合併';
      }
      if (yi.disp !== '—' && c.code === '2890' && showMergerNote('2890', period)) {
        note = '京城銀 2025/10 併入獲利公告';
      }
      rows.push({
        type: 'main',
        code: c.code,
        name: c.name,
        monthly: formatNumOrDash(convertUnit(h.monthly_profit, c.unit, unit)),
        monthlyNeg: (convertUnit(h.monthly_profit, c.unit, unit) ?? 0) < 0,
        cumul: formatNumOrDash(convertUnit(h.cumulative_profit, c.unit, unit)),
        cumulNeg: (convertUnit(h.cumulative_profit, c.unit, unit) ?? 0) < 0,
        yoy: yoyDisp, yoyCls, note, mom: holdingMomInfo(c).disp,
        epsM: epsM != null ? formatEps(epsM) : '—',
        epsC: h.cumulative_eps != null ? formatEps(h.cumulative_eps) : '—',
      });
      const a = h.fvoci_adjusted;
      if (a && a.cumulative_profit != null) {
        const fd = fvociDisplay(a, c.unit, unit);
        rows.push({
          type: 'fvoci',
          label: FVOCI_LABEL_TEXT,
          monthly: fd.monthlyDisp, cumul: fd.cumulDisp, yoy: fd.yoyDisp,
          epsC: a.cumulative_eps != null ? formatEps(a.cumulative_eps) : '',
        });
      }
    }
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    cols.forEach(c => { c.w = c.w / totalW * inner; });
    return { cols, rows, hasGroups: true, title: '金控月獲利總覽', hasFvoci: rows.some(r => r.type === 'fvoci') };
  }

  // 產業視角（銀行／壽險／證券）
  const cols = [
    { key: 'parent',  title: '集團', w: 170, align: 'left' },
    { key: 'name',    title: `${VIEW_TITLES[state.viewMode]}子公司`, w: 240, align: 'left' },
    { key: 'monthly', title: `當月 (${periodAd(period)})`, w: 210, align: 'right' },
    { key: 'cumul',   title: '累計', w: 200, align: 'right' },
    { key: 'yoy',     title: '累計 YoY', w: 200, align: 'right' },
  ];
  const rows = [];
  for (const r of sortIndustryRows(getIndustryRows(state.viewMode))) {
    const yi = formatYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs,
                         r.cumulative_profit_yoy_status, r.unit, unit);
    let note = null, yoyDisp = yi.disp;
    if (yi.disp === '—' && showMergerNote(r.parent_code, period)) { yoyDisp = ''; note = '2025/07 正式合併'; }
    if (yi.disp === '—' && r.name.includes('京城') && showMergerNote('2890', period)) { yoyDisp = ''; note = '2025/10 併入獲利公告'; }
    const mv = convertUnit(r.monthly_profit, r.unit, unit);
    const cv = convertUnit(r.cumulative_profit, r.unit, unit);
    rows.push({
      type: 'main', code: r.parent_name, name: r.name,
      monthly: formatNumOrDash(mv), monthlyNeg: (mv ?? 0) < 0,
      cumul: formatNumOrDash(cv), cumulNeg: (cv ?? 0) < 0,
      yoy: yoyDisp, yoyCls: yi.cls, note,
    });
    const a = r.fvoci_adjusted;
    if (state.viewMode === 'life' && a && a.cumulative_profit != null) {
      const fd = fvociDisplay(a, r.unit, unit);
      rows.push({ type: 'fvoci', label: FVOCI_LABEL_TEXT, monthly: fd.monthlyDisp, cumul: fd.cumulDisp, yoy: fd.yoyDisp });
    }
  }
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  cols.forEach(c => { c.w = c.w / totalW * inner; });
  return {
    cols, rows, hasGroups: false,
    title: `${VIEW_TITLES[state.viewMode]}子公司月獲利總覽`,
    hasFvoci: rows.some(r => r.type === 'fvoci'),
  };
}

function formatNumOrDash(v) {
  return v != null ? formatNum(v) : '—';
}

function snapFootnoteText(model) {
  if (!model.hasFvoci) return '';
  return state.viewMode === 'holdings'
    ? `* ${FVOCI_FOOTNOTE_HOLDINGS}`
    : `* ${FVOCI_FOOTNOTE}`;
}

function renderTableImage() {
  if (state.pageMode === 'trend') return trendSnapshot();
  const model = snapBuildModel();
  const period = state.data.report_period || '';
  const { c } = SNAP;
  const W = SNAP.width;
  const padX = SNAP.padX;

  // 先用暫時 canvas 量測，算出總高度
  const measure = document.createElement('canvas').getContext('2d');
  const footnote = snapFootnoteText(model);
  const footLines = footnote ? snapWrap(measure, footnote, W - padX * 2, snapFont(400, 13)) : [];

  const H_TITLE = 108;                       // 標題區
  const H_GROUP = model.hasGroups ? 34 : 0;  // 群組表頭
  const H_HEAD = 38;                         // 欄位表頭
  const rowH = r => (r.type === 'fvoci' ? 34 : (r.note ? 56 : 42));
  const bodyH = model.rows.reduce((s, r) => s + rowH(r), 0);
  const H_FOOT = (footLines.length ? footLines.length * 20 + 14 : 0) + 34;   // 註腳 + 出處列
  const H = H_TITLE + H_GROUP + H_HEAD + bodyH + H_FOOT + 24;

  const canvas = document.createElement('canvas');
  canvas.width = W * SNAP.scale;
  canvas.height = H * SNAP.scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(SNAP.scale, SNAP.scale);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  // ── 標題區 ──
  snapDrawText(ctx, model.title, padX, 40, snapFont(700, 24), c.ink);
  snapDrawText(ctx,
    `單位：${unitFullLabel(state.displayUnit)}${state.viewMode === 'holdings' ? '（EPS 為元）' : ''}　｜　資料來源：公開資訊觀測站（MOPS）`,
    padX, 70, snapFont(400, 14), c.muted);

  // 期別徽章（右上）
  const badge = `${periodLabel(period)}月報`;
  ctx.font = snapFont(700, 15);
  const bw = ctx.measureText(badge).width + 28;
  const bx = W - padX - bw, by = 26, bh = 30;
  ctx.fillStyle = c.primaryBg;
  ctx.strokeStyle = '#d7dff1';
  ctx.lineWidth = 1;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 15); ctx.fill(); ctx.stroke(); }
  else ctx.fillRect(bx, by, bw, bh);
  snapDrawText(ctx, badge, bx + bw / 2, by + bh / 2 + 1, snapFont(700, 15), c.primary, 'center');

  // ── 欄位 x 座標 ──
  let x = padX;
  model.cols.forEach(col => { col.x = x; col.right = x + col.w; x += col.w; });
  const colOf = k => model.cols.find(cc => cc.key === k);
  const cellX = col => (col.align === 'right' ? col.right - 14 : col.x + 6);

  let y = H_TITLE;

  // ── 群組表頭（金控總覽的「稅後淨利（公告口徑）」「稅後 EPS (元)」） ──
  if (model.hasGroups) {
    ctx.fillStyle = c.surfaceAlt;
    ctx.fillRect(padX, y, W - padX * 2, H_GROUP);
    const groups = [];
    model.cols.forEach(col => {
      if (!col.group) return;
      const g = groups.find(gg => gg.name === col.group);
      if (g) { g.right = col.right; } else { groups.push({ name: col.group, left: col.x, right: col.right }); }
    });
    groups.forEach(g => {
      snapDrawText(ctx, g.name, (g.left + g.right) / 2, y + H_GROUP / 2, snapFont(600, 15), c.ink2, 'center');
      ctx.strokeStyle = c.border;
      ctx.beginPath();
      ctx.moveTo(g.left + 10, y + H_GROUP - 0.5);
      ctx.lineTo(g.right - 10, y + H_GROUP - 0.5);
      ctx.stroke();
    });
    y += H_GROUP;
  }

  // ── 欄位表頭 ──
  ctx.fillStyle = c.surfaceAlt;
  ctx.fillRect(padX, y, W - padX * 2, H_HEAD);
  model.cols.forEach(col => {
    snapDrawText(ctx, col.title, cellX(col), y + H_HEAD / 2, snapFont(600, 14), c.muted, col.align);
  });
  ctx.strokeStyle = c.borderStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, y + H_HEAD - 0.5);
  ctx.lineTo(W - padX, y + H_HEAD - 0.5);
  ctx.stroke();
  y += H_HEAD;

  // ── 資料列 ──
  for (const r of model.rows) {
    const h = rowH(r);
    if (r.type === 'fvoci') {
      ctx.fillStyle = c.fvociBg;
      ctx.fillRect(padX, y, W - padX * 2, h);
      const nameCol = colOf('name');
      // r.label 已含全形括號（FVOCI_LABEL_TEXT），不要再包一層
      snapDrawText(ctx, `${r.label} *`, nameCol.x + 6, y + h / 2, snapFont(400, 13), c.fvoci);
      const put = (key, val) => {
        const col = colOf(key);
        if (col && val) snapDrawText(ctx, val, cellX(col), y + h / 2, snapFont(500, 13, true), c.fvoci, 'right');
      };
      put('monthly', r.monthly); put('cumul', r.cumul); put('yoy', r.yoy); put('epsC', r.epsC);
    } else if (r.type === 'error') {
      snapDrawText(ctx, r.code, colOf('code').x + 6, y + h / 2, snapFont(600, 14), c.muted);
      snapDrawText(ctx, r.name, colOf('name').x + 6, y + h / 2, snapFont(700, 15), c.ink);
      snapDrawText(ctx, r.msg, colOf('cumul').right - 14, y + h / 2, snapFont(400, 13), c.muted, 'right');
    } else {
      // 有 YoY 數值又有註記時，數值置上、註記置下；只有註記（如合併前）則置中
      const noteOnly = !!r.note && !r.yoy;
      const midY = (r.note && !noteOnly) ? y + 22 : y + h / 2;
      const c1 = colOf('code');
      if (c1) snapDrawText(ctx, r.code, c1.x + 6, midY, snapFont(600, 14), c.muted);
      const cp = colOf('parent');
      if (cp) snapDrawText(ctx, r.code, cp.x + 6, midY, snapFont(600, 14), c.muted);
      snapDrawText(ctx, r.name, colOf('name').x + 6, midY, snapFont(700, 15), c.ink);
      snapDrawText(ctx, r.monthly, cellX(colOf('monthly')), midY, snapFont(600, 15), r.monthlyNeg ? c.neg : c.ink, 'right');
      snapDrawText(ctx, r.cumul, cellX(colOf('cumul')), midY, snapFont(600, 15), r.cumulNeg ? c.neg : c.ink, 'right');
      if (r.mom && colOf('mom')) snapDrawText(ctx, r.mom, cellX(colOf('mom')), midY, snapFont(500, 12), c.ink2, 'right');
      if (r.yoy) {
        const col = r.yoyCls === 'negative' ? c.neg : (r.yoyCls === 'positive' ? c.pos : c.muted);
        snapDrawText(ctx, r.yoy, cellX(colOf('yoy')), midY, snapFont(600, 15), col, 'right');
      }
      if (r.note) {
        snapDrawText(ctx, r.note, cellX(colOf('yoy')), noteOnly ? y + h / 2 : y + 42,
                     snapFont(400, 12, true), c.muted, 'right');
      }
      const ce = colOf('epsM');
      if (ce) {
        snapDrawText(ctx, r.epsM, cellX(ce), midY, snapFont(600, 15), c.ink, 'right');
        snapDrawText(ctx, r.epsC, cellX(colOf('epsC')), midY, snapFont(600, 15), c.ink, 'right');
      }
    }
    ctx.strokeStyle = c.border;
    ctx.beginPath();
    ctx.moveTo(padX, y + h - 0.5);
    ctx.lineTo(W - padX, y + h - 0.5);
    ctx.stroke();
    y += h;
  }

  // ── 註腳 ──
  y += 10;
  if (footLines.length) {
    footLines.forEach((ln, i) => {
      snapDrawText(ctx, ln, padX, y + i * 20 + 8, snapFont(400, 13), c.muted);
    });
    y += footLines.length * 20 + 6;
  }

  // ── 出處列 ──
  const src = `${location.origin}${location.pathname}`.replace(/index\.html$/, '');
  snapDrawText(ctx, `產生時間：${fmtDateTime(new Date().toISOString())}`, padX, y + 14, snapFont(400, 12), c.muted);
  snapDrawText(ctx, src, W - padX, y + 14, snapFont(400, 12), c.muted, 'right');

  return canvas;
}

// ── 圖片視窗 ───────────────────────────────────────────
function openSnapshot() {
  if (!state.data || state.loading) { alert('資料尚未載入，請稍候再試'); return; }
  try {
    const canvas = renderTableImage();
    const img = document.getElementById('snapshot-img');
    img.src = canvas.toDataURL('image/png');
    _snapshotBlob = null;
    canvas.toBlob(b => { _snapshotBlob = b; }, 'image/png');

    // 不支援原生分享時隱藏「分享」鈕（桌機瀏覽器多半不支援檔案分享）
    const shareBtn = document.getElementById('snapshot-share');
    const canShare = !!(navigator.canShare && navigator.share);
    shareBtn.style.display = canShare ? '' : 'none';

    document.getElementById('snapshot-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  } catch (e) {
    console.error('snapshot failed:', e);
    alert(`產生圖片失敗：${e.message || e}`);
  }
}

function closeSnapshot(evt) {
  // 點遮罩才關閉；點視窗內部（已 stopPropagation）與按 ✕（無 evt）都會走到這裡
  if (evt && evt.target && evt.target.id !== 'snapshot-overlay') return;
  const img = document.getElementById('snapshot-img');
  img.classList.remove('zoom');
  document.getElementById('snapshot-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

// 預覽時點圖片切換「符合寬度／原始大小」，方便分享前先核對數字
function toggleSnapshotZoom() {
  const img = document.getElementById('snapshot-img');
  img.classList.toggle('zoom');
  const hint = document.querySelector('.snapshot-hint');
  if (hint) {
    hint.textContent = img.classList.contains('zoom')
      ? '已放大，可左右捲動；再點一次縮回'
      : '長按圖片可儲存或分享；點圖片可放大';
  }
}

function snapshotFilename() {
  const period = periodAd(state.data.report_period || '').replace('/', '-');
  const scope = state.viewMode === 'holdings' ? 'holdings' : state.viewMode;
  return `taiwan-fhcs-${period}-${scope}.png`;
}

function downloadSnapshot() {
  const img = document.getElementById('snapshot-img');
  const a = document.createElement('a');
  a.href = img.src;
  a.download = snapshotFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareSnapshot() {
  try {
    if (!_snapshotBlob) {
      const res = await fetch(document.getElementById('snapshot-img').src);
      _snapshotBlob = await res.blob();
    }
    const file = new File([_snapshotBlob], snapshotFilename(), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: `台灣金控月自結獲利 ${periodLabel(state.data.report_period)}`,
      });
    } else {
      downloadSnapshot();
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // 使用者取消分享
    console.error('share failed:', e);
    downloadSnapshot();
  }
}

// ── Excel 下載 ─────────────────────────────────────────
// 動態載入 SheetJS（首次點擊才載入，避免初始 bundle 膨脹）。
// 使用 xlsx-js-style：與 SheetJS 相同 API，但支援 cell.s 樣式（字型／底色／框線／對齊），
// 以便匯出檔的表頭底色、負數紅字、YoY 方向色、FVOCI 淡藍斜體列與網頁完全一致。
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let _xlsxLoading = null;
function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_CDN;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { _xlsxLoading = null; reject(new Error('SheetJS 載入失敗（請檢查網路）')); };
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

// ── Excel 樣式（對應 style.css 的色彩系統，色碼去掉 #） ──
const XC = {
  ink: '101418', ink2: '3D4653', muted: '6B7684',
  pos: '1F6F54', neg: 'A3312A',
  fvoci: '4A5A8F', fvociBg: 'F7F8FC',
  headBg: 'FAFBFC', totalBg: 'EEF1F9',
  border: 'E6E8EC', borderStrong: 'D5D9E0',
  primary: '1A3FA0', white: 'FFFFFF',
};
const XFONT = 'Microsoft JhengHei';   // 對應網頁的中文無襯線字型

const XB = {
  bottom:  { bottom: { style: 'thin',   color: { rgb: XC.border } } },
  bottomH: { bottom: { style: 'medium', color: { rgb: XC.borderStrong } } },
  bottomG: { bottom: { style: 'thin',   color: { rgb: XC.border } } },
  topNote: { top:    { style: 'thin',   color: { rgb: XC.border } } },
};

// 儲存格樣式產生器（對齊網頁：金額墨黑、負數紅、方向色只給 YoY、FVOCI 列淡藍斜體）
const XS = {
  headGroup: {
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: XC.ink2 } },
    fill: { fgColor: { rgb: XC.headBg } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: XB.bottomG,
  },
  headCol: (align) => ({
    font: { name: XFONT, sz: 10, bold: true, color: { rgb: XC.muted } },
    fill: { fgColor: { rgb: XC.headBg } },
    alignment: { horizontal: align || 'right', vertical: 'center', wrapText: false },
    border: XB.bottomH,
  }),
  code: {
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: XC.muted } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: XB.bottom,
  },
  name: {
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: XC.ink } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: XB.bottom,
  },
  text: {
    font: { name: XFONT, sz: 11, color: { rgb: XC.ink2 } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: XB.bottom,
  },
  num: (v) => ({
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: (v != null && v < 0) ? XC.neg : XC.ink } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: XB.bottom,
  }),
  yoy: (v) => ({
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: (v != null && v < 0) ? XC.neg : XC.pos } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: XB.bottom,
  }),
  noteCell: {
    font: { name: XFONT, sz: 10, italic: true, color: { rgb: XC.muted } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: XB.bottom,
  },
  date: {
    font: { name: XFONT, sz: 11, color: { rgb: XC.primary } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: XB.bottom,
  },
  // FVOCI 加計列：淡藍底 + 靛藍斜體（與網頁 .fvoci-row 一致）
  fvociLabel: {
    font: { name: XFONT, sz: 10, color: { rgb: XC.fvoci } },
    fill: { fgColor: { rgb: XC.fvociBg } },
    alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
    border: XB.bottom,
  },
  fvociNum: {
    font: { name: XFONT, sz: 10, italic: true, color: { rgb: XC.fvoci } },
    fill: { fgColor: { rgb: XC.fvociBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: XB.bottom,
  },
  fvociBlank: {
    fill: { fgColor: { rgb: XC.fvociBg } },
    border: XB.bottom,
  },
  footnote: {
    font: { name: XFONT, sz: 9, color: { rgb: XC.muted } },
    alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
    border: XB.topNote,
  },
  totalName: {
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: XC.ink } },
    fill: { fgColor: { rgb: XC.totalBg } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: XB.bottom,
  },
  totalNum: {
    font: { name: XFONT, sz: 11, bold: true, color: { rgb: XC.ink } },
    fill: { fgColor: { rgb: XC.totalBg } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: XB.bottom,
  },
};

// 數字格式：與網頁 formatNum() 的小數位規則一致
function xNumFmt(v) {
  if (v == null) return '#,##0';
  if (state.displayUnit === '億元') return '#,##0.##';
  const a = Math.abs(v);
  if (a >= 1000) return '#,##0';
  if (a >= 10) return '#,##0.0';
  if (a >= 0.1) return '0.00';
  return '0.000';
}
const X_PCT_FMT = '"+"0.0%;"-"0.0%';   // 顯示 +89.6% / -12.3%
const X_EPS_FMT = '0.00';

// 儲存格快捷建構
const xNum = (v, style) => (v == null
  ? { v: '—', t: 's', z: 'General', s: { ...(style || XS.num(null)), alignment: { horizontal: 'right', vertical: 'center' } } }
  : { v, t: 'n', z: xNumFmt(v), s: style || XS.num(v) });
const xEps = (v) => (v == null
  ? { v: '—', t: 's', z: 'General', s: XS.num(null) }
  : { v, t: 'n', z: X_EPS_FMT, s: XS.num(v) });
const xText = (v, style) => ({ v: v == null ? '' : v, t: 's', z: 'General', s: { ...(style || XS.text) } });

// YoY 儲存格使用數值 + 百分比格式（Excel 可排序）。
function xYoY(pct, abs, status, sourceUnit, displayUnit) {
  if (status === 'not_presented') return xText('');
  if (status && status !== 'normal' && STATUS_LABELS[status]) return xText(formatYoY(pct, abs, status, sourceUnit, displayUnit).disp, XS.noteCell);
  if (pct == null) return { v: '—', t: 's', z: 'General', s: { ...XS.noteCell } };
  if (status === 'loss_to_profit' || status === 'profit_to_loss') {
    const label = status === 'loss_to_profit' ? '虧轉盈' : '盈轉虧';
    const a = abs != null ? convertUnit(abs, sourceUnit, displayUnit) : null;
    const txt = a != null ? `${label} ${a >= 0 ? '+' : ''}${formatNum(a)}` : label;
    return { v: txt, t: 's', z: 'General', s: XS.yoy(status === 'profit_to_loss' ? -1 : 1) };
  }
  return { v: pct / 100, t: 'n', z: X_PCT_FMT, s: XS.yoy(pct) };
}

// 由 matrix（二維 cell 物件，null = 空白）建立工作表
function xSheet(matrix, opts = {}) {
  const XLSX = window.XLSX;
  const ws = {};
  let maxC = 0;
  matrix.forEach((row, R) => {
    row.forEach((cell, C) => {
      if (C > maxC) maxC = C;
      if (cell == null) return;
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const o = { t: cell.t || (typeof cell.v === 'number' ? 'n' : 's'), v: cell.v };
      if (cell.z) o.z = cell.z;
      if (cell.s) o.s = cell.s;
      ws[addr] = o;
    });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(matrix.length - 1, 0), c: maxC } });
  if (opts.cols) ws['!cols'] = opts.cols;
  if (opts.rows) ws['!rows'] = opts.rows;
  if (opts.merges) ws['!merges'] = opts.merges;
  // 註：瀏覽器端的 SheetJS／xlsx-js-style 只能「讀」凍結窗格、無法寫入，
  // 故不設 !freeze（舊版寫了也不會生效）。需要凍結請於 Excel 內自行設定。
  return ws;
}

// 取得「不屬於 bank/life/securities」的子公司列（產險、投信、票券、創投…）
function getOtherSubsidiaryRows() {
  const rows = [];
  for (const c of state.data.companies || []) {
    if (c.error) continue;
    for (const s of c.subsidiaries || []) {
      if (classifyIndustry(s.name) != null) continue;
      rows.push({
        parent_code: c.code,
        parent_name: c.name,
        name: s.name,
        unit: c.unit,
        monthly_profit: s.monthly_profit,
        cumulative_profit: s.cumulative_profit,
        cumulative_profit_yoy_pct: s.cumulative_profit_yoy_pct,
        cumulative_profit_yoy_abs: s.cumulative_profit_yoy_abs,
        cumulative_profit_yoy_status: s.cumulative_profit_yoy_status,
      });
    }
  }
  return rows;
}

// ── Sheet 1：金控總覽（對應網頁「金控總覽」表，含雙層表頭與 FVOCI 加計子列） ──
function buildHoldingsSheet(d, unit) {
  const headings = ['代號','金控',`當月 ${periodAd(d.report_period)} (${unit})`,'當月 MoM','累計','累計 YoY','公告單月 EPS','累計 EPS','公告日期','比較口徑'];
  const matrix = [headings.map(t => xText(t, XS.headCol()))];
  for (const c of sortCompanies([...d.companies])) {
    const h = c.holding_company || {};
    const cmp = A.comparison(monthCache, comparisonRules, c.code, [d.report_period], [A.shift(d.report_period,-1)]);
    matrix.push([xText(c.code),xText(c.name),xNum(convertUnit(h.monthly_profit,c.unit,unit)),comparisonExcel(cmp),
      xNum(convertUnit(h.cumulative_profit,c.unit,unit)),xYoY(h.cumulative_profit_yoy_pct,h.cumulative_profit_yoy_abs,h.cumulative_profit_yoy_status,c.unit,unit),
      xEps(h.monthly_eps),xEps(h.cumulative_eps),xText(dateAd(c.announcement_date)||'—'),xText(c.error ? c.error_msg || '未取得資料' : [h.cumulative_profit_yoy_reason,comparisonRules.basis_notes[c.code]].filter(Boolean).join('；'))]);
    const a = h.fvoci_adjusted;
    if (a) {
      const fd = fvociDisplay(a,c.unit,unit);
      const bound = a.value_type === 'lower_bound';
      matrix.push([null,xText(FVOCI_LABEL_TEXT),bound?xText(fd.monthlyDisp):xNum(convertUnit(a.monthly_profit,c.unit,unit)),null,
        bound?xText(fd.cumulDisp):xNum(convertUnit(a.cumulative_profit,c.unit,unit)),xText(''),null,xEps(a.cumulative_eps),null,xText(FVOCI_FOOTNOTE_HOLDINGS)]);
    }
  }
  return trendSheet(matrix,{cols:[{wch:9},{wch:30},{wch:24},{wch:24},{wch:20},{wch:25},{wch:17},{wch:15},{wch:15},{wch:80}]});
}

// FVOCI 加計列（金控／壽險共用）：整列鋪淡藍底，標籤欄靛藍、數字欄斜體
function fvociRowCells(a, sourceUnit, unit, cfg) {
  // 註：xlsx-js-style 會以 style 物件識別樣式，同一個 s 物件混用數值／文字會讓
  // 文字格互相沿用到別格的 numFmt。故每格都明確給 z（文字給 'General'），並用
  // 淺拷貝的樣式物件，避免共用參照。
  const fs = () => ({ ...XS.fvociNum });
  const cells = new Array(cfg.width).fill(null).map(() => ({ v: '', t: 's', z: 'General', s: { ...XS.fvociBlank } }));
  cells[cfg.labelCols[1]] = { v: `${FVOCI_LABEL_TEXT}*`, t: 's', z: 'General', s: { ...XS.fvociLabel } };

  const mv = convertUnit(a.monthly_profit, sourceUnit, unit);
  cells[cfg.monthlyCol] = mv == null
    ? { v: '—', t: 's', z: 'General', s: fs() }
    : a.value_type === 'lower_bound'
      ? { v: `${a.monthly_display_prefix || a.display_prefix || '逾'} ${formatNum(mv)}`, t: 's', z: 'General', s: fs() }
      : { v: mv, t: 'n', z: xNumFmt(mv), s: fs() };

  const cv = convertUnit(a.cumulative_profit, sourceUnit, unit);
  cells[cfg.cumulCol] = a.value_type === 'lower_bound'
    ? { v: `${a.display_prefix || '逾'} ${formatNum(cv)}`, t: 's', z: 'General', s: fs() }
    : { v: cv, t: 'n', z: xNumFmt(cv), s: fs() };

  if (cfg.yoyCol != null) {
    cells[cfg.yoyCol] = a.yoy_status === 'not_presented' ? xText('', fs()) : (a.value_type === 'lower_bound' || a.yoy_pct == null)
      ? { v: '—', t: 's', z: 'General', s: fs() }
      : { v: a.yoy_pct / 100, t: 'n', z: X_PCT_FMT, s: fs() };
  }
  if (cfg.epsCol != null && cfg.epsValue != null) {
    cells[cfg.epsCol] = { v: cfg.epsValue, t: 'n', z: X_EPS_FMT, s: fs() };
  }
  return cells;
}

// ── Sheet 2–4：銀行／壽險／證券子公司（對應網頁產業視角表） ──
function buildIndustrySheet(industry, d, unit) {
  const period = d.report_period || '';
  const rows = sortIndustryRows(getIndustryRows(industry));
  const m = [[
    xText('集團', XS.headCol('left')),
    xText(`${VIEW_TITLES[industry]}子公司`, XS.headCol('left')),
    xText(`當月 (${periodAd(period)})`, XS.headCol()),
    xText('累計', XS.headCol()),
    xText('累計 YoY', XS.headCol()),
  ]];

  let hasFvoci = false;
  for (const r of rows) {
    const mo = convertUnit(r.monthly_profit, r.unit, unit);
    const cu = convertUnit(r.cumulative_profit, r.unit, unit);
    let yoyCell = xYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs, r.cumulative_profit_yoy_status, r.unit, unit);
    if (r.cumulative_profit_yoy_pct == null && showMergerNote(r.parent_code, period)) {
      yoyCell = xText('2025/07 正式合併', XS.noteCell);
    }
    if (r.cumulative_profit_yoy_pct == null && r.name.includes('京城') && showMergerNote('2890', period)) {
      yoyCell = xText('2025/10 併入獲利公告', XS.noteCell);
    }
    m.push([xText(r.parent_name, XS.code), xText(r.name, XS.name), xNum(mo), xNum(cu), yoyCell]);

    const a = r.fvoci_adjusted;
    if (industry === 'life' && a && a.cumulative_profit != null) {
      hasFvoci = true;
      m.push(fvociRowCells(a, r.unit, unit, {
        labelCols: [null, 1], width: 5, monthlyCol: 2, cumulCol: 3, yoyCol: 4,
      }));
    }
  }

  if (rows.length === 0) {
    m.push([xText(`此期間無${VIEW_TITLES[industry]}資料`, XS.noteCell), null, null, null, null]);
  }

  const merges = [];
  const rowHeights = [];
  if (hasFvoci) {
    m.push([{ v: `* ${FVOCI_FOOTNOTE}`, t: 's', s: XS.footnote }, null, null, null, null]);
    merges.push({ s: { r: m.length - 1, c: 0 }, e: { r: m.length - 1, c: 4 } });
    rowHeights[m.length - 1] = { hpx: 44 };
  }

  return xSheet(m, {
    cols: [{ wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 14 }],
    merges, rows: rowHeights,
  });
}

// ── Sheet 5：其他子公司（產險、投信、票券、創投…） ──
function buildOtherSheet(unit, period) {
  const rows = getOtherSubsidiaryRows();
  if (rows.length === 0) return null;
  const m = [[
    xText('集團', XS.headCol('left')),
    xText('子公司', XS.headCol('left')),
    xText(`當月 (${periodAd(period)})`, XS.headCol()),
    xText('累計', XS.headCol()),
    xText('累計 YoY', XS.headCol()),
  ]];
  for (const r of rows) {
    m.push([
      xText(r.parent_name, XS.code), xText(r.name, XS.name),
      xNum(convertUnit(r.monthly_profit, r.unit, unit)),
      xNum(convertUnit(r.cumulative_profit, r.unit, unit)),
      xYoY(r.cumulative_profit_yoy_pct, r.cumulative_profit_yoy_abs, r.cumulative_profit_yoy_status, r.unit, unit),
    ]);
  }
  return xSheet(m, { cols: [{ wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 14 }] });
}

// ── Sheet 6：市場概況 ──
function buildMarketSheet(ms) {
  if (!ms || !ms.items) return null;
  const it = ms.items;
  const m = [[
    xText('指標', XS.headCol('left')),
    xText('本月底', XS.headCol()),
    xText('上月底', XS.headCol()),
    xText('變動', XS.headCol()),
    xText('備註', XS.headCol('left')),
  ]];
  const pctCell = (v) => (v == null
    ? { v: '—', t: 's', s: XS.noteCell }
    : { v: v / 100, t: 'n', z: '"+"0.00%;"-"0.00%', s: XS.yoy(v) });
  const bpsCell = (v) => (v == null
    ? { v: '—', t: 's', s: XS.noteCell }
    : { v: `${v >= 0 ? '+' : ''}${v} bps`, t: 's', s: XS.yoy(v) });
  const row = (label, v, pv, change, note) => m.push([
    xText(label, XS.name), xNum(v), xNum(pv), change, xText(note, XS.text),
  ]);
  if (it.usdtwd) row('美元兌台幣', it.usdtwd.value, it.usdtwd.prev_value, pctCell(it.usdtwd.pct_change),
    `${it.usdtwd.date || ''} vs ${it.usdtwd.prev_date || ''}`);
  if (it.taiex) row('加權指數', it.taiex.value, it.taiex.prev_value, pctCell(it.taiex.pct_change),
    `點｜${it.taiex.date || ''} vs ${it.taiex.prev_date || ''}`);
  if (it.taiex_turnover) row('台股集中市場日均成交額', it.taiex_turnover.value_yi, it.taiex_turnover.prev_value_yi,
    pctCell(it.taiex_turnover.pct_change),
    `億元／日均（本月 ${it.taiex_turnover.trading_days || '?'} 日 / 上月 ${it.taiex_turnover.prev_trading_days || '?'} 日）`);
  if (it.spx) row('美股 S&P 500', it.spx.value, it.spx.prev_value, pctCell(it.spx.pct_change),
    `${it.spx.date || ''} vs ${it.spx.prev_date || ''}`);
  if (it.us10y) row('美國 10Y 公債殖利率', it.us10y.value_pct, it.us10y.prev_value_pct, bpsCell(it.us10y.bps_change),
    '%（變動以 bps 表示）');
  if (it.tlt) row('TLT（20年期以上美債 ETF）', it.tlt.value, it.tlt.prev_value, pctCell(it.tlt.pct_change),
    '壽險 FVTPL 境外長債部位代理指標');
  return xSheet(m, { cols: [{ wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 52 }] });
}

// 註：新聞摘要不列入 Excel（篇幅長、格式與四張數字表不一致）；
// 網頁上點金控名展開的詳情面板仍可閱讀，資料本身保留在 JSON 的 news_summary 欄位。

async function downloadExcel() {
  if (!state.data || state.loading) {
    alert('資料尚未載入，請稍候再試');
    return;
  }
  const btn = document.getElementById('btn-download');
  const textEl = btn.querySelector('.btn-download-text');
  const origText = textEl.textContent;
  btn.disabled = true;
  textEl.textContent = '載入中…';

  try {
    const XLSX = await loadXlsxLib();
    const d = state.data;
    const period = d.report_period || '';
    const unit = state.displayUnit;
    const wb = XLSX.utils.book_new();


    // 四張主表：與網頁的四個 tab 一一對應（欄位、順序、樣式一致）
    XLSX.utils.book_append_sheet(wb, buildHoldingsSheet(d, unit), '金控總覽');
    XLSX.utils.book_append_sheet(wb, buildIndustrySheet('bank', d, unit), '銀行子公司');
    XLSX.utils.book_append_sheet(wb, buildIndustrySheet('life', d, unit), '壽險子公司');
    XLSX.utils.book_append_sheet(wb, buildIndustrySheet('securities', d, unit), '證券子公司');

    // 補充資料（網頁未以表格呈現，但保留於檔案中）
    const wsOther = buildOtherSheet(unit, period);
    if (wsOther) XLSX.utils.book_append_sheet(wb, wsOther, '其他子公司');
    const wsMkt = buildMarketSheet(d.market_summary);
    if (wsMkt) XLSX.utils.book_append_sheet(wb, wsMkt, '市場概況');

    appendTrendSheets(wb, XLSX);
    appendAnalysisSheets(wb, XLSX);

    const filename = `taiwan-fhcs-${periodAd(period).replace('/', '-') || 'data'}.xlsx`;
    XLSX.writeFile(wb, filename);

    textEl.textContent = '✓ 已下載';
    setTimeout(() => { textEl.textContent = origText; btn.disabled = false; }, 2000);
  } catch (e) {
    console.error('downloadExcel failed:', e);
    alert(`下載失敗：${e.message || e}`);
    textEl.textContent = origText;
    btn.disabled = false;
  }
}

// 數字格式化（百萬元基準，加千分位）
function formatNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-TW', { maximumFractionDigits: state.displayUnit === '億元' ? 2 : Math.abs(n) < 1 ? 3 : 1 });
}

/* ═══════════════════════════════════════════════════════════════════
   草稿新增（2026-08）：
   1. 期間比較模式（季度／年度 YTD，跨公司比較）
   2. 單月獲利變動拆解（金控 MoM 歸因至子公司）＋ 總表「當月 MoM」欄
   ═══════════════════════════════════════════════════════════════════ */

// ── 月份資料共用快取（期間比較與 MoM 皆按需載入歷史月份） ──────────
const monthCache = {};
async function fetchMonth(period) {
  if (!period) return null;
  if (monthCache[period] !== undefined) return monthCache[period];
  try {
    const resp = await fetch(`./data/${period.replace('/', '-')}.json?_=${Date.now()}`);
    if (!resp.ok) { monthCache[period] = null; return null; }
    const d = await resp.json();
    monthCache[period] = (d && d.report_period === period && Array.isArray(d.companies)) ? d : null;
  } catch (e) {
    monthCache[period] = null;
  }
  return monthCache[period];
}
function monthInIndex(period) {
  return !!(state.index && (state.index.months || []).some(m => m.period === period));
}

// "115/01" → "114/12"（上一個月，民國年字串）
function prevMonthPeriod(period) {
  const m = String(period || '').match(/^(\d{2,3})\/(\d{1,2})$/);
  if (!m) return null;
  let y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1;
  if (mo === 0) { y -= 1; mo = 12; }
  return `${y}/${String(mo).padStart(2, '0')}`;
}

// ── MoM（與上月自結比較） ───────────────────────────────────────────
// 併購跨期（上月非同一實體）不作 MoM 比較。2887：114/07 台新新光合併首月。
function momComparable(code, period) {
  return !A.reason(comparisonRules, code, [period], [A.shift(period, -1)]);
}

// 子公司更名（同一實體，跨月對應用）：現名 → 上月可能的舊名
const SUB_PREV_ALIAS = { '玉山投信': '保德信投信' };

async function loadPrevMonth(period) {
  state.prevMonth = null;
  const prev = prevMonthPeriod(period);
  if (!prev || !monthInIndex(prev)) return;
  state.prevMonth = await fetchMonth(prev);
}

// MoM 顯示：同號給 %；跨零用 轉盈/轉虧＋絕對差額（單位跟隨顯示設定）；缺基期 —
function momInfo(cur, prev, sourceUnit, displayUnit) {
  const cmp = A.compare(A.toNTM(cur, sourceUnit), A.toNTM(prev, sourceUnit));
  return { ...cmp, ...formatYoY(cmp.pct, cmp.delta, cmp.status, '百萬元', displayUnit) };
}

// 金控層級 MoM（總表欄位／排序共用）
function holdingMomInfo(c) {
  const cmp = A.comparison(monthCache, comparisonRules, c.code, [state.data.report_period], [A.shift(state.data.report_period, -1)]);
  return { ...cmp, ...formatYoY(cmp.pct, cmp.delta, cmp.status, '百萬元', state.displayUnit) };
}

// 詳情面板：單月獲利變動拆解（金控 MoM 歸因至子公司）
function momAttributionHtml(c) {
  const d = state.data, prevD = state.prevMonth;
  if (!d || !prevD || c.error || !c.holding_company) return '';
  const period = d.report_period || '';
  const prevPer = prevD.report_period || '';
  if (!momComparable(c.code, period)) {
    return `<div class="mom-panel"><div class="mom-head"><span class="mom-title">單月獲利變動拆解</span></div>
      <p class="mom-note">${escapeHtml(periodAd(period))} 為合併首月，上月基期非同一實體，不作 MoM 比較。</p></div>`;
  }
  const pc = (prevD.companies || []).find(x => x.code === c.code);
  if (!pc || pc.error || !pc.holding_company) return '';
  const curH = c.holding_company.monthly_profit;
  const prevH = pc.holding_company.monthly_profit;
  if (curH == null || prevH == null) return '';

  const unit = state.displayUnit;
  const su = c.unit;                     // 來源單位（百萬元）
  const dH = curH - prevH;               // 金控增減（來源單位）
  const hMom = momInfo(curH, prevH, su, unit);

  // 子公司增減：本月清單為主，上月以名稱（含更名別名）對應
  const prevSubs = new Map((pc.subsidiaries || []).map(s => [s.name, s]));
  const usedPrev = new Set();
  const rows = [];
  for (const s of (c.subsidiaries || [])) {
    const pName = prevSubs.has(s.name) ? s.name : (SUB_PREV_ALIAS[s.name] && prevSubs.has(SUB_PREV_ALIAS[s.name]) ? SUB_PREV_ALIAS[s.name] : null);
    const p = pName ? prevSubs.get(pName) : null;
    if (pName) usedPrev.add(pName);
    if (s.monthly_profit == null) continue;
    if (p && p.monthly_profit != null) {
      rows.push({ name: s.name, prev: p.monthly_profit, cur: s.monthly_profit, delta: s.monthly_profit - p.monthly_profit, tag: null });
    } else {
      rows.push({ name: s.name, prev: null, cur: s.monthly_profit, delta: null, tag: '上月未列，不計增減' });
    }
  }
  for (const [name, p] of prevSubs) {
    if (usedPrev.has(name) || p.monthly_profit == null) continue;
    rows.push({ name, prev: p.monthly_profit, cur: null, delta: null, tag: '本月未列，不計增減' });
  }
  const sumSub = rows.reduce((a, r) => a + r.delta, 0);
  const resid = rows.some(r => r.delta == null) ? null : dH - sumSub;
  rows.sort((a, b) => b.delta - a.delta);

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.delta)), Math.abs(resid), 1);
  const fmtD = v => {
    if (v == null) return '—';
    const x = convertUnit(v, su, unit);
    return `${x >= 0 ? '+' : '-'}${formatNum(Math.abs(x))}`;
  };
  const fmtV = v => v == null ? '—' : formatNum(convertUnit(v, su, unit));

  const rowHtml = (r, extraCls, nameHtml) => {
    const pos = r.delta >= 0;
    const w = r.delta == null ? 0 : (Math.abs(r.delta) / maxAbs * 100).toFixed(1);
    return `<div class="mom-row ${extraCls || ''}">
      <div class="mom-name">${nameHtml}${r.tag ? `<span class="mom-tag">${r.tag}</span>` : ''}</div>
      <div class="mom-delta ${pos ? 'positive' : 'negative'}">${fmtD(r.delta)}</div>
      <div class="mom-bar-wrap"><div class="mom-bar ${pos ? 'pos' : 'neg'}" style="width:${w}%"></div></div>
      <div class="mom-vals">${fmtV(r.prev)} → ${fmtV(r.cur)}</div>
    </div>`;
  };

  const headRow = `<div class="mom-row mom-row-head">
    <div class="mom-name">子公司</div>
    <div class="mom-delta">增減額</div>
    <div></div>
    <div class="mom-vals">上月 → 本月</div>
  </div>`;
  const subRows = rows.map(r => rowHtml(r, '', escapeHtml(r.name))).join('');
  const residRow = rowHtml({ name: '', prev: null, cur: null, delta: resid, tag: null }, 'mom-row-resid',
    '母公司及其他（軋差）');

  return `<div class="mom-panel">
    <div class="mom-head">
      <span class="mom-title">單月獲利變動拆解（${periodAd(period)} vs ${periodAd(prevPer)}）</span>
      <span class="mom-total">金控 ${fmtV(prevH)} → ${fmtV(curH)}（<span class="${dH >= 0 ? 'positive' : 'negative'}">${fmtD(dH)}</span>、MoM <span class="${hMom.cls}">${hMom.disp}</span>）</span>
    </div>
    <div class="mom-rows">${headRow}${subRows}${residRow}</div>
    <p class="mom-note">單位：${unitFullLabel(unit)}。子公司增減合計與金控增減之差額列為「母公司及其他（軋差）」，含母公司本身損益、合併沖銷與未揭露項目；任一子公司跨月未列時，不推算該項增減及總軋差。MoM 比較之基準為各月自結公告數。</p>
  </div>`;
}

// ── 期間比較模式 ────────────────────────────────────────────────────

// 期間選項：由 index.json 月份清單產生「季度 + 年度（YTD）」，不提供任意起訖月
function buildPeriodOptions() {
  const months = (state.index?.months || []).map(m => m.period).sort();   // 舊→新
  const set = new Set(months);
  const opts = [];

  const byYQ = {};
  for (const p of months) {
    const [y, m] = p.split('/');
    const q = Math.ceil(parseInt(m, 10) / 3);
    (byYQ[`${y}-${q}`] ||= []).push(p);
  }
  for (const k of Object.keys(byYQ).sort().reverse()) {          // 新→舊
    const [y, q] = k.split('-');
    const present = byYQ[k];
    const last = present[present.length - 1];
    const ms = A.range(last, Number(last.split('/')[1]) - (Number(q)-1)*3);
    const full = ms.length === 3;
    const lastM = parseInt(ms[ms.length - 1].split('/')[1], 10);
    const base = ms.map(p => prevYearPeriod(p));
    opts.push({
      key: `q-${k}`, kind: 'quarter', partial: !full,
      label: `${adYear(y)}/${String((q-1)*3+1).padStart(2,'0')}–${String(lastM).padStart(2,'0')}${full ? '' : `（至${lastM}月）`}`,
      months: ms,
      baseMonths: base.every(b => set.has(b)) ? base : null,
    });
  }

  const byY = {};
  for (const p of months) (byY[p.split('/')[0]] ||= []).push(p);
  for (const y of Object.keys(byY).sort().reverse()) {
    const ms = A.yearMonths(byY[y].at(-1));
    const full = ms.length === 12;
    const lastM = parseInt(ms[ms.length - 1].split('/')[1], 10);
    const base = ms.map(p => prevYearPeriod(p));
    opts.push({
      key: `y-${y}`, kind: 'year', partial: !full,
      label: full ? `${adYear(y)}/01–12` : `${adYear(y)}/01–${String(lastM).padStart(2,'0')} 累計`,
      months: ms,
      baseMonths: base.every(b => set.has(b)) ? base : null,
    });
  }
  state.periodOptions = opts;
}

function renderPeriodSelector() {
  const sel = document.getElementById('period-select');
  if (!sel || !state.periodOptions.length) return;
  const group = (kind, label) => {
    const items = state.periodOptions.filter(o => o.kind === kind)
      .map(o => `<option value="${o.key}">${o.label}</option>`).join('');
    return items ? `<optgroup label="${label}">${items}</optgroup>` : '';
  };
  sel.innerHTML = group('quarter', '季度') + group('year', '年度');
  // 預設：最新的「完整」季度（進行中的季度另可自行選取）
  const def = state.periodOptions.find(o => o.kind === 'quarter' && !o.partial) || state.periodOptions[0];
  sel.value = def.key;
  state.periodSel = def;
}

async function ensurePeriodData(opt) {
  const need = new Set();
  const addBoundary = (ms) => {
    if (!ms) return;
    need.add(ms[ms.length - 1]);                                  // 期末
    if (!ms[0].endsWith('/01')) need.add(prevMonthPeriod(ms[0])); // 期初前月
  };
  addBoundary(opt.months);
  addBoundary(opt.baseMonths);
  opt.months.forEach(p => need.add(p));
  (opt.baseMonths || []).forEach(p => need.add(p));
  await Promise.all([...need].map(fetchMonth));
}

async function onPeriodChange() {
  const sel = document.getElementById('period-select');
  const opt = state.periodOptions.find(o => o.key === sel.value) || state.periodOptions[0];
  if (!opt) return;
  state.periodSel = opt;
  await ensurePeriodData(opt);
  closeDetail();
  renderAll();
  resetTableScroll();
}

// 期間彙總核心：期間獲利＝期末累計 − 期初前月累計（各公司公告自結數）。
// 一月起算的期間直接用期末累計（累計每年一月歸零）。EPS 同法軋差，屬推算值。
// 子公司以名稱對應（含更名別名）；必要月份缺資料者不推算、不補零。
function periodAggCompany(months, code) {
  if (!months || !months.length) return null;
  if (A.complete(monthCache, months, code, 'cumulative_profit').missing.length) return null;
  const endD = monthCache[months[months.length - 1]];
  if (!endD) return null;
  const c = (endD.companies || []).find(x => x.code === code);
  if (!c || c.error || !c.holding_company || c.holding_company.cumulative_profit == null) return null;

  let baseC = null;
  if (!months[0].endsWith('/01')) {
    const bD = monthCache[prevMonthPeriod(months[0])];
    baseC = bD ? (bD.companies || []).find(x => x.code === code) : null;
    if (!baseC || baseC.error || !baseC.holding_company || baseC.holding_company.cumulative_profit == null) return null;
  }

  const toM = (v, u) => convertUnit(v, u || '百萬元', '百萬元');
  const endCum = toM(c.holding_company.cumulative_profit, c.unit);
  const baseCum = baseC ? toM(baseC.holding_company.cumulative_profit, baseC.unit) : 0;
  const endEps = c.holding_company.cumulative_eps;
  const baseEps = baseC ? baseC.holding_company.cumulative_eps : 0;
  const eps = (endEps != null && baseEps != null) ? endEps - baseEps : null;

  const baseSubs = new Map(((baseC && baseC.subsidiaries) || []).map(s => [s.name, s]));
  const subs = [];
  for (const s of (c.subsidiaries || [])) {
    if (s.cumulative_profit == null) continue;
    const bName = baseSubs.has(s.name) ? s.name
      : (SUB_PREV_ALIAS[s.name] && baseSubs.has(SUB_PREV_ALIAS[s.name]) ? SUB_PREV_ALIAS[s.name] : null);
    const b = bName ? baseSubs.get(bName) : null;
    if (baseC && (!b || b.cumulative_profit == null)) continue;
    if (A.complete(monthCache, months, code, 'cumulative_profit', s.name, comparisonRules).missing.length) continue;
    const bCum = b ? toM(b.cumulative_profit, baseC.unit) : 0;
    subs.push({ name: s.name, profit: toM(s.cumulative_profit, c.unit) - bCum });
  }
  return { code, name: c.name, profit: endCum - baseCum, eps, subs };
}

// 期間 YoY 顯示公告數變動率，整個窗口的事件另留說明。
function periodYoyOf(opt, code, curProfit) {
  const b = opt.baseMonths ? periodAggCompany(opt.baseMonths, code) : null;
  const why = opt.baseMonths ? A.reason(comparisonRules, code, opt.months, opt.baseMonths) : '';
  const c = A.reportedYoY(curProfit, b?.profit ?? null, why);
  return { ...c, abs: c.delta, base: c.base };
}

function periodRangeText(months) {
  if (!months || !months.length) return '';
  const a = periodAd(months[0]), b = periodAd(months[months.length - 1]);
  return months.length === 1 ? a : `${a}–${b.split('/')[1]}`;
}

// 期間比較的排序
function sortPeriodRows(rows) {
  const m = state.sortMode;
  const arr = [...rows];
  switch (m) {
    case 'pprofit_asc':  return arr.sort((a, b) => (a.profit ?? Infinity) - (b.profit ?? Infinity));
    case 'pyoy_desc':    return arr.sort((a, b) => compareYoYDesc(a.yoy.pct, a.yoy.status, b.yoy.pct, b.yoy.status));
    case 'peps_desc':    return arr.sort((a, b) => (b.eps ?? -Infinity) - (a.eps ?? -Infinity));
    case 'code':         return arr.sort((a, b) => String(a.code || a.parent_code).localeCompare(String(b.code || b.parent_code)));
    case 'pprofit_desc':
    default:             return arr.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  }
}

// 期間 YoY 顯示（沿用 formatYoY 慣例；merger 顯示註記）
function periodYoyDisp(yoy, sourceUnit, unit) {
  if (yoy.status === 'incomparable') return {disp: `<span class="yoy-note" title="${escapeHtml(yoy.reason || '')}">口徑不同</span>`, cls:''};
  if (yoy.status === 'merger') return { disp: '<span class="yoy-note">基期為合併前</span>', cls: '' };
  return formatYoY(yoy.pct, yoy.abs, yoy.status, sourceUnit, unit);
}

// ── 期間比較：主渲染 ──
function renderPeriodAll() {
  const opt = state.periodSel;
  if (!opt) return;

  updatePeriodBadge();
  const lu = document.getElementById('last-updated');
  if (lu) {
    const baseTxt = opt.baseMonths ? `｜去年同期：${periodRangeText(opt.baseMonths)}` : '｜無去年同期資料';
    lu.textContent = `本期：${periodRangeText(opt.months)}${baseTxt}`;
  }
  document.getElementById('market-section').classList.add('hidden');

  const holdRows = buildPeriodHoldingRows(opt);
  renderPeriodSummaryCards(opt, holdRows);
  if (state.viewMode === 'holdings') renderPeriodHoldingsTable(opt, holdRows);
  else renderPeriodIndustryTable(opt, state.viewMode);
  renderPeriodChart(opt, holdRows);
}

function buildPeriodHoldingRows(opt) {
  const endD = monthCache[opt.months[opt.months.length - 1]];
  if (!endD) return [];
  const rows = [];
  for (const c of (endD.companies || [])) {
    const agg = periodAggCompany(opt.months, c.code);
    if (!agg) { rows.push({code:c.code,name:c.name,profit:null,eps:null,subs:[],yoy:{pct:null,abs:null,status:'missing',base:null},rank:null}); continue; }
    rows.push({ code: c.code, name: c.name, profit: agg.profit, eps: agg.eps, subs: agg.subs, yoy: periodYoyOf(opt, c.code, agg.profit) });
  }
  const byProfit = [...rows].sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  byProfit.filter(r => r.profit != null).forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function renderPeriodSummaryCards(opt, holdRows) {
  const el = document.getElementById('summary-cards');
  const unit = state.displayUnit;
  el.classList.remove('is-pending');
  const mk = (label, best) => leaderCard(label, best, unit);
  const bestHold = holdRows.reduce((b, r) => (!b || r.profit > b.raw) ? {
    raw: r.profit, name: r.name,
    amount: convertUnit(r.profit, '百萬元', unit),
    yoy: periodYoyDisp(r.yoy, '百萬元', unit),
  } : b, null);
  const bestInd = (ind) => {
    let b = null;
    for (const r of buildPeriodIndustryRows(opt, ind)) {
      if (r.profit == null) continue;
      if (!b || r.profit > b.raw) b = {
        raw: r.profit, name: r.name,
        amount: convertUnit(r.profit, '百萬元', unit),
        yoy: periodYoyDisp(r.yoy, '百萬元', unit),
      };
    }
    return b;
  };
  el.innerHTML = [
    mk(`金控${opt.label}獲利第一`, bestHold),
    mk(`壽險${opt.label}獲利第一（不含FVOCI）`, bestInd('life')),
    mk(`銀行${opt.label}獲利第一`, bestInd('bank')),
    mk(`證券${opt.label}獲利第一`, bestInd('securities')),
  ].join('');
}

function renderPeriodHoldingsTable(opt, holdRows) {
  const unit = state.displayUnit;
  const tableEl = document.getElementById('main-table');
  if (tableEl) { tableEl.classList.remove('view-holdings', 'view-industry'); tableEl.classList.add('view-period'); }

  const hint = document.getElementById('table-unit-hint');
  if (hint) hint.textContent = `單位：${unitFullLabel(unit)}（EPS 為元）｜期間獲利＝期末累計 − 期初前月累計（公告自結數）`;

  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th class="col-code">排名</th>
      <th class="col-code">代號</th>
      <th class="col-name">金控</th>
      <th class="col-monthly">期間稅後淨利<br><span class="th-sub">${periodRangeText(opt.months)}</span></th>
      <th class="col-monthly">去年同期<br><span class="th-sub">${opt.baseMonths ? periodRangeText(opt.baseMonths) : '—'}</span></th>
      <th class="col-cumulative">期間 YoY</th>
      <th class="col-cumulative">期間 EPS（推算）</th>
    </tr>`;

  const rows = sortPeriodRows(holdRows);
  document.getElementById('main-tbody').innerHTML = rows.map(r => {
    const v = convertUnit(r.profit, '百萬元', unit);
    const bv = r.yoy.base != null ? convertUnit(r.yoy.base, '百萬元', unit) : null;
    const yi = periodYoyDisp(r.yoy, '百萬元', unit);
    let yoyDisp = yi.disp;
    return `<tr>
      <td class="center rank-cell${r.rank === 1 ? ' rank-top' : ''}">${r.rank ?? '—'}</td>
      <td class="col-code">${r.code}</td>
      <td><a class="company-link" onclick="showPeriodDetail('${r.code}')">${r.name}</a></td>
      <td class="num ${v >= 0 ? 'positive' : 'negative'}">${formatNum(v)}</td>
      <td class="num pd-base">${bv != null ? formatNum(bv) : '—'}</td>
      <td class="num yoy ${yi.cls}">${yoyDisp}</td>
      <td class="num">${r.eps != null ? formatEps(r.eps) : '—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('main-tfoot').innerHTML =
    `<tr><td colspan="7" class="table-footnote"><span>${PERIOD_FOOTNOTE}${opt.partial ? ` 本期間尚未結束（${periodRangeText(opt.months)}），去年同期取相同月份比較。` : ''}</span></td></tr>`;
}

const PERIOD_FOOTNOTE = '期間獲利＝期末累計 − 期初前月累計（各公司公告自結數，含公告重編之影響）；合庫金公告之單月數為合併基準、累計數為母公司業主基準，期間數一律以累計軋差為準。期間 EPS 為累計 EPS 軋差之推算值，增資／換股月份或有失真。期間比較不含加計 FVOCI 之揭露數。';

function buildPeriodIndustryRows(opt, industry) {
  const rows = [];
  for (const c of monthCache[opt.months.at(-1)]?.companies || []) {
    if (c.error) continue;
    const agg = periodAggCompany(opt.months, c.code);
    if (!agg) continue;
    const b = opt.baseMonths ? periodAggCompany(opt.baseMonths, c.code) : null;
    for (const sub of agg.subs) {
      if (classifyIndustry(sub.name) !== industry) continue;
      const prior = b?.subs.find(s => s.name === sub.name || s.name === comparisonRules.aliases[sub.name]);
      const why = opt.baseMonths ? A.reason(comparisonRules, c.code, opt.months, opt.baseMonths, sub.name) : '';
      const cmp = A.reportedYoY(sub.profit, prior?.profit ?? null, why);
      rows.push({parent_code:c.code,parent_name:c.name,code:c.code,name:sub.name,profit:sub.profit,eps:null,
        yoy:{...cmp,abs:cmp.delta,base:cmp.base}});
    }
  }
  return rows;
}

function renderPeriodIndustryTable(opt, industry) {
  const unit = state.displayUnit;
  const tableEl = document.getElementById('main-table');
  if (tableEl) { tableEl.classList.remove('view-holdings', 'view-industry'); tableEl.classList.add('view-period'); }

  const hint = document.getElementById('table-unit-hint');
  if (hint) hint.textContent = `單位：${unitFullLabel(unit)}｜期間獲利＝期末累計 − 期初前月累計（公告自結數）`;

  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th class="col-code">排名</th>
      <th class="col-code">集團</th>
      <th class="col-name">${VIEW_TITLES[industry]}子公司</th>
      <th class="col-monthly">期間稅後淨利<br><span class="th-sub">${periodRangeText(opt.months)}</span></th>
      <th class="col-monthly">去年同期<br><span class="th-sub">${opt.baseMonths ? periodRangeText(opt.baseMonths) : '—'}</span></th>
      <th class="col-cumulative">期間 YoY</th>
    </tr>`;

  const raw = buildPeriodIndustryRows(opt, industry);
  if (!raw.length) {
    document.getElementById('main-tbody').innerHTML =
      `<tr><td colspan="6" class="loading-cell">此期間無${VIEW_TITLES[industry]}資料</td></tr>`;
    document.getElementById('main-tfoot').innerHTML = '';
    return;
  }
  const byProfit = [...raw].sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  byProfit.filter(r => r.profit != null).forEach((r, i) => { r.rank = i + 1; });
  const rows = sortPeriodRows(raw);

  document.getElementById('main-tbody').innerHTML = rows.map(r => {
    const v = convertUnit(r.profit, '百萬元', unit);
    const bv = r.yoy.base != null ? convertUnit(r.yoy.base, '百萬元', unit) : null;
    const yi = periodYoyDisp(r.yoy, '百萬元', unit);
    let yoyDisp = yi.disp;
    if (yi.disp === '—' && r.name.includes('京城')) {
      yoyDisp = '<span class="yoy-note">2025/10 併入獲利公告</span>';
    }
    return `<tr>
      <td class="center rank-cell${r.rank === 1 ? ' rank-top' : ''}">${r.rank ?? '—'}</td>
      <td><a class="company-link" onclick="showPeriodDetail('${r.parent_code}')">${r.parent_name}</a></td>
      <td class="col-entity">${r.name}</td>
      <td class="num ${v >= 0 ? 'positive' : 'negative'}">${formatNum(v)}</td>
      <td class="num pd-base">${bv != null ? formatNum(bv) : '—'}</td>
      <td class="num yoy ${yi.cls}">${yoyDisp}</td>
    </tr>`;
  }).join('');

  const lifeNote = industry === 'life' ? ' 壽險列示為原始稅後損益，不含加計 FVOCI 之揭露數。' : '';
  document.getElementById('main-tfoot').innerHTML =
    `<tr><td colspan="6" class="table-footnote"><span>${PERIOD_FOOTNOTE}${lifeNote}</span></td></tr>`;
}

function renderPeriodChart(opt, holdRows) {
  if (typeof Chart === 'undefined') return;
  const unit = state.displayUnit;
  const scopeLabel = state.viewMode === 'holdings' ? '金控' : VIEW_TITLES[state.viewMode];
  document.getElementById('bar-chart-title').textContent =
    `${scopeLabel}期間獲利比較（${opt.label}${opt.baseMonths ? ' vs 去年同期' : ''}）`;

  const src = state.viewMode === 'holdings' ? holdRows : buildPeriodIndustryRows(opt, state.viewMode);
  const cur = [...src].filter(r => r.profit != null).sort((a, b) => b.profit - a.profit);
  const missing = [];
  const prior = cur.map(r => {
    if (!opt.baseMonths) return null;
    if (r.yoy.base == null || r.yoy.status === 'incomparable') { missing.push(r.name); return null; }
    return convertUnit(r.yoy.base, '百萬元', unit);
  });
  const series = {
    labels: cur.map(r => r.name),
    current: cur.map(r => convertUnit(r.profit, '百萬元', unit)),
    prior,
    missing: opt.baseMonths ? missing : [],
  };
  state.barChart = renderBarChart('bar-chart', state.barChart, series, `${opt.label}`, '去年同期', unit);

  const note = document.getElementById('bar-chart-note');
  if (!opt.baseMonths) {
    note.textContent = `${opt.label} 無去年同期資料（本站資料自 2025/01 起），僅顯示本期。`;
    note.classList.remove('hidden');
  } else {
    setChartNote('bar-chart-note', series.missing);
  }
}

// 期間比較：子公司拆解面板
function showPeriodDetail(code) {
  const opt = state.periodSel;
  if (!opt) return;
  const agg = periodAggCompany(opt.months, code);
  if (!agg) return;
  const unit = state.displayUnit;
  const baseAgg = opt.baseMonths ? periodAggCompany(opt.baseMonths, code) : null;
  const baseSubs = new Map(((baseAgg && baseAgg.subs) || []).map(s => [s.name, s.profit]));

  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');
  title.textContent = `${agg.name} (${code}) — ${opt.label} 子公司拆解`;

  const subSum = agg.subs.reduce((a, s) => a + (s.profit ?? 0), 0);
  const resid = agg.profit - subSum;
  const baseResid = baseAgg ? baseAgg.profit - baseAgg.subs.reduce((a, s) => a + (s.profit ?? 0), 0) : null;
  const maxAbs = Math.max(...agg.subs.map(s => Math.abs(s.profit)), Math.abs(resid), 1);

  const yoyCell = (curV, baseV, name = null) => {
    const why = opt.baseMonths ? A.reason(comparisonRules,code,opt.months,opt.baseMonths,name) : '';
    const c = A.reportedYoY(curV,baseV,why);
    const yi = formatYoY(c.pct,c.delta,c.status,'百萬元',unit);
    return `<span class="${yi.cls}" title="${escapeHtml(c.reason)}">${yi.disp}</span>`;
  };

  const rows = [...agg.subs].sort((a, b) => b.profit - a.profit).map(s => {
    const v = convertUnit(s.profit, '百萬元', unit);
    const bRaw = baseSubs.has(s.name) ? baseSubs.get(s.name) : null;
    const b = bRaw != null ? convertUnit(bRaw, '百萬元', unit) : null;
    const w = (Math.abs(s.profit) / maxAbs * 100).toFixed(1);
    const color = s.profit >= 0 ? 'rgba(26,63,160,.55)' : 'rgba(163,49,42,.55)';
    return `<tr>
      <td style="min-width:90px">${escapeHtml(s.name)}</td>
      <td class="num ${s.profit >= 0 ? 'positive' : 'negative'}">${formatNum(v)}</td>
      <td class="detail-bar-cell"><div class="detail-bar" style="background:${color};width:${w}%"></div></td>
      <td class="num pd-base">${b != null ? formatNum(b) : '—'}</td>
      <td class="num">${yoyCell(s.profit, bRaw, s.name)}</td>
    </tr>`;
  }).join('');

  const residRow = `<tr class="pd-resid">
    <td>母公司及其他（軋差）</td>
    <td class="num">${formatNum(convertUnit(resid, '百萬元', unit))}</td>
    <td></td>
    <td class="num pd-base">${baseResid != null ? formatNum(convertUnit(baseResid, '百萬元', unit)) : '—'}</td>
    <td class="num">—</td>
  </tr>`;

  const hv = convertUnit(agg.profit, '百萬元', unit);
  const hb = baseAgg ? convertUnit(baseAgg.profit, '百萬元', unit) : null;
  content.innerHTML = `
    <table class="detail-table">
      <thead>
        <tr>
          <th class="th-left">子公司</th>
          <th>${opt.label} (${unit})</th>
          <th></th>
          <th>去年同期 (${unit})</th>
          <th>期間 YoY</th>
        </tr>
      </thead>
      <tbody>
        <tr class="detail-total">
          <td>${agg.name}（合併）</td>
          <td class="num">${formatNum(hv)}</td>
          <td></td>
          <td class="num">${hb != null ? formatNum(hb) : '—'}</td>
          <td class="num">${yoyCell(agg.profit, baseAgg ? baseAgg.profit : null)}</td>
        </tr>
        ${rows}
        ${residRow}
      </tbody>
    </table>
    <p class="detail-footnote">${PERIOD_FOOTNOTE}</p>
  `;
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── 模式切換 ──
const SORT_OPTIONS_BY_MODE = {
  trend: [
    ['trend_deviation', '偏離觀察基準最大'], ['trend_up', '月增加金額最多'],
    ['trend_down', '月減少金額最多'], ['trend_amount', '當月獲利最高'], ['code', '代號'],
  ],
  monthly: [
    ['code', '代號'],
    ['monthly_desc', '當月獲利 ↓'],
    ['monthly_asc', '當月獲利 ↑'],
    ['mom_desc', '當月 MoM ↓'],
    ['cumulative_desc', '累計獲利 ↓'],
    ['cumul_yoy_desc', '累計 YoY ↓'],
    ['eps_cumul_desc', '累計 EPS ↓'],
  ],
  period: [
    ['pprofit_desc', '期間獲利 ↓'],
    ['pprofit_asc', '期間獲利 ↑'],
    ['pyoy_desc', '期間 YoY ↓'],
    ['peps_desc', '期間 EPS ↓'],
    ['code', '代號'],
  ],
};
const _sortMemo = { trend: 'trend_deviation', monthly: 'code', period: 'pprofit_desc' };

function setSortOptionsForMode(mode) {
  const sel = document.getElementById('sort-select');
  if (!sel) return;
  const opts = SORT_OPTIONS_BY_MODE[mode] || SORT_OPTIONS_BY_MODE.monthly;
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const want = _sortMemo[mode];
  sel.value = opts.some(([v]) => v === want) ? want : opts[0][0];
}

function setPageMode(mode) {
  // 記住目前模式的排序選擇
  const sel = document.getElementById('sort-select');
  if (sel && sel.value) _sortMemo[state.pageMode] = sel.value;

  state.pageMode = ['trend', 'monthly', 'period'].includes(mode) ? mode : 'monthly';
  document.body.classList.toggle('pm-trend', state.pageMode === 'trend');
  document.body.classList.toggle('pm-period', state.pageMode === 'period');
  document.querySelectorAll('.mode-toggle .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.pm === state.pageMode);
  });
  const cp = document.getElementById('ctrl-period');
  if (cp) cp.classList.toggle('hidden', state.pageMode !== 'period');
  setSortOptionsForMode(state.pageMode);
  closeDetail();

  if (state.pageMode === 'period') {
    if (!state.periodOptions.length) { buildPeriodOptions(); renderPeriodSelector(); }
    onPeriodChange();
  } else {
    renderAll();
    resetTableScroll();
  }
}
