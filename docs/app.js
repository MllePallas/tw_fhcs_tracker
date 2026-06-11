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
  index: null,
  displayUnit: '百萬元',
  sortMode: 'code',
  viewMode: 'holdings',  // 'holdings' | 'bank' | 'life' | 'securities'
  barChart: null,
  cumulChart: null,
};

// ── 視角切換 ───────────────────────────────────────────
function setView(mode) {
  state.viewMode = mode;
  document.querySelectorAll('.industry-tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  renderAll();
}

// 產業分類（依子公司名稱判斷）
function classifyIndustry(name) {
  if (!name) return null;
  if (name.includes('銀行')) return 'bank';
  if (name.includes('人壽')) return 'life';
  if (name.includes('證券')) return 'securities';
  return null;
}

// YoY 顯示：跨零點（虧轉盈/盈轉虧）用文字標籤＋絕對差額；同號用百分比
// abs 在 JSON 中與 cumul 同單位（百萬元），顯示時跟著 displayUnit 換算
function formatYoY(pct, abs, status, sourceUnit, displayUnit) {
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

// FVOCI 調整後獲利顯示。多數金控（富邦、凱基）揭露具體數字 → 顯示數字 + YoY。
// 少數（國泰）僅揭露區間/門檻 → value_type==='lower_bound'，以「逾 X」表示下界、不顯示 YoY
// （門檻值與去年精確值相除會得出假精度的百分比，語意誤導，故省略）。
function fvociDisplay(a, sourceUnit, displayUnit) {
  const v = convertUnit(a.cumulative_profit, sourceUnit, displayUnit);
  if (a.value_type === 'lower_bound') {
    const prefix = a.display_prefix || '逾';
    return { cumulDisp: `${prefix} ${formatNum(v)}`, yoyDisp: '—', isBound: true };
  }
  const yoyDisp = formatYoY(a.yoy_pct, a.yoy_abs, a.yoy_status, sourceUnit, displayUnit).disp;
  return { cumulDisp: formatNum(v), yoyDisp, isBound: false };
}

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

// 取出某產業的所有子公司列（含父金控資訊）
function getIndustryRows(industry) {
  const rows = [];
  for (const c of state.data.companies || []) {
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
  loadIndex();
});

// ── 月份索引載入 ────────────────────────────────────────
async function loadIndex() {
  try {
    const resp = await fetch(CONFIG.indexUrl + '?_=' + Date.now());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.index = await resp.json();
    renderMonthSelector(state.index.months);
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
    const label = m.period.replace('/', '年') + '月';
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
async function loadData(period) {
  const url = period
    ? `./data/${period.replace('/', '-')}.json?_=${Date.now()}`
    : CONFIG.latestUrl + '?_=' + Date.now();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.data = await resp.json();
    renderAll();
  } catch (e) {
    showStatus('error', `⚠️ 無法載入資料：${e.message}`);
    document.getElementById('main-tbody').innerHTML =
      `<tr><td colspan="6" class="loading-cell" style="color:#e53e3e">資料載入失敗</td></tr>`;
    document.getElementById('mobile-cards').innerHTML =
      `<div class="m-empty" style="color:#e53e3e">資料載入失敗</div>`;
  }
}

// ── 主渲染 ─────────────────────────────────────────────
function renderAll() {
  if (!state.data) return;
  state.displayUnit = document.getElementById('unit-select').value;
  state.sortMode    = document.getElementById('sort-select').value;

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
  const period = (m.period || state.data.report_period || '').replace('/', '年') + '月底';
  const ts = m.generated_at ? new Date(m.generated_at).toLocaleDateString('zh-TW') : '';
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
      label: '台股日均成交額',
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

function renderTable() {
  if (!state.data) return;
  state.displayUnit = document.getElementById('unit-select').value;
  state.sortMode    = document.getElementById('sort-select').value;

  if (state.viewMode === 'holdings') {
    renderHoldingsTable();
    renderHoldingsCards();
  } else {
    renderIndustryTable(state.viewMode);
    renderIndustryCards(state.viewMode);
  }
}

// 13 家金控總覽（原本的表格）
function renderHoldingsTable() {
  const period = state.data.report_period || '';
  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th rowspan="2" class="col-code">代號</th>
      <th rowspan="2" class="col-name">金控</th>
      <th colspan="3" class="col-group">合併稅後淨利</th>
      <th colspan="2" class="col-group">稅後 EPS (元)</th>
      <th rowspan="2" class="col-status">狀態</th>
      <th rowspan="2" class="col-source">來源</th>
    </tr>
    <tr>
      <th class="col-monthly">當月 (${period})</th>
      <th class="col-cumulative">累計</th>
      <th class="col-cumulative">累計 YoY</th>
      <th class="col-monthly">當月</th>
      <th class="col-cumulative">累計</th>
    </tr>`;
  const companies = sortCompanies([...state.data.companies]);
  document.getElementById('main-tbody').innerHTML = companies.map(renderRow).join('');
  const tfoot = document.getElementById('main-tfoot');
  if (tfoot) tfoot.innerHTML = '';
}

// 產業視角（銀行 / 壽險 / 證券）
function renderIndustryTable(industry) {
  const period = state.data.report_period || '';
  const rows = sortIndustryRows(getIndustryRows(industry));
  document.getElementById('main-thead').innerHTML = `
    <tr>
      <th class="col-code">集團</th>
      <th class="col-name">${VIEW_TITLES[industry]}子公司</th>
      <th class="col-monthly">當月 (${period})</th>
      <th class="col-cumulative">累計</th>
      <th class="col-cumulative">累計 YoY</th>
    </tr>`;

  if (rows.length === 0) {
    document.getElementById('main-tbody').innerHTML =
      `<tr><td colspan="5" class="loading-cell" style="color:#718096">此期間無${VIEW_TITLES[industry]}資料</td></tr>`;
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
    if (yi.disp === '—' && r.parent_code === '2887' && period < '115/07') {
      yoyDisp = '<span class="yoy-note">2025/07 正式合併</span>';
    }

    const main = `<tr>
      <td><a class="company-link" onclick="showDetail('${r.parent_code}')">${r.parent_name}</a></td>
      <td style="font-weight:600">${r.name}</td>
      <td class="num ${mClass}">${m != null ? formatNum(m) : '—'}</td>
      <td class="num ${cClass}">${c != null ? formatNum(c) : '—'}</td>
      <td class="num ${yoyClass}">${yoyDisp}</td>
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
      const numStyle = 'color:#5568b8;font-size:12px;font-style:italic';
      adj = `<tr class="fvoci-row" style="background:#fafaff">
        <td></td>
        <td style="padding-left:20px;color:#5568b8;font-size:12px"${tip}>（加上FVOCI股票處份利益）<sup>*</sup></td>
        <td></td>
        <td class="num" style="${numStyle}">${fd.cumulDisp}</td>
        <td class="num" style="${numStyle}">${fd.yoyDisp}</td>
      </tr>`;
    }

    return main + adj;
  }).join('');

  // 壽險表格底部加註腳（只有實際出現 FVOCI 列時才顯示）
  const tfoot = document.getElementById('main-tfoot');
  if (tfoot) {
    if (industry === 'life' && hasFvoci) {
      tfoot.innerHTML = `<tr><td colspan="5" style="padding:8px 12px;font-size:11px;color:#718096;border-top:1px solid #edf2f7">
        <sup>*</sup> 加上FVOCI股票處份利益後的調整後累計獲利，依各壽險公司新聞稿揭露數字；僅供與去年同期比較之參考。部分公司（如國泰人壽）僅揭露區間，以「逾」標示下界且不計 YoY。
      </td></tr>`;
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
      <td colspan="5" class="center" style="color:#718096;font-size:12px">
        ${c.error_msg || '資料待更新'}
      </td>
      <td class="center"><span class="status-tag status-error">未取得</span></td>
      <td></td>
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
  // 2887 台新新光金 2025-07-24 合併，115/07 之前無法算 YoY，顯示合併註記
  const period = state.data.report_period || '';
  const unit = state.displayUnit;
  const yi = formatYoY(h.cumulative_profit_yoy_pct, h.cumulative_profit_yoy_abs, h.cumulative_profit_yoy_status, c.unit, unit);
  let yoyClass = yi.cls;
  let yoyDisp = yi.disp;
  if (yi.disp === '—' && c.code === '2887' && period < '115/07') {
    yoyDisp = '<span class="yoy-note">2025/07 正式合併</span>';
  }

  // EPS：當月 EPS 公告通常沒列，可用 月損益/累計損益 × 累計EPS 推算
  const epsM = h.monthly_eps != null
    ? h.monthly_eps
    : (h.monthly_profit != null && h.cumulative_profit && h.cumulative_eps != null
        ? h.monthly_profit / h.cumulative_profit * h.cumulative_eps
        : null);
  const epsC = h.cumulative_eps;
  const epsMClass = (epsM ?? 0) >= 0 ? 'positive' : 'negative';
  const epsCClass = (epsC ?? 0) >= 0 ? 'positive' : 'negative';
  const epsMDisp = epsM != null ? formatEps(epsM) : '—';
  const epsCDisp = epsC != null ? formatEps(epsC) : '—';

  const sourceLink = c.source_url
    ? `<a class="source-link" href="${c.source_url}" target="_blank" rel="noopener">
         📄 ${c.announcement_date || '公告'}
       </a>`
    : '—';

  const nameCell = `<a class="company-link" onclick="showDetail('${c.code}')">${c.name}</a>`;

  return `<tr>
    <td class="col-code">${c.code}</td>
    <td>${nameCell}</td>
    <td class="num ${mClass}">${mDisplay}</td>
    <td class="num ${cClass}">${cDisplay}</td>
    <td class="num ${yoyClass}">${yoyDisp}</td>
    <td class="num ${epsMClass}">${epsMDisp}</td>
    <td class="num ${epsCClass}">${epsCDisp}</td>
    <td class="center"><span class="status-tag status-ok">✓ 已取得</span></td>
    <td class="center">${sourceLink}</td>
  </tr>`;
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
  document.getElementById('mobile-cards').innerHTML =
    companies.map(renderHoldingCard).join('');
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
  if (yi.disp === '—' && c.code === '2887' && period < '115/07') {
    yoyDisp = '合併前';
  }

  const epsC = h.cumulative_eps;
  const epsCDisp = epsC != null ? formatEps(epsC) : '—';
  const epsCClass = (epsC ?? 0) >= 0 ? 'positive' : 'negative';

  const mClass = (monthly ?? 0) >= 0 ? 'positive' : 'negative';
  const cClass = (cumul   ?? 0) >= 0 ? 'positive' : 'negative';

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
        <div class="m-cell-label">當月 (${period})</div>
        <div class="m-cell-value ${mClass}">${monthly != null ? formatNum(monthly) : '—'}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 YTD</div>
        <div class="m-cell-value ${cClass}">${cumul != null ? formatNum(cumul) : '—'}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 YoY</div>
        <div class="m-cell-value ${yoyClass}">${yoyDisp}</div>
      </div>
      <div class="m-cell">
        <div class="m-cell-label">累計 EPS</div>
        <div class="m-cell-value ${epsCClass}">${epsCDisp}</div>
      </div>
    </div>
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
    if (yi.disp === '—' && r.parent_code === '2887' && period < '115/07') {
      yoyDisp = '合併前';
    }

    // 壽險專屬：僅在有揭露 FVOCI 影響數時顯示（淡藍色弱化，不干擾主排序）
    let adjBlock = '';
    const a = r.fvoci_adjusted;
    if (industry === 'life' && a && a.cumulative_profit != null) {
      const fd = fvociDisplay(a, r.unit, unit);
      const yoyPart = fd.isBound ? '' : `<div>YoY：${fd.yoyDisp}</div>`;
      adjBlock = `
      <div class="m-fvoci" style="margin-top:6px;padding-top:6px;border-top:1px dashed #d6d9e2;font-size:12px;color:#5568b8;font-style:italic">
        <div style="margin-bottom:4px;font-style:normal">（加上FVOCI股票處份利益）<sup>*</sup></div>
        <div style="display:flex;gap:14px">
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
          <div class="m-cell-label">當月 (${period})</div>
          <div class="m-cell-value ${mClass}">${m != null ? formatNum(m) : '—'}</div>
        </div>
        <div class="m-cell">
          <div class="m-cell-label">累計 YTD</div>
          <div class="m-cell-value ${cClass}">${cu != null ? formatNum(cu) : '—'}</div>
        </div>
        <div class="m-cell">
          <div class="m-cell-label">累計 YoY</div>
          <div class="m-cell-value ${yoyClass}">${yoyDisp}</div>
        </div>
      </div>
      ${adjBlock}
    </div>`;
  }).join('');

  // 壽險手機卡片底部加註腳（只有實際出現 FVOCI 區塊時才加）
  if (industry === 'life' && rows.some(r => r.fvoci_adjusted && r.fvoci_adjusted.cumulative_profit != null)) {
    el.insertAdjacentHTML('beforeend', `
      <div style="font-size:11px;color:#718096;padding:8px 4px">
        <sup>*</sup> 加上FVOCI股票處份利益後的調整後累計獲利，依金控新聞稿揭露之金控層級調整數推算（差額假設全數來自壽險子公司，僅供與去年同期比較之參考）。
      </div>
    `);
  }
}

// ── 摘要卡片 ───────────────────────────────────────────
function renderSummaryCards() {
  const d = state.data;
  const unit = state.displayUnit;
  const companies = d.companies.filter(c => !c.error && c.holding_company);

  // 合計當月獲利
  let totalMonthly = 0;
  let totalCumul   = 0;
  let top = null;

  for (const c of companies) {
    const h = c.holding_company;
    const m = convertUnit(h.monthly_profit, c.unit, unit) || 0;
    const cu = convertUnit(h.cumulative_profit, c.unit, unit) || 0;
    totalMonthly += m;
    totalCumul   += cu;
    if (!top || m > convertUnit(top.holding_company.monthly_profit, top.unit, unit)) {
      top = c;
    }
  }

  const mClass = totalMonthly >= 0 ? 'positive' : 'negative';
  const cClass = totalCumul   >= 0 ? 'positive' : 'negative';

  document.getElementById('summary-cards').innerHTML = `
    <div class="card">
      <div class="card-label">已取得資料</div>
      <div class="card-value">${companies.length} <span style="font-size:14px;font-weight:400">/ 13 家</span></div>
      <div class="card-sub">成功率 ${Math.round(companies.length/13*100)}%</div>
    </div>
    <div class="card">
      <div class="card-label">13 家合計當月獲利</div>
      <div class="card-value ${mClass}">${formatNum(totalMonthly)}</div>
      <div class="card-sub">${unit} ｜ ${d.report_period}</div>
    </div>
    <div class="card">
      <div class="card-label">13 家合計累計獲利</div>
      <div class="card-value ${cClass}">${formatNum(totalCumul)}</div>
      <div class="card-sub">${unit} ｜ 本年累計</div>
    </div>
    <div class="card">
      <div class="card-label">當月獲利第一</div>
      <div class="card-value" style="font-size:18px">${top ? top.name : '—'}</div>
      <div class="card-sub">${top ? formatNum(convertUnit(top.holding_company.monthly_profit, top.unit, unit)) + ' ' + unit : ''}</div>
    </div>
  `;
}

// ── 簡易 markdown 渲染（**bold**、## 標題、段落） ────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(md);
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
    const ts = c.news_generated_at
      ? new Date(c.news_generated_at).toLocaleDateString('zh-TW')
      : '';
    newsHtml = `
      <div class="news-summary">
        <div class="news-summary-header">
          <span>📰 媒體新聞摘要</span>
          ${ts ? `<span class="news-summary-time">${ts} 生成</span>` : ''}
        </div>
        <div class="news-summary-body">${renderMarkdown(c.news_summary)}</div>
        ${sourcesHtml}
      </div>`;
  }

  // ── 子公司表格區塊 ──
  let tableHtml = '';
  if (subs.length === 0) {
    tableHtml = '<p style="color:#718096">無子公司明細資料</p>';
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
      const barColor = (s.monthly || 0) >= 0 ? '#276749' : '#9b1c1c';
      const main = `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:5px 8px;min-width:90px">${s.name}</td>
        <td class="num ${mc}" style="padding:5px 8px;white-space:nowrap">${s.monthly != null ? formatNum(s.monthly) : '—'}</td>
        <td style="padding:5px 8px;width:120px;padding-left:8px">
          <div style="background:${barColor};height:10px;border-radius:3px;width:${barPct}%;min-width:2px;opacity:0.75"></div>
        </td>
        <td class="num ${cc}" style="padding:5px 8px;white-space:nowrap">${s.cumul != null ? formatNum(s.cumul) : '—'}</td>
      </tr>`;

      // 僅在壽險子公司且有揭露 FVOCI 影響數時加一行（淡藍色弱化）
      if (!s.isLife || !s.fvoci || s.fvoci.cumulative_profit == null) return main;
      hasFvoci = true;
      const fd = fvociDisplay(s.fvoci, c.unit, unit);
      const tip = s.fvoci.source_quote
        ? ` title="${escapeHtml(s.fvoci.source_quote)}"`
        : '';
      const adj = `<tr style="border-bottom:1px solid #f0f0f0;background:#fafaff">
        <td style="padding:4px 8px;padding-left:18px;color:#5568b8;font-size:12px"${tip}>（加上FVOCI股票處份利益）<sup>*</sup></td>
        <td></td>
        <td></td>
        <td class="num" style="padding:4px 8px;white-space:nowrap;color:#5568b8;font-size:12px;font-style:italic">${fd.cumulDisp}</td>
      </tr>`;
      return main + adj;
    }).join('');

    const fvociFootnote = hasFvoci
      ? `<p style="font-size:11px;color:#718096;margin-top:6px">
           <sup>*</sup> 依各壽險公司新聞稿揭露之加計 FVOCI 處份利益後調整後獲利；僅供與去年同期比較之參考。部分公司（如國泰人壽）僅揭露區間，以「逾」標示下界且不計 YoY。
         </p>`
      : '';

    tableHtml = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:1px solid #e2e8f0">
            <th style="text-align:left;padding:4px 8px;font-weight:600;color:#4a5568">子公司</th>
            <th style="text-align:right;padding:4px 8px;font-weight:600;color:#4a5568">當月 (${unit})</th>
            <th style="padding:4px 8px"></th>
            <th style="text-align:right;padding:4px 8px;font-weight:600;color:#4a5568">累計 (${unit})</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#ebf8ff;font-weight:700;border-bottom:2px solid #bee3f8">
            <td style="padding:5px 8px">${c.name}（合併）</td>
            <td class="num ${hm>=0?'positive':'negative'}" style="text-align:right;padding:5px 8px">
              ${hm!=null?formatNum(hm):'—'}
            </td>
            <td></td>
            <td class="num ${hcu>=0?'positive':'negative'}" style="text-align:right;padding:5px 8px">
              ${hcu!=null?formatNum(hcu):'—'}
            </td>
          </tr>
          ${rows}
        </tbody>
      </table>${fvociFootnote}`;
  }

  content.innerHTML = `
    ${newsHtml}
    ${tableHtml}
    <p style="font-size:11px;color:#718096;margin-top:8px">
      公告日期：${c.announcement_date || '—'} ｜ 來源：<a href="${c.source_url||'#'}" target="_blank" style="color:#3182ce">MOPS ↗</a>
    </p>
  `;

  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
}

// ── 長條圖 ─────────────────────────────────────────────
function renderChart() {
  const unit = state.displayUnit;

  // 依視角產生資料
  let monthlyRows, cumulRows, scopeLabel;
  if (state.viewMode === 'holdings') {
    monthlyRows = (state.data.companies || [])
      .filter(c => !c.error && c.holding_company?.monthly_profit != null)
      .map(c => ({ name: c.name, value: convertUnit(c.holding_company.monthly_profit, c.unit, unit) || 0 }));
    cumulRows = (state.data.companies || [])
      .filter(c => !c.error && c.holding_company?.cumulative_profit != null)
      .map(c => ({ name: c.name, value: convertUnit(c.holding_company.cumulative_profit, c.unit, unit) || 0 }));
    scopeLabel = '金控';
  } else {
    const rows = getIndustryRows(state.viewMode);
    monthlyRows = rows
      .filter(r => r.monthly_profit != null)
      .map(r => ({ name: r.name, value: convertUnit(r.monthly_profit, r.unit, unit) || 0 }));
    cumulRows = rows
      .filter(r => r.cumulative_profit != null)
      .map(r => ({ name: r.name, value: convertUnit(r.cumulative_profit, r.unit, unit) || 0 }));
    scopeLabel = VIEW_TITLES[state.viewMode];
  }

  // 圖表標題同步
  document.getElementById('bar-chart-title').textContent   = `📈 ${scopeLabel}當月獲利比較`;
  document.getElementById('cumul-chart-title').textContent = `📊 ${scopeLabel}累計獲利比較（本年累計）`;

  state.barChart   = renderBarChart('bar-chart',   state.barChart,   monthlyRows, `當月稅後淨利 (${unit})`, unit);
  state.cumulChart = renderBarChart('cumul-chart', state.cumulChart, cumulRows,   `本年累計稅後淨利 (${unit})`, unit);
}

function renderBarChart(canvasId, prevChart, rows, label, unit) {
  rows = [...rows].sort((a, b) => b.value - a.value);
  const labels = rows.map(r => r.name);
  const values = rows.map(r => r.value);
  const colors = values.map(v => v >= 0 ? 'rgba(5,122,85,.75)' : 'rgba(155,28,28,.75)');

  if (prevChart) prevChart.destroy();

  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatNum(ctx.raw)} ${unit}`
          }
        }
      },
      scales: {
        y: {
          ticks: {
            callback: v => formatNum(v)
          }
        }
      }
    }
  });
}

// ── 輔助函數 ───────────────────────────────────────────
function updatePeriodBadge() {
  const p = state.data?.report_period || '—';
  document.getElementById('period-badge').textContent = `📅 ${p} 月報`;
}

function updateLastUpdated() {
  const ts = state.data?.last_updated;
  if (!ts) return;
  const d = new Date(ts);
  document.getElementById('last-updated').textContent =
    `最後更新：${d.toLocaleString('zh-TW')}`;
}

function showStatus(type, msg) {
  const bar = document.getElementById('status-bar');
  bar.className = `status-bar ${type}`;
  bar.innerHTML = msg;
  bar.classList.remove('hidden');
}

function sortCompanies(arr) {
  const unit = state.displayUnit;
  switch (state.sortMode) {
    case 'monthly_desc':
      return arr.sort((a, b) => {
        const av = a.holding_company ? convertUnit(a.holding_company.monthly_profit, a.unit, unit) || 0 : -Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.monthly_profit, b.unit, unit) || 0 : -Infinity;
        return bv - av;
      });
    case 'monthly_asc':
      return arr.sort((a, b) => {
        const av = a.holding_company ? convertUnit(a.holding_company.monthly_profit, a.unit, unit) || 0 : Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.monthly_profit, b.unit, unit) || 0 : Infinity;
        return av - bv;
      });
    case 'cumulative_desc':
      return arr.sort((a, b) => {
        const av = a.holding_company ? convertUnit(a.holding_company.cumulative_profit, a.unit, unit) || 0 : -Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.cumulative_profit, b.unit, unit) || 0 : -Infinity;
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

// ── Excel 下載 ─────────────────────────────────────────
// 動態載入 SheetJS（首次點擊才載入，避免初始 bundle 膨脹）
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
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

async function downloadExcel() {
  if (!state.data) {
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

    // ── Sheet 1: 金控總覽 ──
    const holdHeader = ['代號', '金控', `當月獲利 (${unit})`, `累計獲利 (${unit})`, '累計 YoY (%)', '當月 EPS (元)', '累計 EPS (元)', '公告日期', '資料來源 URL'];
    const holdRows = [holdHeader];
    for (const c of d.companies || []) {
      if (c.error) {
        holdRows.push([c.code, c.name, null, null, null, null, null, c.announcement_date || '', c.error_msg || '資料未取得']);
        continue;
      }
      const h = c.holding_company || {};
      const m = convertUnit(h.monthly_profit, c.unit, unit);
      const cu = convertUnit(h.cumulative_profit, c.unit, unit);
      const epsM = h.monthly_eps != null
        ? h.monthly_eps
        : (h.monthly_profit != null && h.cumulative_profit && h.cumulative_eps != null
            ? h.monthly_profit / h.cumulative_profit * h.cumulative_eps
            : null);
      holdRows.push([
        c.code, c.name,
        m, cu, h.cumulative_profit_yoy_pct ?? null,
        epsM, h.cumulative_eps ?? null,
        c.announcement_date || '', c.source_url || '',
      ]);
    }
    const wsHold = XLSX.utils.aoa_to_sheet(holdRows);
    wsHold['!cols'] = [{wch:8},{wch:14},{wch:16},{wch:16},{wch:14},{wch:14},{wch:14},{wch:14},{wch:60}];
    wsHold['!freeze'] = { ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, wsHold, '金控總覽');

    // ── Sheet 2-4: 產業子公司 ──
    const industryConfigs = [
      { key: 'bank',       sheetName: '銀行子公司',  hasFvoci: false },
      { key: 'life',       sheetName: '壽險子公司',  hasFvoci: true  },
      { key: 'securities', sheetName: '證券子公司',  hasFvoci: false },
    ];
    for (const cfg of industryConfigs) {
      const rows = getIndustryRows(cfg.key);
      const header = ['集團代號', '集團', '子公司', `當月獲利 (${unit})`, `累計獲利 (${unit})`, '累計 YoY (%)'];
      if (cfg.hasFvoci) {
        header.push(`加計 FVOCI 累計獲利 (${unit})`, '加計 FVOCI YoY (%)', 'FVOCI 引用原文', 'FVOCI 來源 URL');
      }
      const sheetData = [header];
      for (const r of rows) {
        const m = convertUnit(r.monthly_profit, r.unit, unit);
        const cu = convertUnit(r.cumulative_profit, r.unit, unit);
        const row = [r.parent_code, r.parent_name, r.name, m, cu, r.cumulative_profit_yoy_pct ?? null];
        if (cfg.hasFvoci) {
          const a = r.fvoci_adjusted;
          if (a && a.cumulative_profit != null) {
            const v = convertUnit(a.cumulative_profit, r.unit, unit);
            // 區間/門檻型（國泰）：以「逾 X」字串表示下界、YoY 留空
            const cumulCell = a.value_type === 'lower_bound'
              ? `${a.display_prefix || '逾'} ${formatNum(v)}`
              : v;
            row.push(
              cumulCell,
              a.value_type === 'lower_bound' ? null : (a.yoy_pct ?? null),
              a.source_quote || '',
              a.source_url || '',
            );
          } else {
            row.push(null, null, '', '');
          }
        }
        sheetData.push(row);
      }
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws['!cols'] = cfg.hasFvoci
        ? [{wch:10},{wch:14},{wch:18},{wch:16},{wch:16},{wch:14},{wch:20},{wch:18},{wch:60},{wch:50}]
        : [{wch:10},{wch:14},{wch:18},{wch:16},{wch:16},{wch:14}];
      ws['!freeze'] = { ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);
    }

    // ── Sheet 5: 其他子公司（產險、投信、票券、創投…） ──
    const otherRows = getOtherSubsidiaryRows();
    if (otherRows.length > 0) {
      const otherData = [['集團代號', '集團', '子公司', `當月獲利 (${unit})`, `累計獲利 (${unit})`, '累計 YoY (%)']];
      for (const r of otherRows) {
        otherData.push([
          r.parent_code, r.parent_name, r.name,
          convertUnit(r.monthly_profit, r.unit, unit),
          convertUnit(r.cumulative_profit, r.unit, unit),
          r.cumulative_profit_yoy_pct ?? null,
        ]);
      }
      const wsOther = XLSX.utils.aoa_to_sheet(otherData);
      wsOther['!cols'] = [{wch:10},{wch:14},{wch:20},{wch:16},{wch:16},{wch:14}];
      wsOther['!freeze'] = { ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, wsOther, '其他子公司');
    }

    // ── Sheet 6: 市場概況 ──
    const ms = d.market_summary;
    if (ms && ms.items) {
      const it = ms.items;
      const mkt = [['指標', '本月底', '上月底', '變動', '備註']];
      const fmtPct = v => v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      const fmtBps = v => v == null ? null : `${v >= 0 ? '+' : ''}${v} bps`;
      if (it.usdtwd)         mkt.push(['美元兌台幣',          it.usdtwd.value, it.usdtwd.prev_value, fmtPct(it.usdtwd.pct_change), `TWD｜${it.usdtwd.date || ''} vs ${it.usdtwd.prev_date || ''}`]);
      if (it.taiex)          mkt.push(['加權指數',            it.taiex.value, it.taiex.prev_value, fmtPct(it.taiex.pct_change), `點｜${it.taiex.date || ''} vs ${it.taiex.prev_date || ''}`]);
      if (it.taiex_turnover) mkt.push(['台股日均成交額',      it.taiex_turnover.value_yi, it.taiex_turnover.prev_value_yi, fmtPct(it.taiex_turnover.pct_change), `億元 / 日均（本月 ${it.taiex_turnover.trading_days || '?'} 日 / 上月 ${it.taiex_turnover.prev_trading_days || '?'} 日）`]);
      if (it.spx)            mkt.push(['美股 S&P 500',        it.spx.value, it.spx.prev_value, fmtPct(it.spx.pct_change), `${it.spx.date || ''} vs ${it.spx.prev_date || ''}`]);
      if (it.us10y)          mkt.push(['美國 10Y 公債殖利率', it.us10y.value_pct, it.us10y.prev_value_pct, fmtBps(it.us10y.bps_change), `%（變動以 bps 表示）`]);
      const wsMkt = XLSX.utils.aoa_to_sheet(mkt);
      wsMkt['!cols'] = [{wch:24},{wch:14},{wch:14},{wch:14},{wch:60}];
      wsMkt['!freeze'] = { ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, wsMkt, '市場概況');
    }

    // ── Sheet 7: 新聞摘要 ──
    const newsData = [['代號', '金控', '新聞摘要', '來源 URL', '生成時間']];
    for (const c of d.companies || []) {
      if (!c.news_summary) continue;
      const sources = (c.news_sources || []).map(s => s.url).filter(Boolean).join('\n');
      const ts = c.news_generated_at ? new Date(c.news_generated_at).toLocaleString('zh-TW') : '';
      newsData.push([c.code, c.name, c.news_summary, sources, ts]);
    }
    if (newsData.length > 1) {
      const wsNews = XLSX.utils.aoa_to_sheet(newsData);
      wsNews['!cols'] = [{wch:8},{wch:14},{wch:90},{wch:50},{wch:22}];
      wsNews['!freeze'] = { ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, wsNews, '新聞摘要');
    }

    // ── 寫入並下載 ──
    const filename = `taiwan-fhcs-${period.replace('/', '-') || 'data'}.xlsx`;
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
  if (n == null) return '—';
  const abs = Math.abs(n);
  let formatted;
  if (abs >= 1000) {
    // 大數字：整數 + 千分位，例如 7,577
    formatted = n.toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } else if (abs >= 10) {
    // 中型數字：一位小數，例如 205.0
    formatted = n.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  } else if (abs >= 0.1) {
    // 小數字：兩位小數，例如 0.40
    formatted = n.toFixed(2);
  } else {
    formatted = n.toFixed(3);
  }
  return formatted;
}
