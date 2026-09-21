"""Financial comparison guardrails. Shared event configuration lives beside the site.

Only derived fields are changed; original announcement amounts are never rewritten.
"""
import json
import math
from pathlib import Path

RULES = json.loads((Path(__file__).parent.parent / 'docs' / 'comparison-rules.json').read_text(encoding='utf-8'))


def months(period):
    year, month = period.split('/')
    return [f'{year}/{m:02d}' for m in range(1, int(month) + 1)]


def crosses(periods, event):
    sides = {'before' if p < event['month'] else 'transition' if p == event['month'] and event.get('partial_month') else 'after' for p in periods}
    return len(sides) > 1 or 'transition' in sides


def reason(code, current, baseline, name=None):
    periods = current + baseline
    event = RULES['mergers'].get(code)
    if event and (not name or name not in event['unchanged_subsidiaries']) and crosses(periods, event):
        return event['label']
    for event in RULES['subsidiary_events']:
        if event['code'] == code and name in event['names'] and crosses(periods, event):
            return event['label']
    acc = RULES['accounting']
    if ('人壽' in name if name else code in acc['codes']) and crosses(periods, acc):
        return acc['label']
    return ''


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def to_ntm(value, unit):
    factor = {'百萬元': 1, '億元': 100, '千元': .001, '元': .000001}.get(unit or '百萬元')
    return value * factor if numeric(value) and factor else None


def metrics(cur, base, why='', floor=15):
    if not numeric(cur) or not numeric(base):
        return None, None, 'missing', why or '比較月份資料不足'
    delta = cur - base
    if why:
        return None, delta, 'incomparable', why
    if base < 0 < cur:
        status = 'loss_to_profit'
    elif cur < 0 < base:
        status = 'profit_to_loss'
    elif base < 0:
        status = 'loss_to_zero' if cur == 0 else 'loss_narrowing' if cur > base else 'loss_widening' if cur < base else 'loss_flat'
    elif base == 0:
        status = 'zero_to_profit' if cur > 0 else 'zero_to_loss' if cur < 0 else 'flat'
    elif abs(base) <= floor:
        status = 'low_base'
    else:
        return round(delta / base * 100, 1), delta, 'normal', ''
    return None, delta, status, ''


def reported_yoy(cur, base, note=''):
    """Reported YoY uses the absolute prior-year denominator, with event notes."""
    if not numeric(cur) or not numeric(base):
        return None, None, 'missing', note or '比較月份資料不足'
    delta = cur - base
    if base == 0:
        return None, delta, 'zero_base', '；'.join(filter(None, [note, '去年同期為零，無法計算變動率']))
    return round(delta / abs(base) * 100, 1), delta, 'normal', note


def apply_yoy_policy(data, baseline, period):
    """Recalculate cumulative comparisons including full YTD scope and stale fields."""
    year, month = period.split('/')
    prior = f'{int(year)-1:03d}/{month}'
    previous = {c['code']: c for c in (baseline or {}).get('companies', []) if not c.get('error') and c.get('report_month', prior) == prior}
    for company in data.get('companies', []):
        if company.get('error'):
            continue
        code = company['code']
        old = previous.get(code, {})

        def update(target, previous_target, name=None):
            if not target:
                return
            cur = to_ntm(target.get('cumulative_profit'), company.get('unit'))
            base = to_ntm(previous_target.get('cumulative_profit'), old.get('unit'))
            pct, delta, status, why = reported_yoy(cur, base, reason(code, months(period), months(prior), name))
            factor = to_ntm(1, company.get('unit'))
            target.update(cumulative_profit_yoy_pct=pct, cumulative_profit_yoy_abs=delta / factor if delta is not None and factor else None,
                          cumulative_profit_yoy_status=status, cumulative_profit_yoy_reason=why)
            adjusted = target.get('fvoci_adjusted')
            if adjusted:
                adjusted.update(yoy_pct=None, yoy_abs=None, yoy_status='not_presented')
        update(company.get('holding_company'), old.get('holding_company', {}))
        prior_subs = {s['name']: s for s in old.get('subsidiaries', [])}
        for sub in company.get('subsidiaries', []):
            name = sub.get('name', '')
            update(sub, prior_subs.get(name, prior_subs.get(RULES['aliases'].get(name), {})), name)
