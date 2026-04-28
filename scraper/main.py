# main.py
# 主程式：整合爬蟲與解析器，產生 data/latest.json 及月份歸檔

import os
import sys
import json
import logging
import argparse
from datetime import datetime, timedelta
from pathlib import Path

# 確保可以 import 同目錄模組
sys.path.insert(0, str(Path(__file__).parent))

from companies import FINANCIAL_HOLDINGS, ANNOUNCEMENT_KEYWORDS, HOLDINGS_BY_CODE
from mops_client import MopsClient, gregorian_to_roc
from parser import parse_profit_announcement, find_profit_announcement

# ── 日誌設定 ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("scraper.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ── 路徑設定 ─────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"
DATA_DIR.mkdir(exist_ok=True)


def _load_dotenv():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()


# ── 工具函數 ─────────────────────────────────────────────

def get_target_month(offset_months: int = 1) -> tuple[str, datetime]:
    """
    取得目標報告月份。
    offset_months=1 表示上個月（4月公告的是3月數據）。
    回傳 (民國年/月字串, datetime)
    """
    now = datetime.now()
    # 往回推 offset_months 個月
    first_of_current = now.replace(day=1)
    target = first_of_current - timedelta(days=offset_months * 28)
    target = target.replace(day=1)
    roc_month = f"{target.year - 1911:03d}/{target.month:02d}"
    return roc_month, target


def get_search_date_range(target_dt: datetime) -> tuple[datetime, datetime]:
    """
    取得搜尋日期區間。

    金控公告規律：N 月的損益，在 N+1 月的 8~15 日公告。
    因此搜尋「target_dt 的下一個月」的 1~20 日。

    例如：target_dt = 2026-03（找3月資料）
         → 搜尋 2026-04-01 ~ 2026-04-20
    """
    # 算出公告月份（target 的下一個月）
    if target_dt.month == 12:
        pub_year, pub_month = target_dt.year + 1, 1
    else:
        pub_year, pub_month = target_dt.year, target_dt.month + 1

    date_start = datetime(pub_year, pub_month, 1)

    # 結束日：若公告月份就是當前月份，用今天；否則用該月 20 日
    now = datetime.now()
    if pub_year == now.year and pub_month == now.month:
        date_end = now
    else:
        date_end = datetime(pub_year, pub_month, 20)

    return date_start, date_end


def load_existing_data() -> dict:
    """載入現有的 latest.json"""
    latest_path = DATA_DIR / "latest.json"
    if latest_path.exists():
        with open(latest_path, encoding="utf-8") as f:
            return json.load(f)
    return {"report_period": "", "last_updated": "", "companies": []}


def save_data(data: dict, report_period: str):
    """儲存到 latest.json 及月份歸檔。會保留既有檔案的 market_summary 欄位。"""
    # 月份歸檔：115-03.json
    period_filename = report_period.replace("/", "-") + ".json"
    archive_path = DATA_DIR / period_filename

    # 保留既有 market_summary（由 market_summary.py 預先寫入，不應被 MOPS 覆蓋）
    if archive_path.exists():
        try:
            with open(archive_path, encoding="utf-8") as f:
                old = json.load(f)
            if "market_summary" in old and "market_summary" not in data:
                data["market_summary"] = old["market_summary"]
        except Exception as e:
            logger.warning(f"Failed to preserve market_summary from {period_filename}: {e}")

    # latest.json：同樣保留 market_summary（若指向同一期）
    latest_path = DATA_DIR / "latest.json"
    if latest_path.exists():
        try:
            with open(latest_path, encoding="utf-8") as f:
                old_latest = json.load(f)
            if (old_latest.get("report_period") == report_period
                    and "market_summary" in old_latest
                    and "market_summary" not in data):
                data["market_summary"] = old_latest["market_summary"]
        except Exception as e:
            logger.warning(f"Failed to preserve market_summary from latest.json: {e}")

    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"Saved latest.json")

    with open(archive_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"Saved archive {period_filename}")

    # 更新月份索引
    update_index(data, report_period)


def compute_yoy(data: dict, target_period: str):
    """
    讀去年同期歸檔，計算 holding_company.cumulative_profit 的 YoY 變化（%），
    寫入 cumulative_profit_yoy_pct 欄位（M&A 期間 / 缺資料則略過）。

    公式：(curr - prev) / abs(prev) × 100
    """
    # 合併日期 → 第一個可算 YoY 的目標月份。target_period < cutoff 時略過此公司。
    # 例：2887 合併於 2025/07，114/07 起為合併後資料 → 115/07 起才能對齊 YoY。
    YOY_CUTOFFS = {
        "2887": "115/07",  # 台新新光金（台新金+新光金合併於 2025-07-24）
    }

    roc_year, roc_month = target_period.split("/")
    prev_year = int(roc_year) - 1
    prev_period = f"{prev_year:03d}/{roc_month}"
    baseline_file = DATA_DIR / f"{prev_period.replace('/', '-')}.json"

    if not baseline_file.exists():
        logger.info(f"YoY baseline {baseline_file.name} not found, skipping YoY")
        return

    try:
        with open(baseline_file, encoding="utf-8") as f:
            baseline = json.load(f)
    except Exception as e:
        logger.warning(f"Failed to read YoY baseline {baseline_file.name}: {e}")
        return

    baseline_by_code = {c["code"]: c for c in baseline.get("companies", []) if "code" in c}
    populated = 0
    skipped_merger = 0

    for company in data.get("companies", []):
        if "error" in company:
            continue
        code = company.get("code", "")
        cutoff = YOY_CUTOFFS.get(code)
        if cutoff and target_period < cutoff:
            skipped_merger += 1
            continue
        prev = baseline_by_code.get(code)
        if not prev or "error" in prev:
            continue
        curr_cumul = company.get("holding_company", {}).get("cumulative_profit")
        prev_cumul = prev.get("holding_company", {}).get("cumulative_profit")
        if curr_cumul is None or prev_cumul is None or prev_cumul == 0:
            continue
        yoy = (curr_cumul - prev_cumul) / abs(prev_cumul) * 100
        company["holding_company"]["cumulative_profit_yoy_pct"] = round(yoy, 1)
        populated += 1

    msg = f"YoY populated for {populated} companies (baseline: {prev_period})"
    if skipped_merger:
        msg += f"; skipped {skipped_merger} due to M&A cutoff"
    logger.info(msg)


def update_index(data: dict, report_period: str):
    """
    更新 data/index.json，記錄所有可用月份。
    格式：
    {
      "latest": "115/03",
      "months": [
        {"period":"115/03","file":"115-03.json","success_count":12,"last_updated":"..."},
        ...
      ]
    }
    月份依新到舊排序。
    """
    index_path = DATA_DIR / "index.json"

    if index_path.exists():
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)
    else:
        index = {"latest": "", "months": []}

    period_file = report_period.replace("/", "-") + ".json"
    entry = {
        "period": report_period,
        "file": period_file,
        "success_count": data.get("success_count", 0),
        "last_updated": data.get("last_updated", ""),
    }

    # 更新既有紀錄或新增
    if any(m["period"] == report_period for m in index["months"]):
        index["months"] = [
            entry if m["period"] == report_period else m
            for m in index["months"]
        ]
    else:
        index["months"].append(entry)

    # 依民國年/月降序排列（新的在前）
    index["months"].sort(key=lambda m: m["period"], reverse=True)
    index["latest"] = index["months"][0]["period"] if index["months"] else ""

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    logger.info(f"Updated index.json: {len(index['months'])} months available")


# ── 核心爬取邏輯 ─────────────────────────────────────────

def scrape_company(
    client: MopsClient,
    company: dict,
    target_month: str,
    date_start: datetime,
    date_end: datetime,
    api_key: str,
) -> dict:
    """
    爬取單一金控公司的月自結損益公告。
    回傳標準化結構，失敗時回傳包含 error 的 dict。
    """
    code = company["code"]
    name = company["name"]

    logger.info(f"=== Processing {name} ({code}) ===")

    # 1. 取得公告清單
    announcements = client.get_announcements(code, date_start, date_end)

    if not announcements:
        logger.warning(f"[{name}] No announcements found in date range")
        # 嘗試擴大搜尋範圍（前後 60 天）
        extended_start = date_start - timedelta(days=60)
        announcements = client.get_announcements(code, extended_start, date_end)

    if not announcements:
        return {
            "code": code,
            "name": name,
            "error": "no_announcements",
            "error_msg": "查無公告",
        }

    # 2. 找到目標公告
    ann = find_profit_announcement(announcements, ANNOUNCEMENT_KEYWORDS, target_month)

    if ann is None:
        # 寬鬆搜尋：不限月份
        ann = find_profit_announcement(announcements, ANNOUNCEMENT_KEYWORDS, None)

    if ann is None:
        logger.warning(f"[{name}] No profit announcement matched")
        return {
            "code": code,
            "name": name,
            "error": "no_match",
            "error_msg": f"找不到 {target_month} 月自結損益公告",
            "available_titles": [a["title"] for a in announcements[:5]],
        }

    # 3. 取得公告詳細 HTML
    seq_no = ann.get("seq_no", "")
    if not seq_no:
        logger.warning(f"[{name}] No seq_no found in announcement")
        return {
            "code": code,
            "name": name,
            "error": "no_seq_no",
            "announcement": ann,
        }

    detail_html = client.get_announcement_detail(
        code,
        seq_no,
        spoke_time=ann.get("spoke_time", ""),
        spoke_date=ann.get("spoke_date", ""),
        typek=ann.get("typek", "sii"),
        date=ann.get("date", ""),
    )

    if not detail_html:
        return {
            "code": code,
            "name": name,
            "error": "fetch_failed",
            "error_msg": "無法取得公告內容",
        }

    # 4. 解析財務數據
    parsed = parse_profit_announcement(detail_html, name, api_key)

    if parsed is None:
        return {
            "code": code,
            "name": name,
            "error": "parse_failed",
            "error_msg": "無法解析公告內容",
            "announcement_title": ann.get("title"),
            "announcement_date": ann.get("date"),
        }

    # 5. 組裝結果
    result = {
        "code": code,
        "name": name,
        "announcement_date": ann.get("date"),
        "announcement_title": ann.get("title"),
        "source_url": (
            f"https://mops.twse.com.tw/mops/web/t05st02"
            f"?co_id={code}&seq_no={seq_no}&TYPEK=all"
        ),
        **parsed,
    }

    # 確保有 report_month
    if "report_month" not in result:
        result["report_month"] = target_month

    logger.info(
        f"[{name}] OK - 當月: {result.get('holding_company', {}).get('monthly_profit')} "
        f"累計: {result.get('holding_company', {}).get('cumulative_profit')}"
    )
    return result


# ── 主流程 ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="台灣金控月自結損益爬蟲")
    parser.add_argument(
        "--codes",
        nargs="+",
        help="指定公司代號（預設全部13家）",
        default=None,
    )
    parser.add_argument(
        "--month",
        help="指定目標月份，格式：115/03（預設：自動偵測上個月）",
        default=None,
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="禁用 LLM 兜底解析",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=3.0,
        help="請求間隔秒數（預設 3.0）",
    )
    args = parser.parse_args()

    # API Key
    api_key = None if args.no_llm else os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and not args.no_llm:
        logger.warning("ANTHROPIC_API_KEY not set, LLM fallback disabled")

    # 目標月份
    if args.month:
        target_month = args.month
        # 解析民國年/月
        roc_year, roc_m = target_month.split("/")
        target_dt = datetime(int(roc_year) + 1911, int(roc_m), 1)
    else:
        target_month, target_dt = get_target_month(offset_months=1)

    logger.info(f"Target month: {target_month}")

    # 搜尋日期區間（target_dt 的下一個月，即公告發布月份）
    date_start, date_end = get_search_date_range(target_dt)
    logger.info(f"Search range: {date_start.date()} ~ {date_end.date()}")

    # 篩選公司
    companies_to_scrape = FINANCIAL_HOLDINGS
    if args.codes:
        companies_to_scrape = [
            c for c in FINANCIAL_HOLDINGS if c["code"] in args.codes
        ]
        logger.info(f"Filtering to: {[c['name'] for c in companies_to_scrape]}")

    # 初始化 client
    client = MopsClient(delay_range=(args.delay, args.delay + 2.0))

    # 載入現有數據（增量更新）
    existing = load_existing_data()
    existing_by_code = {c["code"]: c for c in existing.get("companies", [])}

    # 執行爬取
    results = []
    success_count = 0
    fail_count = 0

    for company in companies_to_scrape:
        try:
            result = scrape_company(
                client, company, target_month,
                date_start, date_end, api_key
            )
            results.append(result)
            if "error" not in result:
                success_count += 1
            else:
                fail_count += 1
                logger.warning(f"[{company['name']}] Failed: {result.get('error_msg')}")
        except Exception as e:
            logger.error(f"[{company['name']}] Unexpected error: {e}", exc_info=True)
            results.append({
                "code": company["code"],
                "name": company["name"],
                "error": "exception",
                "error_msg": str(e),
            })
            fail_count += 1

    # 合併：沿用已成功的舊數據（若這次失敗）
    final_companies = []
    result_by_code = {r["code"]: r for r in results}
    all_codes = {c["code"] for c in FINANCIAL_HOLDINGS}

    for code in [c["code"] for c in FINANCIAL_HOLDINGS]:
        new_result = result_by_code.get(code)
        old_result = existing_by_code.get(code)

        if new_result and "error" not in new_result:
            # 重新爬取覆寫財報數字，但保留新聞摘要等不可重新生成的欄位
            if old_result:
                for k in ("news_summary", "news_sources", "news_generated_at"):
                    if k in old_result:
                        new_result[k] = old_result[k]
            final_companies.append(new_result)
        elif old_result and existing.get("report_period") == target_month:
            # 舊數據同一期間，沿用
            logger.info(f"[{HOLDINGS_BY_CODE[code]['name']}] Using cached data")
            final_companies.append(old_result)
        elif new_result:
            final_companies.append(new_result)

    # success_count 反映 final 結果（含 cache merge）的有效家數
    final_success = sum(1 for c in final_companies if "error" not in c)
    final_fail    = sum(1 for c in final_companies if "error" in c)

    # 建構輸出
    output = {
        "report_period": target_month,
        "last_updated": datetime.now().isoformat(),
        "success_count": final_success,
        "fail_count": final_fail,
        "companies": final_companies,
    }

    # 計算 YoY 變化（讀去年同期歸檔）
    compute_yoy(output, target_month)

    save_data(output, target_month)

    logger.info(
        "\n" + "="*50 + "\n"
        + f"完成！成功: {success_count} 家，失敗: {fail_count} 家\n"
        + "資料已儲存至 data/latest.json\n"
        + "="*50
    )

    # 如果有失敗，以非零 exit code 退出（讓 CI 知道有問題）
    if fail_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
