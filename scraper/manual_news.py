# manual_news.py
# 手動補新聞摘要工具。
#
# 用途：某些金控的月損益報導只出現在 allowed_domains 以外的來源（Yahoo 股市、
# udn.com 一般新聞等），或 web_search 索引延遲導致 news_summary.py 撲空／抓到
# 錯月份。此時可人工把正確的摘要與來源直接寫進月份 JSON。
#
# 寫入的 entry 會標記 news_manual=true，news_summary.py 於一般執行與 --force 時
# 都會跳過（不覆蓋人工內容），除非明確加 --override-manual。
#
# 用法：
#   # 摘要文字從檔案讀入（建議；可含換行、粗體標題）
#   python manual_news.py --code 2891 --period 115/06 \
#       --summary-file summary.txt \
#       --source "https://tw.stock.yahoo.com/news/xxx|中信金上半年賺395億 | Yahoo股市" \
#       --source "https://money.udn.com/money/story/xxx"
#
#   # 摘要文字從 stdin 讀入
#   cat summary.txt | python manual_news.py --code 2886 --source "https://udn.com/..."
#
#   # 直接用參數帶入短摘要
#   python manual_news.py --code 2885 --summary "**重點**..." --source "https://..."
#
# --source 值格式：`URL` 或 `URL|標題`（以第一個 | 分隔；標題本身可含 |）。
# 摘要會套用 news_summary.normalize_summary 統一格式（兩段式模板）。

import os
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from news_summary import normalize_summary  # noqa: E402

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"


def _parse_source(raw):
    """`URL` 或 `URL|標題` → {'url':..., 'title':...}。無標題時 title = URL。"""
    raw = raw.strip()
    if "|" in raw:
        url, title = raw.split("|", 1)
        url, title = url.strip(), title.strip()
    else:
        url, title = raw, ""
    return {"url": url, "title": title or url}


def _sync_other(period_file, period, data):
    """latest.json ↔ 對應月份歸檔互相同步（與 news_summary.py 同邏輯）。"""
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
    ap = argparse.ArgumentParser(description="手動補金控新聞摘要")
    ap.add_argument("--code", required=True, help="金控代號，例 2891")
    ap.add_argument("--period", default=None, help="民國年/月，例 115/06；預設用 latest.json")
    ap.add_argument("--summary", default=None, help="摘要文字（直接帶入）")
    ap.add_argument("--summary-file", default=None, help="摘要文字檔路徑（UTF-8）")
    ap.add_argument("--source", action="append", default=[], help="來源，`URL` 或 `URL|標題`，可重複")
    args = ap.parse_args()

    # 取得摘要文字：--summary > --summary-file > stdin
    if args.summary is not None:
        summary_raw = args.summary
    elif args.summary_file:
        summary_raw = Path(args.summary_file).read_text(encoding="utf-8")
    elif not sys.stdin.isatty():
        summary_raw = sys.stdin.read()
    else:
        ap.error("需提供摘要：--summary / --summary-file / stdin 三擇一")

    summary = normalize_summary(summary_raw)
    if not summary:
        ap.error("摘要為空")

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
    if company is None:
        print(f"代號 {args.code} 不在 {period_file.name}", file=sys.stderr)
        sys.exit(1)
    if company.get("error"):
        print(
            f"警告：{args.code} {company.get('name')} 目前為 error 狀態"
            f"（{company.get('error_msg')}）；月損益尚未入檔，仍寫入摘要但表格不會顯示該家。",
            file=sys.stderr,
        )

    company["news_summary"] = summary
    company["news_sources"] = [_parse_source(s) for s in args.source]
    company["news_generated_at"] = datetime.now().isoformat()
    company["news_manual"] = True
    company.pop("news_retry_count", None)

    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(
        f"[{args.code} {company.get('name')}] manual summary written to {period_file.name} "
        f"({len(summary)} chars, {len(args.source)} sources)"
    )
    _sync_other(period_file, period, data)


if __name__ == "__main__":
    main()
