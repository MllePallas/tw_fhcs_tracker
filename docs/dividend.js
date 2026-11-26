/* 金控現金股利試算（獨立頁面，不與 app.js 共用狀態）
 * 讀取：data/index.json、data/{period}.json、data/prices.json
 * 內部金額單位：百萬元；畫面顯示與手動輸入：億元
 */
(function () {
  'use strict';

  const DEFAULTS = { bank: 70, life: 10, other: 70, payout: 40 };
  const CAT_LABEL = { bank: '銀行／證券', life: '壽險', other: '其他' };
  const STORE_KEY = 'dv-calc-v1';

  const state = {
    index: null,
    period: null,
    data: null,
    prices: {},
    shares: {},        // TWSE 已發行普通股數（prices.json 的 shares 區塊）
    pricesMeta: null,
    method: 'upstream',
    basis: 'annualized',
    sort: 'code',
    paramRaw: {},      // 使用者輸入的全體比例（字串）；空值即用預設
    ov: {},            // 各期覆寫：ov[period][code] = { ratio:{sub:pct}, payout, base:{sub|_h: 億}, price, shares }
    open: new Set(),
  };

  // ── 工具 ──────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (v, d = 1) => (v === null || !Number.isFinite(v)) ? '—'
    : v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  const yi = (mn) => (mn === null ? null : mn / 100);       // 百萬元 → 億元
  const rocToAd = (p) => { const [y, m] = p.split('/'); return `${+y + 1911}/${m}`; };
  const unitScale = (u) => (u === '千元' ? 1 / 1000 : u === '元' ? 1 / 1e6 : u === '億元' ? 100 : 1);

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (s.method) state.method = s.method;
      if (s.basis) state.basis = s.basis;
      if (s.sort) state.sort = s.sort;
      if (s.paramRaw) state.paramRaw = s.paramRaw;
      if (s.ov) state.ov = s.ov;
    } catch (_) { /* 無痕或停用儲存時忽略 */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        method: state.method, basis: state.basis, sort: state.sort, paramRaw: state.paramRaw, ov: state.ov,
      }));
    } catch (_) { /* ignore */ }
  }
  const ovOf = (code) => {
    const p = (state.ov[state.period] ||= {});
    return (p[code] ||= {});
  };

  const P = (k) => { const n = num(state.paramRaw[k]); return n === null ? DEFAULTS[k] : n; };

  function category(name) {
    if (/人壽/.test(name)) return 'life';
    if (/銀行|證券|證劵|期貨|票券/.test(name)) return 'bank';
    return 'other';
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  // ── 計算 ──────────────────────────────────────────────
  function compute(c) {
    const sc = unitScale(c.unit);
    const h = c.holding_company || {};
    const month = Number((c.report_month || state.period || '').split('/')[1]) || 12;
    const factor = 12 / month;
    const ov = ovOf(c.code);
    const manual = state.basis === 'manual';

    const hCum = h.cumulative_profit != null ? h.cumulative_profit * sc : null;
    const hFv = h.fvoci_adjusted && h.fvoci_adjusted.cumulative_profit != null ? h.fvoci_adjusted.cumulative_profit * sc : null;
    const eps = num(h.cumulative_eps);
    const autoShares = hCum !== null && eps && eps > 0 ? hCum / eps : null;          // EPS 反推，百萬股
    const tw = state.shares[c.code];
    const twseShares = tw && tw.common_shares ? tw.common_shares / 1e6 : null;       // TWSE，百萬股
    const manShares = num(ov.shares);
    let shares, sharesSrc;
    if (manShares !== null && manShares > 0) { shares = manShares * 100; sharesSrc = 'manual'; }
    else if (twseShares) { shares = twseShares; sharesSrc = 'twse'; }
    else { shares = autoShares; sharesSrc = autoShares ? 'implied' : null; }

    const hRef = (hFv ?? hCum);
    const hRefAnnual = hRef !== null ? hRef * factor : null;

    let base = null, distributable = null, subs = [], payoutPct = null;

    if (state.method === 'upstream') {
      subs = (c.subsidiaries || []).map((s) => {
        const cat = category(s.name);
        const cum = s.cumulative_profit != null ? s.cumulative_profit * sc : null;
        const fv = s.fvoci_adjusted && s.fvoci_adjusted.cumulative_profit != null ? s.fvoci_adjusted.cumulative_profit * sc : null;
        const ref = cat === 'life' && fv !== null ? fv : cum;
        const annual = ref !== null ? ref * factor : null;
        const man = manual ? num((ov.base || {})[s.name]) : null;
        const b = man !== null ? man * 100 : annual;
        const rOv = num((ov.ratio || {})[s.name]);
        const ratio = rOv !== null ? rOv : P(cat);
        const up = b !== null ? Math.max(0, b) * ratio / 100 : null;
        return { name: s.name, cat, cum, fv, usedFv: cat === 'life' && fv !== null, annual, base: b, ratio, ratioOv: rOv !== null, up, manualSet: man !== null };
      });
      const valid = subs.filter((s) => s.base !== null);
      base = valid.length ? valid.reduce((a, s) => a + s.base, 0) : null;
      distributable = valid.length ? valid.reduce((a, s) => a + (s.up || 0), 0) : null;
    } else {
      const man = manual ? num((ov.base || {})._h) : null;
      base = man !== null ? man * 100 : hRefAnnual;
      const pOv = num(ov.payout);
      payoutPct = pOv !== null ? pOv : P('payout');
      distributable = base !== null ? Math.max(0, base) * payoutPct / 100 : null;
    }

    const dps = distributable !== null && shares ? distributable / shares : null;
    const priceOv = num(ov.price);
    const pr = state.prices[c.code];
    const price = priceOv !== null && priceOv > 0 ? priceOv : (pr ? pr.close : null);
    const yld = dps !== null && price ? dps / price * 100 : null;
    const implied = distributable !== null && hRefAnnual ? distributable / hRefAnnual * 100 : null;

    return {
      code: c.code, name: c.name, month, factor, hCum, hFv, hRefAnnual, eps, autoShares, twseShares, shares, sharesSrc,
      twseSharesDate: tw ? tw.date : null, twsePref: tw ? tw.preferred_shares : 0, base, distributable, subs, payoutPct, payoutOv: num(ov.payout) !== null,
      dps, price, priceOv: priceOv !== null, priceDate: priceOv !== null ? null : (pr && pr.date), yld, implied,
      annualEps: hRefAnnual !== null && shares ? hRefAnnual / shares : null,
    };
  }

  // ── 繪製 ──────────────────────────────────────────────
  function input(key, value, placeholder, cls = '') {
    return `<input class="dv-input ${cls}" type="text" inputmode="decimal" data-key="${esc(key)}" value="${esc(value ?? '')}" placeholder="${esc(placeholder ?? '')}" />`;
  }

  function renderParams() {
    const pct = (k, label) => `<label class="dv-field dv-param"><span>${label}</span><span class="dv-pct">${input('param:' + k, state.paramRaw[k] ?? DEFAULTS[k], DEFAULTS[k], 'dv-num dv-small')}<em>%</em></span></label>`;
    $('dv-params').innerHTML = state.method === 'upstream'
      ? pct('bank', '銀行／證券上繳') + pct('life', '壽險上繳（含 FVOCI）') + pct('other', '其他子公司上繳')
      : pct('payout', '總配發率（金控＋FVOCI）');
    const m = state.data ? Number(state.period.split('/')[1]) : null;
    const f = m ? 12 / m : null;
    $('dv-hint').innerHTML = state.basis === 'annualized'
      ? `獲利基準＝${m ? `1–${m} 月累計 × 12 ÷ ${m}（× ${fmt(f, 2)}）` : '累計 × 12 ÷ 月數'}。以上比例為全體預設，可在各金控明細中個別覆寫。`
      : `手動模式：獲利基準先帶入年化數字，${state.method === 'upstream' ? '展開明細後可逐一改寫子公司全年獲利' : '可直接在表格中改寫全年獲利'}（單位：億元）。清空即回到年化值。`;
  }

  function sortRows(rows) {
    const k = state.sort;
    if (k === 'code') return rows.sort((a, b) => a.code.localeCompare(b.code));
    return rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  }

  function renderTable() {
    const companies = (state.data && state.data.companies) || [];
    const rows = sortRows(companies.map((c) => ({ ...compute(c), _raw: c })));
    const manual = state.basis === 'manual';
    const baseLabel = manual ? '全年獲利（手動）' : '全年獲利（年化）';
    const head = `<thead><tr>
      <th class="dv-l">金控</th>
      <th>${baseLabel}<small>億元</small></th>
      <th>可配發金額<small>億元</small></th>
      <th>流通股數<small>億股・TWSE</small></th>
      <th>隱含配發率<small>占加計FVOCI獲利</small></th>
      <th class="dv-key">每股現金股利<small>元</small></th>
      <th>收盤價<small>元・可覆寫</small></th>
      <th class="dv-key">現金殖利率</th>
    </tr></thead>`;

    const body = rows.map((r) => {
      const isOpen = state.open.has(r.code);
      const baseCell = manual && state.method === 'payout'
        ? input(`base:${r.code}:_h`, ovOf(r.code).base?._h ?? '', fmt(yi(r.hRefAnnual)), 'dv-num')
        : fmt(yi(r.base));
      const priceCell = `${input(`price:${r.code}`, ovOf(r.code).price ?? '', r.price !== null && !r.priceOv ? fmt(r.price, 2) : '輸入', 'dv-num dv-price')}
        <small class="dv-date">${r.priceOv ? '手動' : (r.priceDate ? esc(r.priceDate) : '無資料')}</small>`;
      const main = `<tr class="dv-row ${isOpen ? 'open' : ''}" data-code="${esc(r.code)}">
        <td class="dv-l"><button type="button" class="dv-toggle" data-toggle="${esc(r.code)}" aria-expanded="${isOpen}">${isOpen ? '▾' : '▸'}</button>
          <span class="dv-code">${esc(r.code)}</span> ${esc(r.name)}</td>
        <td>${baseCell}</td>
        <td>${fmt(yi(r.distributable))}</td>
        <td>${fmt(r.shares !== null ? r.shares / 100 : null, 2)}${r.sharesSrc === 'manual' ? '<small class="dv-flag">手動</small>' : r.sharesSrc === 'implied' ? '<small class="dv-flag">EPS 反推</small>' : ''}</td>
        <td>${r.implied !== null ? fmt(r.implied, 0) + '%' : '—'}</td>
        <td class="dv-key">${fmt(r.dps, 2)}</td>
        <td class="dv-pricecell">${priceCell}</td>
        <td class="dv-key">${r.yld !== null ? fmt(r.yld, 2) + '%' : '—'}</td>
      </tr>`;
      return main + (isOpen ? `<tr class="dv-detail"><td colspan="8">${renderDetail(r)}</td></tr>` : '');
    }).join('');

    $('dv-table').innerHTML = head + `<tbody>${body}</tbody>`;
    $('dv-table-title').textContent = `各金控推估現金股利（${state.method === 'upstream' ? '子公司上繳' : '總配發率'}・${manual ? '手動基準' : '年化基準'}）`;
  }

  function renderDetail(r) {
    const ov = ovOf(r.code);
    const manual = state.basis === 'manual';
    const m = r.month;
    let html = '';
    if (state.method === 'upstream') {
      const rows = r.subs.map((s) => `<tr>
        <td class="dv-l">${esc(s.name)}</td>
        <td class="dv-l"><span class="dv-cat dv-cat-${s.cat}">${CAT_LABEL[s.cat]}</span></td>
        <td>${fmt(yi(s.cum))}</td>
        <td>${s.cat === 'life' ? (s.fv !== null ? fmt(yi(s.fv)) : '<span class="dv-muted">未揭露</span>') : '<span class="dv-muted">—</span>'}</td>
        <td>${manual ? input(`base:${r.code}:${s.name}`, (ov.base || {})[s.name] ?? '', fmt(yi(s.annual)), 'dv-num') : fmt(yi(s.base))}</td>
        <td><span class="dv-pct">${input(`ratio:${r.code}:${s.name}`, (ov.ratio || {})[s.name] ?? '', P(s.cat), 'dv-num dv-small')}<em>%</em></span></td>
        <td>${fmt(yi(s.up))}</td>
      </tr>`).join('');
      html += `<table class="dv-sub"><thead><tr>
          <th class="dv-l">子公司</th><th class="dv-l">類別</th>
          <th>1–${m} 月累計<small>億元</small></th><th>加計 FVOCI<small>億元</small></th>
          <th>${manual ? '全年獲利（手動）' : '全年獲利（年化）'}<small>億元</small></th>
          <th>上繳比例</th><th>上繳金額<small>億元</small></th>
        </tr></thead><tbody>${rows}</tbody>
        <tfoot><tr><td class="dv-l" colspan="4">合計</td><td>${fmt(yi(r.base))}</td><td></td><td>${fmt(yi(r.distributable))}</td></tr></tfoot></table>`;
    } else {
      html += `<table class="dv-sub"><thead><tr>
          <th class="dv-l">項目</th><th>1–${m} 月累計<small>億元</small></th><th>全年（年化）<small>億元</small></th>
        </tr></thead><tbody>
          <tr><td class="dv-l">金控稅後淨利</td><td>${fmt(yi(r.hCum))}</td><td>${fmt(yi(r.hCum !== null ? r.hCum * r.factor : null))}</td></tr>
          <tr><td class="dv-l">加計 FVOCI 處分利益</td><td>${r.hFv !== null ? fmt(yi(r.hFv)) : '<span class="dv-muted">未揭露，以稅後淨利計</span>'}</td><td>${fmt(yi(r.hRefAnnual))}</td></tr>
        </tbody></table>
        <div class="dv-inline-params"><label class="dv-field dv-inline"><span>本公司配發率</span>
          <span class="dv-pct">${input(`payout:${r.code}`, ov.payout ?? '', P('payout'), 'dv-num dv-small')}<em>%</em></span></label></div>`;
    }
    html += `<div class="dv-inline-params">
      <label class="dv-field dv-inline"><span>流通股數（億股）</span>
        ${input(`shares:${r.code}`, ov.shares ?? '', (r.twseShares ?? r.autoShares) !== null ? fmt((r.twseShares ?? r.autoShares) / 100, 2) : '輸入', 'dv-num dv-small')}</label>
      <span class="dv-muted">${r.twseShares
        ? `TWSE 已發行普通股數 ${fmt(r.twseShares / 100, 2)} 億股${r.twseSharesDate ? `（${esc(r.twseSharesDate)}）` : ''}${r.twsePref ? `，另有特別股 ${fmt(r.twsePref / 1e8, 2)} 億股（不參與普通股配息，未計入）` : ''}`
        : 'TWSE 股數尚無資料，暫以 EPS 反推'}；對照：累計淨利 ${fmt(yi(r.hCum))} 億 ÷ 累計 EPS ${fmt(r.eps, 2)} 元 ≈ ${fmt(r.autoShares !== null ? r.autoShares / 100 : null, 2)} 億股${r.twseShares && r.autoShares ? `（差 ${fmt((r.autoShares / r.twseShares - 1) * 100, 1)}%）` : ''}；年化 EPS（含 FVOCI）約 ${fmt(r.annualEps, 2)} 元</span>
    </div>`;
    return `<div class="dv-detail-inner">${html}</div>`;
  }

  function renderPriceNote() {
    const dates = Object.values(state.prices).map((p) => p.date).filter(Boolean).sort();
    const latest = dates[dates.length - 1];
    const sd = Object.values(state.shares).map((x) => x.date).filter(Boolean).sort();
    const sharesTxt = sd.length
      ? `流通股數取自 TWSE 上市公司基本資料「已發行普通股數」（${esc(sd[sd.length - 1])}）。`
      : '流通股數尚未取得 TWSE 資料，暫以累計淨利 ÷ 累計 EPS 反推。';
    $('dv-price-note').innerHTML = (latest
      ? `收盤價為 ${esc(latest)} 收盤（TWSE OpenAPI，缺值以 Yahoo Finance 補），平日收盤後自動更新，輸入框可暫時覆寫價格。`
      : '尚未取得收盤價資料，可在「收盤價」欄手動輸入以計算殖利率。') + sharesTxt;
  }

  function render() {
    $('dv-method').value = state.method;
    $('dv-basis').value = state.basis;
    $('dv-sort').value = state.sort;
    renderParams();
    renderTable();
    renderPriceNote();
  }

  // 重新繪製後保留輸入焦點
  function renderKeepFocus() {
    const a = document.activeElement;
    const key = a && a.dataset ? a.dataset.key : null;
    const pos = key ? a.selectionStart : null;
    render();
    if (key) {
      const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) { /* ignore */ } }
    }
  }

  // ── 事件 ──────────────────────────────────────────────
  function onInput(e) {
    const el = e.target;
    const key = el.dataset && el.dataset.key;
    if (!key) return;
    const v = el.value.trim();
    const parts = key.split(':');
    const kind = parts[0];
    if (kind === 'param') {
      state.paramRaw[parts[1]] = v;
    } else {
      const code = parts[1];
      const ov = ovOf(code);
      const set = (obj, k) => { if (v === '') delete obj[k]; else obj[k] = v; };
      if (kind === 'ratio') set((ov.ratio ||= {}), parts.slice(2).join(':'));
      else if (kind === 'base') set((ov.base ||= {}), parts.slice(2).join(':'));
      else if (kind === 'payout' || kind === 'price' || kind === 'shares') set(ov, kind);
    }
    save();
    renderKeepFocus();
  }

  function bind() {
    document.addEventListener('input', onInput);
    $('dv-method').addEventListener('change', (e) => { state.method = e.target.value; save(); render(); });
    $('dv-basis').addEventListener('change', (e) => { state.basis = e.target.value; save(); render(); });
    $('dv-sort').addEventListener('change', (e) => { state.sort = e.target.value; save(); render(); });
    $('dv-period').addEventListener('change', (e) => loadPeriod(e.target.value));
    $('dv-reset').addEventListener('click', () => {
      state.paramRaw = {};
      delete state.ov[state.period];
      save(); render();
    });
    $('dv-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle]');
      if (!btn) return;
      const code = btn.dataset.toggle;
      state.open.has(code) ? state.open.delete(code) : state.open.add(code);
      render();
    });
  }

  async function loadPeriod(period) {
    const entry = (state.index.months || []).find((m) => m.period === period);
    if (!entry) return;
    state.period = period;
    state.data = await getJSON(`data/${entry.file}`);
    $('dv-period-badge').textContent = `${rocToAd(period)} 自結`;
    try { history.replaceState(null, '', `?period=${rocToAd(period).replace('/', '-')}`); } catch (_) { /* ignore */ }
    render();
  }

  async function init() {
    load();
    bind();
    try {
      state.index = await getJSON('data/index.json');
    } catch (err) {
      $('dv-table').innerHTML = `<tbody><tr><td>資料載入失敗：${esc(err.message)}</td></tr></tbody>`;
      return;
    }
    try {
      const p = await getJSON('data/prices.json');
      state.prices = p.prices || {};
      state.shares = p.shares || {};
      state.pricesMeta = p;
    } catch (_) { state.prices = {}; state.shares = {}; }

    const months = (state.index.months || []).filter((m) => m.success_count > 0);
    $('dv-period').innerHTML = months.map((m) => `<option value="${esc(m.period)}">${esc(rocToAd(m.period))}</option>`).join('');
    const q = new URLSearchParams(location.search).get('period');
    const wanted = q && /^\d{4}-\d{2}$/.test(q) ? `${String(+q.slice(0, 4) - 1911).padStart(3, '0')}/${q.slice(5)}` : null;
    const start = months.find((m) => m.period === wanted) ? wanted : (state.index.latest || (months[0] && months[0].period));
    $('dv-period').value = start;
    await loadPeriod(start);
  }

  init();
})();
