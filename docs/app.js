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
  barChart: null,
  cumulChart: null,
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

  const tbody  = document.getElementById('main-tbody');
  const header = document.getElementById('monthly-header');

  // 更新月份標頭
  const period = state.data.report_period || '';
  header.textContent = `當月 (${period})`;

  const companies = sortCompanies([...state.data.companies]);
  tbody.innerHTML = companies.map(renderRow).join('');
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

  // 累計 YoY（main.py 預先寫入 holding_company.cumulative_profit_yoy_pct）
  // 2887 台新新光金 2025-07-24 合併，115/07 之前無法算 YoY，顯示合併註記
  const yoy = h.cumulative_profit_yoy_pct;
  const period = state.data.report_period || '';
  let yoyClass = '';
  let yoyDisp;
  if (yoy != null) {
    yoyClass = yoy >= 0 ? 'positive' : 'negative';
    yoyDisp = `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%`;
  } else if (c.code === '2887' && period < '115/07') {
    yoyDisp = '<span class="yoy-note">2025/07 正式合併</span>';
  } else {
    yoyDisp = '—';
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
    }));
    const allMonthly = subEntries.map(s => s.monthly || 0);
    const maxAbs = Math.max(...allMonthly.map(Math.abs), 1);

    const rows = subEntries.map(s => {
      const mc = (s.monthly || 0) >= 0 ? 'positive' : 'negative';
      const cc = (s.cumul   || 0) >= 0 ? 'positive' : 'negative';
      const barPct = Math.abs((s.monthly || 0) / maxAbs * 100).toFixed(1);
      const barColor = (s.monthly || 0) >= 0 ? '#276749' : '#9b1c1c';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:5px 8px;min-width:90px">${s.name}</td>
        <td class="num ${mc}" style="padding:5px 8px;white-space:nowrap">${s.monthly != null ? formatNum(s.monthly) : '—'}</td>
        <td style="padding:5px 8px;width:120px;padding-left:8px">
          <div style="background:${barColor};height:10px;border-radius:3px;width:${barPct}%;min-width:2px;opacity:0.75"></div>
        </td>
        <td class="num ${cc}" style="padding:5px 8px;white-space:nowrap">${s.cumul != null ? formatNum(s.cumul) : '—'}</td>
      </tr>`;
    }).join('');

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
      </table>`;
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
  state.barChart   = renderBarChart('bar-chart', state.barChart, 'monthly_profit',
                                    `當月稅後淨利 (${unit})`, unit);
  state.cumulChart = renderBarChart('cumul-chart', state.cumulChart, 'cumulative_profit',
                                    `本年累計稅後淨利 (${unit})`, unit);
}

function renderBarChart(canvasId, prevChart, field, label, unit) {
  const companies = (state.data.companies || [])
    .filter(c => !c.error && c.holding_company?.[field] != null)
    .map(c => ({
      name: c.name,
      value: convertUnit(c.holding_company[field], c.unit, unit) || 0,
    }))
    .sort((a, b) => b.value - a.value);

  const labels = companies.map(c => c.name);
  const values = companies.map(c => c.value);
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
      return arr.sort((a, b) => {
        const av = a.holding_company?.cumulative_profit_yoy_pct ?? -Infinity;
        const bv = b.holding_company?.cumulative_profit_yoy_pct ?? -Infinity;
        return bv - av;
      });
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
