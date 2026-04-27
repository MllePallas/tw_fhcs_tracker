"""
check_result.py
本地測試用：讀取 data/latest.json 並印出摘要
"""
import json
import sys
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "latest.json"

def main():
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print("[錯誤] 找不到 data/latest.json")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"[錯誤] JSON 格式錯誤：{e}")
        sys.exit(1)

    period   = data.get("report_period", "未知")
    updated  = data.get("last_updated",  "未知")
    success  = data.get("success_count", 0)
    fail     = data.get("fail_count",    0)
    companies = data.get("companies", [])

    print(f"  報告期間：{period}")
    print(f"  最後更新：{updated}")
    print(f"  成功 / 失敗：{success} / {fail}")
    print()
    print(f"  {'代號':<6} {'公司':<8} {'狀態':<10} 說明")
    print(f"  {'-'*50}")

    for c in companies:
        code  = c.get("code", "?")
        name  = c.get("name", "?")
        error = c.get("error")

        if error:
            status = "❌ 失敗"
            detail = c.get("error_msg", error)
        else:
            hc     = c.get("holding_company", {})
            m      = hc.get("monthly_profit")
            cu     = hc.get("cumulative_profit")
            unit   = hc.get("unit", "千元")
            status = "✅ 成功"
            detail = f"當月={m} 累計={cu} ({unit})"

        print(f"  {code:<6} {name:<8} {status:<10} {detail}")

if __name__ == "__main__":
    main()
