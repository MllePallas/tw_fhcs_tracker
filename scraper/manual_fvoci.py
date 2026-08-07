# manual_fvoci.py
# 手動補「加計 FVOCI 股票處分利益後獲利」工具——壽險子公司層級（預設）或
# 金控合併層級（--holding，寫入 holding_company.fvoci_adjusted）。
#
# 用途：某些數字只揭露在 allowed_domains 以外的來源（Yahoo 股市等），或
# fvoci_adjustment.py 的 web_search 撲空。此時人工把數字直接寫進月份 JSON。
#
# 寫入的 fvoci_adjusted 會標記 manual=true，fvoci_adjustment.py 於一般執行與
# --force 時都會跳過（不覆蓋人工內容），除非明確 --override-manual。
#
# 用法：
#   # 壽險子公司層級，具體數字（exact）：累計必填，當月選填
#   python manual_fvoci.py --code 2881 --period 115/06 \
#       --cumulative 143240 --monthly 19780 \
#       --source "https://tw.stock.yahoo.com/news/xxx" \
#       --quote "富邦人壽…加計FVOCI處分損益後，上半年合計1,432.4億元" \
#       --original-text "1,432.4億元"
#     （--monthly 省略即代表新聞未揭露當月加計數，前端顯示 —）
#
#   # 金控合併層級（--holding）：富邦另揭露加計後總計EPS 可用 --eps 記錄
#   python manual_fvoci.py --code 2881 --period 115/06 --holding \
#       --cumulative 188410 --monthly 29220 --eps 13.17 \
#       --quote "金控6月本期淨利加計FVOCI權益工具稅後處分利益292.2億元，累計前6月共1,884.1億元…" \
#       --original-text "單6月292.2億元、累計前6月1,884.1億元"
#
#   # 金控層級・國泰「對保留盈餘影響數」（exact，無當月數，--label 覆寫列標籤）
#   python manual_fvoci.py --code 2882 --period 115/06 --holding \
#       --cumulative 165900 --label 對保留盈餘影響數 \
#       --quote "加計FVOCI股票處分損益，累計上半年對保留盈餘之影響數達1,659億元…" \
#       --original-text "累計上半年1,659億元"
#
#   # 門檻/區間型（lower_bound，如國泰人壽「對保留盈餘影響數突破1,300億」）
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
    # 只有另一檔「指向同一期」才覆寫。latest.json 同樣要檢查——回頭補舊月份時
    # latest.json 指向的是更新的月份，無條件覆寫會把新月份資料整個蓋掉。
    write_other = True
    if other.exists():
        with open(other, encoding="utf-8") as f:
            if json.load(f).get("report_period") != period:
                write_other = False
    if write_other:
        with open(other, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Also synced {other.name}")


def main():
    ap = argparse.ArgumentParser(description="手動補加計FVOCI後獲利（壽險子公司層級或金控合併層級）")
    ap.add_argument("--code", required=True, help="金控代號，例 2881")
    ap.add_argument("--period", default=None, help="民國年/月，例 115/06；預設用 latest.json")
    ap.add_argument("--holding", action="store_true",
                    help="寫入金控合併層級（holding_company.fvoci_adjusted）；預設寫壽險子公司")
    ap.add_argument("--cumulative", type=float, required=True, help="累計加計FVOCI後獲利（NT$m，億×100）")
    ap.add_argument("--monthly", type=float, default=None, help="當月加計FVOCI後獲利（NT$m，選填）")
    ap.add_argument("--label", default=None,
                    help="列標籤覆寫（如國泰金控層級「對保留盈餘影響數」）；省略則前端顯示預設「加上FVOCI股票處分利益」")
    ap.add_argument("--eps", type=float, default=None,
                    help="加計FVOCI後總計EPS（元，選填；目前僅富邦金控層級揭露，如 13.17）")
    ap.add_argument("--lower-bound", action="store_true", help="門檻/區間型（如「突破X億」），不算 YoY")
    ap.add_argument("--prefix", default="逾", help="門檻型顯示字（逾／突破／超過），僅 --lower-bound 時用")
    ap.add_argument("--source", default="", help="來源 URL")
    ap.add_argument("--quote", default="", help="引用原句（需含對應層級的公司名與數字）")
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

    # 目標層級：金控合併（--holding）或壽險子公司（預設）
    if args.holding:
        target = company.get("holding_company")
        if not target:
            print(f"[{args.code}] 無 holding_company 資料", file=sys.stderr)
            sys.exit(1)
        target_name = target.get("name", f"{company.get('name')}（金控合併）")
    else:
        target = find_life_subsidiary(company.get("subsidiaries", []))
        if not target:
            print(f"[{args.code}] 找不到壽險子公司（名稱含「人壽」）", file=sys.stderr)
            sys.exit(1)
        target_name = target.get("name", "壽險子公司")

    orig_cumul = target.get("cumulative_profit")
    if orig_cumul is not None and args.cumulative <= orig_cumul:
        print(
            f"警告：加計FVOCI累計 {args.cumulative} <= 原始累計 {orig_cumul}，"
            f"加計處分利益理論上應更大，請確認數字（單位 NT$m）。",
            file=sys.stderr,
        )
        sys.exit(1)

    orig_monthly = target.get("monthly_profit")
    if args.monthly is not None and orig_monthly is not None and args.monthly < orig_monthly:
        print(
            f"警告：加計FVOCI當月 {args.monthly} < 原始當月 {orig_monthly}，請確認。",
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
        if orig_cumul is not None:
            adj["delta_vs_original"] = round(args.cumulative - orig_cumul, 1)
    if args.label:
        adj["label"] = args.label
    if args.eps is not None:
        adj["cumulative_eps"] = round(args.eps, 2)
    adj["source_url"] = args.source
    adj["source_quote"] = args.quote
    adj["original_value_text"] = args.original_text
    adj["manual"] = True
    adj["generated_at"] = datetime.now().isoformat()

    target["fvoci_adjusted"] = adj
    target.pop("fvoci_not_found_count", None)

    # 重算 YoY（lower_bound 會被 compute_yoy 自動跳過；金控層級由 compute_yoy 一併處理）
    try:
        from main import compute_yoy
        compute_yoy(data, period)
    except Exception as e:
        print(f"compute_yoy failed: {e}", file=sys.stderr)

    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    yoy = target["fvoci_adjusted"].get("yoy_pct")
    level_txt = "金控合併層級" if args.holding else "壽險子公司層級"
    print(
        f"[{args.code} {company.get('name')}] {target_name}（{level_txt}）FVOCI 手動寫入 {period_file.name}："
        f"累計 {adj['cumulative_profit']}"
        + (f"、當月 {adj['monthly_profit']}" if 'monthly_profit' in adj else "、當月 —")
        + (f"、YoY {yoy}%" if yoy is not None else "（lower_bound，不計 YoY）")
    )
    _sync_other(period_file, period, data)


if __name__ == "__main__":
    main()
