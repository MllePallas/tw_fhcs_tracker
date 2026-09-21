/* Pure calculations shared by the UI, exports and regression tests. Values: NT$m. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProfitAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  function shift(period, offset) {
    const [y, m] = period.split('/').map(Number);
    const n = y * 12 + m - 1 + offset;
    return `${Math.floor(n / 12)}/${String((n % 12 + 12) % 12 + 1).padStart(2, '0')}`;
  }
  function range(end, length) { return Array.from({ length }, (_, i) => shift(end, i - length + 1)); }
  function yearMonths(end) { return range(end, Number(end.split('/')[1])); }
  function toNTM(v, unit = '百萬元') {
    const f = { '百萬元': 1, '億元': 100, '千元': 0.001, '元': 0.000001 }[unit];
    return finite(v) && f ? v * f : null;
  }
  function company(history, period, code) {
    const d = history[period];
    if (!d || d.report_period !== period) return null;
    const c = (d.companies || []).find(c => c.code === code);
    return c && !c.error && (!c.report_month || c.report_month === period) ? c : null;
  }
  function value(history, period, code, field = 'monthly_profit', name = null, rules = {}) {
    const c = company(history, period, code);
    const h = name ? c?.subsidiaries?.find(s => s.name === name || s.name === rules.aliases?.[name]) : c?.holding_company;
    return toNTM(h?.[field], c?.unit);
  }
  function median(values) {
    const a = values.filter(finite).sort((a, b) => a - b);
    return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : 0;
  }
  function complete(history, periods, code, field = 'monthly_profit', name = null, rules = {}) {
    const values = periods.map(p => value(history, p, code, field, name, rules));
    const missing = periods.filter((_, i) => !finite(values[i]));
    return { values, missing, sum: missing.length ? null : values.reduce((a, b) => a + b, 0) };
  }
  function eventCrosses(periods, event) {
    const sides = new Set(periods.map(p => p < event.month ? 'before' : p === event.month && event.partial_month ? 'transition' : 'after'));
    return sides.size > 1 || sides.has('transition');
  }
  function reason(rules, code, currentPeriods, basePeriods, name = null) {
    const periods = [...currentPeriods, ...basePeriods];
    if (!periods.length) return '';
    const merger = rules.mergers?.[code];
    if (merger && (!name || !merger.unchanged_subsidiaries.includes(name)) && eventCrosses(periods, merger)) return merger.label;
    for (const event of rules.subsidiary_events || []) {
      if (event.code === code && name && event.names.includes(name) && eventCrosses(periods, event)) return event.label;
    }
    const acc = rules.accounting;
    if (acc && (name ? /人壽/.test(name) : acc.codes.includes(code)) && eventCrosses(periods, acc)) return acc.label;
    return '';
  }
  function compare(cur, base, options = {}) {
    const result = { cur, base, delta: finite(cur) && finite(base) ? cur - base : null, pct: null, status: 'missing', reason: options.reason || '', direction: 0 };
    if (!finite(cur) || !finite(base)) { result.reason ||= '比較月份資料不足'; return result; }
    if (result.reason) { result.status = 'incomparable'; return result; }
    result.direction = Math.sign(result.delta);
    if (base < 0 && cur > 0) result.status = 'loss_to_profit';
    else if (base > 0 && cur < 0) result.status = 'profit_to_loss';
    else if (base < 0) result.status = cur === 0 ? 'loss_to_zero' : cur > base ? 'loss_narrowing' : cur < base ? 'loss_widening' : 'loss_flat';
    else if (base === 0) result.status = cur > 0 ? 'zero_to_profit' : cur < 0 ? 'zero_to_loss' : 'flat';
    else if (Math.abs(base) <= Math.max(options.floor ?? 15, (options.scale || 0) * (options.fraction ?? 0.1))) result.status = 'low_base';
    else { result.status = 'normal'; result.pct = result.delta / base * 100; }
    return result;
  }
  // Reported YoY remains a percentage; event notes do not replace the result.
  function reportedYoY(cur, base, note = '') {
    const out = { cur, base, delta: finite(cur) && finite(base) ? cur - base : null, pct: null, status: 'missing', reason: note, direction: 0 };
    if (out.delta === null) { out.reason ||= '比較月份資料不足'; return out; }
    out.direction = Math.sign(out.delta);
    if (base === 0) { out.status = 'zero_base'; out.reason = [note, '去年同期為零，無法計算變動率'].filter(Boolean).join('；'); return out; }
    out.pct = out.delta / Math.abs(base) * 100;
    out.status = 'normal';
    return out;
  }
  function comparison(history, rules, code, currentPeriods, basePeriods, average = false, name = null) {
    const cur = complete(history, currentPeriods, code, 'monthly_profit', name, rules);
    const base = complete(history, basePeriods, code, 'monthly_profit', name, rules);
    const scale = median([...cur.values, ...base.values].filter(finite).map(Math.abs));
    const out = compare(cur.sum, base.sum === null ? null : average ? base.sum / basePeriods.length : base.sum, {
      reason: reason(rules, code, currentPeriods, basePeriods, name),
      floor: rules.tolerance_ntm * (average ? 1 : basePeriods.length),
      scale: scale * (average ? 1 : basePeriods.length), fraction: rules.low_base_fraction,
    });
    return { ...out, currentPeriods, basePeriods, missing: [...cur.missing, ...base.missing] };
  }
  function reconcile(history, rules, code, periods) {
    const raw = complete(history, periods, code);
    const end = periods.at(-1), start = periods[0];
    const endCum = value(history, end, code, 'cumulative_profit');
    const baseCum = start.endsWith('/01') ? 0 : value(history, shift(start, -1), code, 'cumulative_profit');
    if (start.split('/')[0] !== end.split('/')[0]) return { sum: raw.sum, cumulative: null, delta: null, note: '跨年期間以逐月公告加總；累計每年歸零。' };
    const cumulative = finite(endCum) && finite(baseCum) ? endCum - baseCum : null;
    const delta = finite(cumulative) && finite(raw.sum) ? cumulative - raw.sum : null;
    let note = rules.basis_notes?.[code] || '';
    const revisions = periods.map(p => rules.revisions?.[`${code}|${p}`]).filter(Boolean);
    if (revisions.length) note ||= revisions[0];
    if (!note && delta !== null && Math.abs(delta) > rules.tolerance_ntm * Math.max(1, periods.length)) note = '單月加總與累計軋差不一致，可能含更正或口徑差異，待核對。';
    if (raw.missing.length) note = `缺少 ${raw.missing.join('、')} 單月資料；不補零。`;
    else if (cumulative === null) note = '缺少期末或期初前月公告累計，無法核對單月加總。';
    return { sum: raw.sum, cumulative, delta, note };
  }
  function row(history, rules, period, code, name) {
    const periods = range(period, 12);
    const values = periods.map(p => value(history, p, code));
    const monthly = values.at(-1);
    const mom = comparison(history, rules, code, [period], [shift(period, -1)]);
    const average = comparison(history, rules, code, [period], range(shift(period, -1), 3), true);
    const rolling = comparison(history, rules, code, range(period, 3), range(shift(period, -3), 3));
    const yoy = { ...reportedYoY(monthly, value(history, shift(period, -12), code), reason(rules, code, [period], [shift(period, -12)])), currentPeriods: [period], basePeriods: [shift(period, -12)] };
    const labels = [];
    if (mom.status === 'loss_to_profit') labels.push('虧轉盈');
    if (mom.status === 'profit_to_loss') labels.push('盈轉虧');
    const four = values.slice(-4);
    if (four.every(finite) && !reason(rules, code, range(period, 4), [])) {
      const deltas = four.slice(1).map((v, i) => v - four[i]);
      if (deltas.every(v => v > 0)) labels.push('連續 3 次月增');
      if (deltas.every(v => v < 0)) labels.push('連續 3 次月減');
    }
    const six = values.slice(-6);
    if (six.every(finite) && !reason(rules, code, range(period, 6), [])) {
      if (monthly > Math.max(...six.slice(0, -1))) labels.push('近 6 月新高');
      if (monthly < Math.min(...six.slice(0, -1))) labels.push('近 6 月新低');
    }
    if (mom.direction > 0 && average.direction < 0) labels.push('月增，仍低於前 3 月均值');
    if (mom.direction < 0 && average.direction > 0) labels.push('月減，仍高於前 3 月均值');
    if (average.pct >= 20) labels.push('高於前 3 月均值 ≥20%');
    if (average.pct <= -20) labels.push('低於前 3 月均值 ≥20%');
    const reconciliation = reconcile(history, rules, code, yearMonths(period));
    const notes = [...new Set([mom, average, rolling, yoy].filter(x => x.reason && x.status !== 'missing').map(x => x.reason))];
    if (reconciliation.note) notes.push(reconciliation.note);
    return { code, name, period, periods, values, monthly, mom, average, rolling, yoy, labels, notes, reconciliation };
  }
  return { finite, shift, range, yearMonths, toNTM, company, value, median, complete, reason, compare, reportedYoY, comparison, reconcile, row };
});
