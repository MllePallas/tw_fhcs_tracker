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
  renderSummaryCards();
  renderTable();
  renderChart();
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
      <td colspan="2" class="center" style="color:#718096;font-size:12px">
        ${c.error_msg || '資料待更新'}
      </td>
      <td class="center"><span class="status-tag status-error">未取得</span></td>
      <td></td>
    </tr>`;
  }

  const h       = c.holding_company || {};
  const monthly = convertUnit(h.monthly_profit, h.unit, state.displayUnit);
  const cumul   = convertUnit(h.cumulative_profit, h.unit, state.displayUnit);

  const mClass  = monthly >= 0 ? 'positive' : 'negative';
  const cClass  = cumul   >= 0 ? 'positive' : 'negative';

  const mDisplay = monthly  != null ? formatNum(monthly)  : '—';
  const cDisplay = cumul    != null ? formatNum(cumul)     : '—';

  const sourceLink = c.source_url
    ? `<a class="source-link" href="${c.source_url}" target="_blank" rel="noopener">
         📄 ${c.announcement_date || '公告'}
       </a>`
    : '—';

  const hasSubs = (c.subsidiaries || []).length > 0;
  const nameCell = hasSubs
    ? `<a class="company-link" onclick="showDetail('${c.code}')">${c.name}</a>`
    : `<span>${c.name}</span>`;

  return `<tr>
    <td class="col-code">${c.code}</td>
    <td>${nameCell}</td>
    <td class="num ${mClass}">${mDisplay}</td>
    <td class="num ${cClass}">${cDisplay}</td>
    <td class="center"><span class="status-tag status-ok">✓ 已取得</span></td>
    <td class="center">${sourceLink}</td>
  </tr>`;
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
    const m = convertUnit(h.monthly_profit, h.unit, unit) || 0;
    const cu = convertUnit(h.cumulative_profit, h.unit, unit) || 0;
    totalMonthly += m;
    totalCumul   += cu;
    if (!top || m > convertUnit(top.holding_company.monthly_profit, top.holding_company.unit, unit)) {
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
      <div class="card-sub">${top ? formatNum(convertUnit(top.holding_company.monthly_profit, top.holding_company.unit, unit)) + ' ' + unit : ''}</div>
    </div>
  `;
}

// ── 子公司明細面板 ─────────────────────────────────────
function showDetail(code) {
  const c = state.data.companies.find(x => x.code === code);
  if (!c) return;

  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');

  title.textContent = `${c.name} (${c.code}) — 子公司明細`;

  const subs = c.subsidiaries || [];
  const unit = state.displayUnit;
  const h = c.holding_company || {};
  const hm  = convertUnit(h.monthly_profit,  c.unit, unit);
  const hcu = convertUnit(h.cumulative_profit, c.unit, unit);

  if (subs.length === 0) {
    content.innerHTML = '<p style="color:#718096">無子公司明細資料</p>';
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  // 計算各子公司當月值（用於 bar chart）
  const subEntries = subs.map(s => ({
    name: s.name,
    monthly: convertUnit(s.monthly_profit, c.unit, unit),
    cumul:   convertUnit(s.cumulative_profit, c.unit, unit),
  }));
  const allMonthly = subEntries.map(s => s.monthly || 0);
  const maxAbs = Math.max(...allMonthly.map(Math.abs), 1);

  // 表格列
  const rows = subEntries.map(s => {
    const mc = (s.monthly || 0) >= 0 ? 'positive' : 'negative';
    const cc = (s.cumul   || 0) >= 0 ? 'positive' : 'negative';
    const barPct = Math.abs((s.monthly || 0) / maxAbs * 100).toFixed(1);
    const barColor = (s.monthly || 0) >= 0 ? '#276749' : '#9b1c1c';
    return `<tr>
      <td style="min-width:90px">${s.name}</td>
      <td class="num ${mc}" style="white-space:nowrap">${s.monthly != null ? formatNum(s.monthly) : '—'}</td>
      <td style="width:120px;padding-left:8px">
        <div style="background:${barColor};height:10px;border-radius:3px;width:${barPct}%;min-width:2px;opacity:0.75"></div>
      </td>
      <td class="num ${cc}" style="white-space:nowrap">${s.cumul != null ? formatNum(s.cumul) : '—'}</td>
    </tr>`;
  }).join('');

  content.innerHTML = `
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
        ${rows.replace(/<tr>/g, '<tr style="border-bottom:1px solid #f0f0f0">').replace(/<td/g, '<td style="padding:5px 8px"').replace(/style="padding:5px 8px" style=/g, 'style=')}
      </tbody>
    </table>
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
  const companies = (state.data.companies || [])
    .filter(c => !c.error && c.holding_company?.monthly_profit != null)
    .sort((a, b) => {
      const av = convertUnit(a.holding_company.monthly_profit, a.holding_company.unit, unit) || 0;
      const bv = convertUnit(b.holding_company.monthly_profit, b.holding_company.unit, unit) || 0;
      return bv - av;
    });

  const labels = companies.map(c => c.name);
  const values = companies.map(c =>
    convertUnit(c.holding_company.monthly_profit, c.holding_company.unit, unit) || 0
  );
  const colors = values.map(v => v >= 0 ? 'rgba(5,122,85,.75)' : 'rgba(155,28,28,.75)');

  if (state.barChart) state.barChart.destroy();

  const ctx = document.getElementById('bar-chart').getContext('2d');
  state.barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `當月稅後淨利 (${unit})`,
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

// ── 觸發更新 Modal ─────────────────────────────────────
function triggerUpdate() {
  document.getElementById('trigger-modal').classList.remove('hidden');
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('trigger-modal').classList.add('hidden');
  document.getElementById('modal-overlay').classList.add('hidden');
}

async function confirmTrigger() {
  const token = document.getElementById('gh-token').value.trim();
  const user  = document.getElementById('gh-user').value.trim();
  const repo  = document.getElementById('gh-repo').value.trim();
  const month = document.getElementById('gh-month').value.trim();

  if (!token || !user || !repo) {
    alert('請填寫 Token、使用者名稱和 Repository 名稱');
    return;
  }

  closeModal();
  showStatus('info', '<span class="spinner"></span> 正在觸發 GitHub Actions，請稍待...');

  const body = {
    ref: 'main',
    inputs: {}
  };
  if (month) body.inputs.target_month = month;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${user}/${repo}/actions/workflows/update_data.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(body),
      }
    );

    if (resp.status === 204) {
      showStatus('success',
        '✅ 已成功觸發！GitHub Actions 正在執行爬蟲，約 3-5 分鐘後資料將更新。' +
        `<a href="https://github.com/${user}/${repo}/actions" target="_blank" ` +
        `style="margin-left:8px;color:inherit;text-decoration:underline">查看進度 →</a>`
      );
      // 5 分鐘後自動重新載入資料
      setTimeout(loadData, 5 * 60 * 1000);
    } else {
      const err = await resp.json().catch(() => ({}));
      showStatus('error', `❌ 觸發失敗 (HTTP ${resp.status})：${err.message || '請確認 Token 和 Repo 設定'}`);
    }
  } catch (e) {
    showStatus('error', `❌ 請求失敗：${e.message}`);
  }
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
        const av = a.holding_company ? convertUnit(a.holding_company.monthly_profit, a.holding_company.unit, unit) || 0 : -Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.monthly_profit, b.holding_company.unit, unit) || 0 : -Infinity;
        return bv - av;
      });
    case 'monthly_asc':
      return arr.sort((a, b) => {
        const av = a.holding_company ? convertUnit(a.holding_company.monthly_profit, a.holding_company.unit, unit) || 0 : Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.monthly_profit, b.holding_company.unit, unit) || 0 : Infinity;
        return av - bv;
      });
    case 'cumulative_desc':
      return arr.sort((a, b) => {
        const av = a.holding_company ? convertUnit(a.holding_company.cumulative_profit, a.holding_company.unit, unit) || 0 : -Infinity;
        const bv = b.holding_company ? convertUnit(b.holding_company.cumulative_profit, b.holding_company.unit, unit) || 0 : -Infinity;
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
