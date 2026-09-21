// report.js — 月獲利分析報告頁
//
// 報告內容以 Markdown（或純文字）存放於 docs/reports/，由 docs/reports/index.json 索引。
// 新增一份報告只要兩步：把檔案放進 reports/、在 index.json 加一筆 → 月報首頁自動出現連結。
// 本頁不含任何數字邏輯，純粹把 Markdown 以站內風格渲染出來。

'use strict';

const REPORTS_INDEX = './reports/index.json';

// ── 民國年 ↔ 西元年（與 app.js 同規則：資料存民國年、顯示西元年） ──
function adYear(rocYear) { return parseInt(rocYear, 10) + 1911; }
function periodLabel(period) {
  const m = String(period || '').match(/^(\d{2,3})[\/-](\d{1,2})$/);
  return m ? `${adYear(m[1])}年${parseInt(m[2], 10)}月` : (period || '');
}
function periodAd(period) {
  const m = String(period || '').match(/^(\d{2,3})[\/-](\d{1,2})$/);
  return m ? `${adYear(m[1])}/${m[2].padStart(2, '0')}` : (period || '');
}
// 網址參數用 115-06，資料內部用 115/06
function normalizePeriod(p) {
  return AnalysisPack.ad(String(p || '').replace('-', '/'));
}
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 極簡 Markdown 渲染 ────────────────────────────────
// 支援：# ~ ####、段落、**粗體**、*斜體*、`程式碼`、- / 1. 清單、> 引言、--- 分隔線、
//       表格（| a | b |，第二列為 |---|---|，支援 :---: 對齊）、[文字](網址)
// 先 escapeHtml 再處理標記，避免報告內容夾帶 HTML。
const renderMarkdown = md => ReportMarkdown.render(AnalysisPack.dates(md));

// 取出並移除內文開頭的 H1（避免與頁面標題重複），回傳 { title, body }
function splitLeadingTitle(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let k = 0;
  while (k < lines.length && !lines[k].trim()) k++;
  const m = k < lines.length ? lines[k].match(/^#\s+(.*)$/) : null;
  if (!m) return { title: null, body: md };
  return { title: m[1].trim(), body: lines.slice(k + 1).join('\n') };
}

// ── 載入 ───────────────────────────────────────────────
function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function showError(msg, detail) {
  document.getElementById('report-body').innerHTML =
    `<div class="report-empty">
       <p class="report-empty-title">${escapeHtml(msg)}</p>
       ${detail ? `<p class="report-empty-sub">${escapeHtml(detail)}</p>` : ''}
       <p class="report-empty-sub"><a href="./index.html">← 返回月報總表</a></p>
     </div>`;
}

async function loadReport() {
  let index;
  try {
    const resp = await fetch(`${REPORTS_INDEX}?_=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    index = await resp.json();
  } catch (e) {
    showError('尚無分析報告', '找不到 reports/index.json。');
    return;
  }

  const reports = (index && index.reports) || [];
  const want = normalizePeriod(getParam('period'));
  // 未指定期別 → 取最新一筆（index.json 由新到舊排序）
  const entry = want ? reports.find(r => normalizePeriod(r.period) === want) : reports[0];

  if (!entry) {
    showError('此月份尚無分析報告', want ? `期別：${periodLabel(want)}` : '');
    document.getElementById('period-badge').textContent = want ? `${periodLabel(want)}月報` : '—';
    return;
  }

  const period = normalizePeriod(entry.period);
  if (entry.html_file && /^\d{4}-\d{2}\.html$/.test(entry.html_file)) {
    location.replace(`./reports/${entry.html_file}`);
    return;
  }
  document.getElementById('period-badge').textContent = `${periodLabel(period)}月報`;

  // 上緣資訊列
  const meta = [];
  if (entry.manual) meta.push('人工修訂版');
  if (entry.data_changed) meta.push('原始資料已有更新，本文保留人工修訂');
  if (entry.ai_status === 'fallback') meta.push('AI 解讀暫不可用，已發布數據與新聞版');
  meta.push(`期別：${periodAd(period)}`);
  if (entry.generated_at) meta.push(`報告產生：${fmtDate(entry.generated_at)}`);
  if (entry.source) meta.push(`產製方式：${entry.source}`);
  document.getElementById('report-topline').innerHTML =
    `<span class="report-meta">${meta.map(escapeHtml).join('　｜　')}</span>` +
    (entry.draft ? `<span class="report-draft">此為排版範例，正式報告內容待帶入</span>` : '');

  // 內文（檔名可能含中文／空白 → 必須編碼，否則部分瀏覽器與伺服器取不到）
  try {
    const resp = await fetch(`./reports/${encodeURIComponent(entry.file)}?_=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    // 標題優先序：內文的 H1 → index.json 的 title → 依期別產生
    const { title, body } = splitLeadingTitle(text);
    const h1 = title || entry.title || `${periodLabel(period)} 金控月獲利分析報告`;
    document.getElementById('report-h1').textContent = h1;
    document.title = `${h1} ｜ 台灣金控月自結獲利`;
    document.getElementById('report-body').innerHTML = renderMarkdown(body);
  } catch (e) {
    showError('報告內容載入失敗', `檔案：reports/${entry.file}`);
    return;
  }

  document.getElementById('report-footnote').innerHTML =
    `本報告依據公開資訊觀測站之各金控月自結損益公告與公開新聞資訊整理，僅供資訊參考，不構成投資建議。`
    + (entry.source ? `　報告由 ${escapeHtml(entry.source)} 產製，數字請以各公司正式公告為準。` : '');
}

document.addEventListener('DOMContentLoaded', loadReport);
