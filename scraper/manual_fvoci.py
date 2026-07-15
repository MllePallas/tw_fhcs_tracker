# manual_fvoci.py
# 手動補壽險子公司「加計 FVOCI 股票處份利益後獲利」工具。
#
# 用途：某些金控（如富邦）的壽險加計 FVOCI 後獲利只揭露在 allowed_domains 以外
# 的來源（Yahoo 股市等），fvoci_adjustment.py 的 web_search 抓不到。此時人工把
# 數字直接寫進月份 JSON。
#
# 寫入的 fvoci_adjusted 會標記 manual=true，fvoci_adjustment.py 於一般執行與
# --force 時都會跳過（不覆蓋人工內容），除非明確 --override-manual。
#
# 用法：
#   # 具體數字（exact）：累計必填，當月選填
#   python manual_fvoci.py --code 2881 --period 115/06 \
#       --cumulative 143240 --monthly 0 \
#       --source "https://tw.stock.yahoo.com/news/xxx" \
#       --quote "富邦人壽…加計FVOCI處分損益後，上半年合計1,432.4億元" \
#       --original-text "1,432.4億元"
#     （--monthly 省略即代表新聞未揭露當月加計數，前端顯示 —）
#
#   # 門檻/區間型（lower_bound，如國泰「對保留盈餘影響數突破1,300億」）
#   python manual_fvoci.py --code 2882 --period 115/06 --lower-bound --prefix 突破 \
#       --cumulative 130000 --source "..." --quote "..." --original-text "突破1,300億元"
#
# 數字單位：NT$m（百萬元）。億元 × 100 = 百萬元（1,432.4億 → 143240）。

import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fvoci_adjustment import find_life_subsidiary  # noqa: E402

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"


def _sync_other(period_file, period, data):
    """latest.json ↔ 對應月份歸檔互相同步（與 fvoci_adjustment.py 同邏輯）。"""
    archive_path = DATA_DIR / f"{period.replace('/', '-')}.json" if period else None
    latest_path = DATA_DIR / "latest.json"
    other = archive_path if period_file.name == "latest.json" else latest_path
    if not other or other == period_file:
        return
    write_other = True
    if other.exists() and other != latest_path:
        with open(other, encoding="utf-8") as f:
            if json.load(f).get("report_period") != period:
                write_other = False
    if write_other:
        with open(other, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Also synced {other.name}")


def main():
    ap = argparse.ArgumentParser(description="手動補壽險加計FVOCI後獲利")
    ap.add_argument("--code", required=True, help="金控代號，例 2881")
    ap.add_argument("--period", default=None, help="民國年/月，例 115/06；預設用 latest.json")
    ap.add_argument("--cumulative", type=float, required=True, help="累計加計FVOCI後獲利（NT$m，億×100）")
    ap.add_argument("--monthly", type=float, default=None, help="當月加計FVOCI後獲利（NT$m，選填）")
    ap.add_argument("--lower-bound", action="store_true", help="門檻/區間型（如國泰「突破X億」），不算 YoY")
    ap.add_argument("--prefix", default="逾", help="門檻型顯示字（逾／突破／超過），僅 --lower-bound 時用")
    ap.add_argument("--source", default="", help="來源 URL")
    ap.add_argument("--quote", default="", help="引用原句（需含壽險公司名與數字）")
    ap.add_argument("--original-text", default="", help="新聞原始字樣，例 '1,432.4億元'")
    args = ap.parse_args()

    period_file = (
        DATA_DIR / f"{args.period.replace('/', '-')}.json" if args.period
        else DATA_DIR / "latest.json"
    )
    if not period_file.exists():
        print(f"File not found: {period_file}", file=sys.stderr)
        sys.exit(1)

    with open(period_file, encoding="utf-8") as f:
        data = json.load(f)
    period = data.get("report_period", "")

    company = next((c for c in data.get("companies", []) if c.get("code") == args.code), None)
    if company is None or company.get("error"):
        print(f"代號 {args.code} 不在 {period_file.name} 或為 error 狀態", file=sys.stderr)
        sys.exit(1)

    life_sub = find_life_subsidiary(company.get("subsidiaries", []))
    if not life_sub:
        print(f"[{args.code}] 找不到壽險子公司（名稱含「人壽」）", file=sys.stderr)
        sys.exit(1)

    life_cumul = life_sub.get("cumulative_profit")
    if life_cumul is not None and args.cumulative <= life_cumul:
        print(
            f"警告：加計FVOCI累計 {args.cumulative} <= 原始累計 {life_cumul}，"
            f"加計處份利益理論上應更大，請確認數字（單位 NT$m）。",
            file=sys.stderr,
        )
        sys.exit(1)

    life_monthly = life_sub.get("monthly_profit")
    if args.monthly is not None and life_monthly is not None and args.monthly < life_monthly:
        print(
            f"警告：加計FVOCI當月 {args.monthly} < 原始當月 {life_monthly}，請確認。",
            file=sys.stderr,
        )
        sys.exit(1)

    adj = {}
    if args.lower_bound:
        adj["value_type"] = "lower_bound"
    adj["cumulative_profit"] = round(args.cumulative, 1)
    if args.monthly is not None:
        adj["monthly_profit"] = round(args.monthly, 1)
    if args.lower_bound:
        adj["display_prefix"] = args.prefix
    else:
        if life_cumul is not None:
            adj["delta_vs_original"] = round(args.cumulative - life_cumul, 1)
    adj["source_url"] = args.source
    adj["source_quote"] = args.quote
    adj["original_value_text"] = args.original_text
    adj["manual"] = True
    adj["generated_at"] = datetime.now().isoformat()

    life_sub["fvoci_adjusted"] = adj
    life_sub.pop("fvoci_not_found_count", None)

    # 重算 YoY（lower_bound 會被 compute_yoy 自動跳過）
    try:
        from main import compute_yoy
        compute_yoy(data, period)
    except Exception as e:
        print(f"compute_yoy failed: {e}", file=sys.stderr)

    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    yoy = life_sub["fvoci_adjusted"].get("yoy_pct")
    print(
        f"[{args.code} {company.get('name')}] {life_sub.get('name')} FVOCI 手動寫入 {period_file.name}："
        f"累計 {adj['cumulative_profit']}"
        + (f"、當月 {adj['monthly_profit']}" if 'monthly_profit' in adj else "、當月 —")
        + (f"、YoY {yoy}%" if yoy is not None else "（lower_bound，不計 YoY）")
    )
    _sync_other(period_file, period, data)


if __name__ == "__main__":
    main()
