# fvoci_adjustment.py
# 為壽險金控的壽險子公司補上「加上 FVOCI 股票處份利益的調整後累計獲利」欄位。
#
# 背景：2026 年起接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年
# 同期可比，富邦、凱基等金控會在月損益新聞稿直接揭露**壽險子公司本身**
# （富邦人壽、凱基人壽）「加計 FVOCI 處份利益後的累計調整後獲利」。
#
# 本腳本透過 Claude API + web_search 直接抓壽險子公司的調整後累計獲利數字。
# （舊版透過金控差額推算，但金控合併 P&L 包含其他子公司、少數權益、
#  內部交易抵銷，差額不等於壽險的 FVOCI 處份利益，已停用。）
#
# 寫入 subsidiaries[*].fvoci_adjusted = {
#   "cumulative_profit": <NT$m>,        # 直接從新聞抓到的壽險公司累計調整後獲利
#   "delta_vs_original": <NT$m>,        # cumulative_profit - 壽險原始累計 P&L（純紀錄）
#   "source_url": "...", "source_quote": "...",
#   "original_value_text": "...",
#   "generated_at": "..."
# }
# YoY 由 main.compute_yoy 統一計算（呼叫於本腳本尾端）。
#
# 冪等：已有 fvoci_adjusted 的子公司預設跳過；--force 才重做。

import os
import sys
import json
import re
import time
import logging
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("scraper.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "docs" / "data"

ALLOWED_DOMAINS = ["ctee.com.tw", "money.udn.com", "news.cnyes.com", "ec.ltn.com.tw"]
MODEL = "claude-sonnet-4-6"

# 有壽險子公司的金控代號（IFRS 17 適用）
LIFE_INSURANCE_CODES = {"2881", "2882", "2883", "2887", "2891"}


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


def _extract_source_date(url):
    """從新聞 URL 嘗試解析發布日期 (date)。
    ctee.com.tw 的 `/news/YYYYMMDD...` 可解析；其他來源 URL 多無日期 → 回傳 None
    （無法驗證就不阻擋，維持原行為）。"""
    if not url:
        return None
    m = re.search(r"/news/(\d{8})", url)  # ctee: /news/20260529701945-430301
    if not m:
        # 一般性 fallback：路徑中獨立的 8 碼 YYYYMMDD（20xx 開頭）
        m = re.search(r"(?<!\d)(20\d{6})(?!\d)", url)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d").date()
    except ValueError:
        return None


def _announcement_month_start(period):
    """目標月份 N → 公告月份 N+1 的第一天 (date)。例 115/05 → 2026-06-01。
    （月自結損益於次月公告，公告月份之前的新聞必為事前預估，不可採信。）"""
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    if m < 12:
        return datetime(western_year, m + 1, 1).date()
    return datetime(western_year + 1, 1, 1).date()


def _build_prompt(name, code, period, life_sub_name, life_cumul):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)

    return f"""你是台灣金融分析師。請查詢「**{life_sub_name}**」（{name} {code} 旗下壽險子公司）**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞，找出**{life_sub_name} 本身**揭露的「**加計 FVOCI 股票處份利益後的累計調整後獲利**」。

搜尋限制：工商時報、經濟日報、鉅亨網、自由財經（已透過 allowed_domains 限制，不必加 site:）。

【背景】
2026 年起壽險公司接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年同期可比，富邦、凱基等金控會在月損益新聞稿**直接揭露壽險子公司本身**的「加計 FVOCI 處份利益後的累計調整後獲利」。

⚠️ 本任務要找的是「**{life_sub_name}**」這家壽險公司**自己**的累計調整後獲利，**不是**金控（{name}）合併層級的調整後獲利。新聞通常會兩個都列，但你必須抓壽險公司的那個。

【參考新聞語句範例】
- 「富邦人壽：累計第一季稅後純益151.2億元；…加計FVOCI股票處分損益後，…累計首季調整後獲利為472.8億」
- 「凱基人壽：…累計今年前三月，凱基人壽整體調整後獲利已達190.25億元」

【已知數字（壽險子公司原始累計）】
- {life_sub_name} {western_year}/{m:02d} 累計稅後淨利（原始 P&L）：{life_cumul} 百萬元
- 我要找的是：{life_sub_name} 累計**加計 FVOCI 處份利益後**的調整後獲利（理論上應大於原始 P&L）

【搜尋查詢建議】
1. `{life_sub_name} {m}月 累計 加計FVOCI 調整後獲利`
2. `{life_sub_name} {western_year} {m}月 累計 調整後獲利 億元`
3. `{life_sub_name} 首季 調整後獲利`（若 m=3）

【輸出格式（嚴格 JSON，無前言、無後綴、無 markdown 標記）】

若搜尋到 {life_sub_name} **本身**明確揭露之「加計 FVOCI 處份利益」後的累計獲利數字：
{{
  "found": true,
  "adjusted_cumulative_nt_million": <number>,
  "original_value_text": "<新聞中原始的數字與單位，例 '472.8 億元'>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字與「{life_sub_name}」公司名稱>"
}}

若新聞僅揭露金控合併層級調整後獲利、未揭露壽險子公司本身的調整後獲利：
{{
  "found": false,
  "reason": "<簡短說明>"
}}

【硬性規則】
- 只能引用搜尋結果中實際出現的數字，禁止瞎編或推算
- 數字必須是「{life_sub_name}」這家壽險公司**自己**的累計調整後獲利，不是金控合併層級的數字。source_quote 必須清楚帶有「{life_sub_name}」字樣
- 數字單位轉換：億 → ×100；皆換算成「百萬元」填入 adjusted_cumulative_nt_million
- adjusted_cumulative_nt_million 必須大於 {life_cumul}（加計處份利益會更大）；若搜到的「調整後」反而較小，可能抓錯數字，視為 found=false
- 不要使用 markdown code fence；直接輸出 JSON 物件
"""


def _extract_json(response):
    """
    從 Claude response.content 抽出最終文字，並嘗試 parse JSON。
    回傳 (parsed_dict_or_None, raw_text)
    """
    text_parts = []
    for block in response.content:
        if getattr(block, "type", "") == "text":
            text_parts.append(block.text)
    raw = "\n".join(text_parts).strip()
    if not raw:
        return None, raw

    # 移除可能的 ```json ... ``` 包裹
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()

    # 找到第一個 {...} 區塊（LLM 偶爾會加前言）
    m = re.search(r"\{[\s\S]*\}", cleaned)
    if not m:
        return None, raw
    try:
        return json.loads(m.group(0)), raw
    except json.JSONDecodeError:
        return None, raw


def fetch_one(client, name, code, period, life_sub_name, life_cumul, debug=False):
    """呼叫 Claude API + web_search，遇 429 退避重試最多 3 次"""
    import anthropic as _anthropic
    prompt = _build_prompt(name, code, period, life_sub_name, life_cumul)
    last_err = None
    for attempt in range(3):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=1024,
                tools=[{
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": 3,
                    "allowed_domains": ALLOWED_DOMAINS,
                }],
                messages=[{"role": "user", "content": prompt}],
            )
            parsed, raw = _extract_json(response)
            if debug:
                logger.info(f"[{name}] raw: {raw[:300]}")
            return parsed, raw
        except _anthropic.RateLimitError as e:
            last_err = e
            wait = 65 * (attempt + 1)
            logger.warning(f"[{name}] Rate limit hit, wait {wait}s and retry ({attempt+1}/3)")
            time.sleep(wait)
    raise last_err


def find_life_subsidiary(subs):
    """從子公司清單找出壽險公司（名稱含「人壽」）"""
    for s in subs:
        if "人壽" in (s.get("name") or ""):
            return s
    return None


def process_company(client, company, period, force=False, debug=False):
    """
    對單一金控公司處理 FVOCI 調整後獲利。
    回傳 'updated' / 'skipped' / 'not_found' / 'no_life_sub' / 'failed'。
    """
    code = company.get("code", "")
    name = company.get("name", "")

    if "error" in company:
        return "skipped"
    if code not in LIFE_INSURANCE_CODES:
        return "skipped"

    subs = company.get("subsidiaries", [])
    life_sub = find_life_subsidiary(subs)
    if not life_sub:
        logger.info(f"[{name}] no life subsidiary found")
        return "no_life_sub"

    # 跳過條件（除非 --force）：
    #   1. 已有 fvoci_adjusted（成功）→ skip
    #   2. 嘗試過 N 次都 not_found → permanently skip（避免無限燒 token）
    if not force:
        if life_sub.get("fvoci_adjusted"):
            logger.info(f"[{name}] already has fvoci_adjusted, skip")
            return "skipped"
        not_found_count = life_sub.get("fvoci_not_found_count", 0)
        if not_found_count >= 3:
            logger.info(
                f"[{name}] fvoci adjustment not found (retried {not_found_count}x), "
                f"permanently skip"
            )
            return "skipped"

    life_cumul = life_sub.get("cumulative_profit")
    if life_cumul is None:
        logger.warning(f"[{name}] life sub has no cumulative_profit, cannot derive adjustment")
        return "failed"

    life_sub_name = life_sub.get("name", "壽險子公司")
    logger.info(f"[{name}] fetching FVOCI adjustment for {life_sub_name}...")

    try:
        parsed, raw = fetch_one(client, name, code, period, life_sub_name, life_cumul, debug=debug)
    except Exception as e:
        logger.error(f"[{name}] LLM call failed: {e}")
        return "failed"

    if not parsed:
        logger.warning(f"[{name}] could not parse JSON from response: {raw[:200]}")
        return "failed"

    if not parsed.get("found"):
        reason = parsed.get("reason", "")
        new_count = life_sub.get("fvoci_not_found_count", 0) + 1
        life_sub["fvoci_not_found_count"] = new_count
        logger.info(f"[{name}] not found (retry {new_count}/3): {reason}")
        return "not_found"

    adjusted_life = parsed.get("adjusted_cumulative_nt_million")
    if not isinstance(adjusted_life, (int, float)):
        logger.warning(f"[{name}] invalid adjusted_cumulative_nt_million: {adjusted_life}")
        return "failed"

    if adjusted_life <= life_cumul:
        new_count = life_sub.get("fvoci_not_found_count", 0) + 1
        life_sub["fvoci_not_found_count"] = new_count
        logger.warning(
            f"[{name}] adjusted ({adjusted_life}) <= life original ({life_cumul}), "
            f"discarding (likely wrong concept or抓到金控數字) (retry {new_count}/3)"
        )
        return "not_found"

    # 來源日期防呆：公告月份之前的新聞必為「事前預估／掌握」稿，非實際月自結數字
    # （例：5/29 即報「前5月國壽調整後800億」，其實是記者推估，國泰公告本身不揭露 FVOCI 調整後獲利）。
    # 要求來源發布日 >= 公告月份第一天；URL 無日期者無法驗證，維持原行為放行。
    src_date = _extract_source_date(parsed.get("source_url", ""))
    ann_start = _announcement_month_start(period)
    if src_date and src_date < ann_start:
        new_count = life_sub.get("fvoci_not_found_count", 0) + 1
        life_sub["fvoci_not_found_count"] = new_count
        logger.warning(
            f"[{name}] source dated {src_date} < announcement month start {ann_start} "
            f"(pre-announcement estimate), discarding (retry {new_count}/3)"
        )
        return "not_found"

    delta_vs_original = adjusted_life - life_cumul

    life_sub["fvoci_adjusted"] = {
        "cumulative_profit": round(adjusted_life, 1),
        "delta_vs_original": round(delta_vs_original, 1),
        "source_url": parsed.get("source_url", ""),
        "source_quote": parsed.get("source_quote", ""),
        "original_value_text": parsed.get("original_value_text", ""),
        "generated_at": datetime.now().isoformat(),
    }
    # 找到後清除 retry counter（不再需要）
    life_sub.pop("fvoci_not_found_count", None)
    logger.info(
        f"[{name}] {life_sub_name} adjusted (direct): {adjusted_life} NT$m "
        f"(original {life_cumul}, +{delta_vs_original})"
    )
    return "updated"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--period",
        help="目標月份 民國年/月，例 115/03。預設讀 latest.json",
        default=None,
    )
    ap.add_argument("--codes", nargs="+", help="只處理特定代號", default=None)
    ap.add_argument("--force", action="store_true", help="強制重新生成（即使已有 fvoci_adjusted）")
    ap.add_argument(
        "--inter-call-sleep", type=int, default=30,
        help="每家之間 sleep 秒數（避開 rate limit），預設 30",
    )
    ap.add_argument("--debug", action="store_true", help="印出 LLM raw response")
    args = ap.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)

    try:
        import anthropic
    except ImportError:
        logger.error("anthropic package not installed")
        sys.exit(1)
    client = anthropic.Anthropic(api_key=api_key)

    if args.period:
        period_file = DATA_DIR / f"{args.period.replace('/', '-')}.json"
    else:
        period_file = DATA_DIR / "latest.json"

    if not period_file.exists():
        logger.error(f"File not found: {period_file}")
        sys.exit(1)

    with open(period_file, encoding="utf-8") as f:
        data = json.load(f)

    period = data.get("report_period", "")
    companies = data.get("companies", [])
    logger.info(f"Processing FVOCI adjustment for {period} ({len(companies)} companies)")

    counts = {"updated": 0, "skipped": 0, "not_found": 0, "no_life_sub": 0, "failed": 0}
    api_calls = 0
    for company in companies:
        if args.codes and company.get("code") not in args.codes:
            continue

        # 第二次 API call 起 sleep（避開 rate limit）
        if api_calls > 0 and company.get("code") in LIFE_INSURANCE_CODES:
            life_sub = find_life_subsidiary(company.get("subsidiaries", []))
            will_skip = life_sub and not args.force and (
                bool(life_sub.get("fvoci_adjusted"))
                or life_sub.get("fvoci_not_found_count", 0) >= 3
            )
            if life_sub and not will_skip:
                logger.info(f"Sleeping {args.inter_call_sleep}s before next call...")
                time.sleep(args.inter_call_sleep)

        result = process_company(client, company, period, force=args.force, debug=args.debug)
        counts[result] = counts.get(result, 0) + 1
        if result in ("updated", "not_found", "failed"):
            api_calls += 1

    # 計算 / 補上 YoY（包含 fvoci_adjusted 的 yoy_pct）
    try:
        from main import compute_yoy
        compute_yoy(data, period)
    except Exception as e:
        logger.warning(f"compute_yoy failed: {e}")

    # 寫回原檔
    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(
        f"Saved {period_file.name}: updated={counts['updated']}, "
        f"not_found={counts['not_found']}, no_life_sub={counts['no_life_sub']}, "
        f"skipped={counts['skipped']}, failed={counts['failed']}"
    )

    # 同步 latest.json ↔ 對應月份歸檔
    archive_path = DATA_DIR / f"{period.replace('/', '-')}.json" if period else None
    latest_path = DATA_DIR / "latest.json"
    other = archive_path if period_file.name == "latest.json" else latest_path
    if other and other != period_file:
        write_other = True
        if other.exists() and other != latest_path:
            with open(other, encoding="utf-8") as f:
                if json.load(f).get("report_period") != period:
                    write_other = False
        if write_other:
            with open(other, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            logger.info(f"Also synced {other.name}")


if __name__ == "__main__":
    main()
