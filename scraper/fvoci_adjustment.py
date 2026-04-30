# fvoci_adjustment.py
# 為壽險金控的壽險子公司補上「加上 FVOCI 股票處份利益的調整後累計獲利」欄位。
#
# 背景：2026 年起接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年
# 同期可比，富邦、凱基等金控會在新聞稿揭露「加計 FVOCI 處份利益後的調整
# 後獲利」。本腳本透過 Claude API + web_search 抓出該數字，並推算到旗下
# 壽險子公司（金控差額 = adjusted - 原始 P&L → 假設全數來自壽險子公司）。
#
# 寫入 subsidiaries[*].fvoci_adjusted = {
#   "cumulative_profit": <NT$m>,
#   "source_url": "...", "source_quote": "...",
#   "delta_from_holding": <NT$m>,    # 用以追蹤推算過程
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

ALLOWED_DOMAINS = ["ctee.com.tw", "money.udn.com", "news.cnyes.com"]
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


def _build_prompt(name, code, period, holding_cumul, life_sub_name):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)

    return f"""你是台灣金融分析師。請查詢「{name}（{code}）」**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞，找出該金控揭露的「**加計 FVOCI 股票處份利益後的累計調整後獲利**」。

搜尋限制：工商時報、經濟日報、鉅亨網（已透過 allowed_domains 限制，不必加 site:）。

【背景】
2026 年起壽險公司接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年同期（2025 年仍計入 P&L）可比，部分金控（如 {name}）會在月損益新聞稿揭露「加計 FVOCI 處份利益後的調整後累計獲利」。此金控旗下有壽險子公司「{life_sub_name}」。

【已知數字】
- {name} {western_year}/{m:02d} 累計合併稅後淨利：{holding_cumul} 百萬元（原始 P&L）
- 我要找的是：**累計加計 FVOCI 處份利益後**的金控數字（理論上應大於原始 P&L）

【搜尋查詢建議】
1. `{name} {m}月 加計FVOCI 調整後獲利`
2. `{name} {m}月 累計 FVOCI股票處份利益`
3. `{name} {western_year} {m}月 自結 調整後`

【輸出格式（嚴格 JSON，無前言、無後綴、無 markdown 標記）】

若搜尋到該金控明確揭露之「加計 FVOCI 處份利益」後的累計獲利數字：
{{
  "found": true,
  "adjusted_cumulative_nt_million": <number>,
  "original_value_text": "<新聞中原始的數字與單位，例 '345.6 億元' 或 '34,560 百萬元'>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字>"
}}

若新聞未揭露 / 該金控本期未公布調整後獲利：
{{
  "found": false,
  "reason": "<簡短說明>"
}}

【硬性規則】
- 只能引用搜尋結果中實際出現的數字，禁止瞎編或推算
- 數字單位轉換：億 → ×100；元（罕見）→ ÷1,000,000；皆換算成「百萬元」填入 adjusted_cumulative_nt_million
- adjusted_cumulative_nt_million 必須大於 {holding_cumul}（加計處份利益會更大）；若搜到的「調整後」反而較小，可能是其他概念（例如剔除一次性損失），視為 found=false
- 若僅有「壽險公司」單獨的調整後數字（非金控），仍可接受—但 source_quote 要清楚標示
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


def fetch_one(client, name, code, period, holding_cumul, life_sub_name, debug=False):
    """呼叫 Claude API + web_search，遇 429 退避重試最多 3 次"""
    import anthropic as _anthropic
    prompt = _build_prompt(name, code, period, holding_cumul, life_sub_name)
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

    if life_sub.get("fvoci_adjusted") and not force:
        logger.info(f"[{name}] already has fvoci_adjusted, skip")
        return "skipped"

    h = company.get("holding_company", {})
    holding_cumul = h.get("cumulative_profit")
    if holding_cumul is None:
        logger.warning(f"[{name}] no holding cumulative_profit, cannot derive adjustment")
        return "failed"

    life_sub_name = life_sub.get("name", "壽險子公司")
    logger.info(f"[{name}] fetching FVOCI adjustment for {life_sub_name}...")

    try:
        parsed, raw = fetch_one(client, name, code, period, holding_cumul, life_sub_name, debug=debug)
    except Exception as e:
        logger.error(f"[{name}] LLM call failed: {e}")
        return "failed"

    if not parsed:
        logger.warning(f"[{name}] could not parse JSON from response: {raw[:200]}")
        return "failed"

    if not parsed.get("found"):
        reason = parsed.get("reason", "")
        logger.info(f"[{name}] not found: {reason}")
        return "not_found"

    adjusted_holding = parsed.get("adjusted_cumulative_nt_million")
    if not isinstance(adjusted_holding, (int, float)):
        logger.warning(f"[{name}] invalid adjusted_cumulative_nt_million: {adjusted_holding}")
        return "failed"

    if adjusted_holding <= holding_cumul:
        logger.warning(
            f"[{name}] adjusted ({adjusted_holding}) <= original ({holding_cumul}), "
            f"discarding (likely wrong concept)"
        )
        return "not_found"

    delta = adjusted_holding - holding_cumul

    # 取得壽險子公司原始累計，加上 delta = 推算後的調整後獲利
    life_cumul = life_sub.get("cumulative_profit")
    if life_cumul is None:
        logger.warning(f"[{name}] life sub has no cumulative_profit, cannot derive adjustment")
        return "failed"

    life_sub["fvoci_adjusted"] = {
        "cumulative_profit": round(life_cumul + delta, 1),
        "delta_from_holding": round(delta, 1),
        "source_url": parsed.get("source_url", ""),
        "source_quote": parsed.get("source_quote", ""),
        "original_value_text": parsed.get("original_value_text", ""),
        "generated_at": datetime.now().isoformat(),
    }
    logger.info(
        f"[{name}] {life_sub_name} adjusted: {life_cumul} + {delta} = "
        f"{life_sub['fvoci_adjusted']['cumulative_profit']} NT$m"
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
            already = life_sub and life_sub.get("fvoci_adjusted") and not args.force
            if life_sub and not already:
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
