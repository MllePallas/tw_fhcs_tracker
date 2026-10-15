"""Keep retired legal entities out of later monthly subsidiary rosters.

Only subsidiary rows are removed. Published parent and successor amounts are never
reallocated or recomputed from another company.
"""
import json
from pathlib import Path

RULES_PATH = Path(__file__).parent.parent / "docs" / "comparison-rules.json"


def normalize_subsidiaries(data, period):
    rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    retired = rules.get("retired_subsidiaries", [])
    for company in data.get("companies", []):
        if company.get("error") or "subsidiaries" not in company:
            continue
        kept = []
        for sub in company["subsidiaries"]:
            event = next((e for e in retired if e["code"] == company["code"]
                          and e["name"] == sub.get("name")
                          and period > e["last_report_month"]), None)
            if not event:
                kept.append(sub)
                continue
            if sub.get("monthly_profit") is not None:
                raise ValueError(f"{company['code']} {period} {sub['name']} has post-merger monthly profit; "
                                 "verify the original announcement before publishing")
        company["subsidiaries"] = kept
    return data
