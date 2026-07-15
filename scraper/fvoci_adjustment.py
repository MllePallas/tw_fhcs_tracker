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
#   "cumulative_profit": <NT$m>,        # 直接從新聞抓到的壽險公司累計加計FVOCI後獲利
#   "monthly_profit": <NT$m>,           # 當月加計FVOCI後獲利（新聞有揭露才寫，可能缺）
#   "delta_vs_original": <NT$m>,        # cumulative_profit - 壽險原始累計 P&L（純紀錄）
#   "source_url": "...", "source_quote": "...",
#   "original_value_text": "...",
#   "generated_at": "..."
# }
#
# 用語備註（2026-07 起）：主管機關要求新聞稿不得使用「調整後獲利」一詞（與會計
# 原則不符）。各金控 115/06 損益新聞稿起改用：凱基／富邦「加計FVOCI（股票處分
# 損益）後獲利」；國泰「對保留盈餘影響數」。搜尋關鍵字需同時涵蓋新舊用語。
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


def _build_prompt(name, code, period, life_sub_name, life_cumul, life_monthly=None):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    monthly_line = (
        f"- {life_sub_name} {western_year}/{m:02d} 當月稅後淨利（原始 P&L）：{life_monthly} 百萬元"
        if life_monthly is not None else ""
    )

    return f"""你是台灣金融分析師。請查詢「**{life_sub_name}**」（{name} {code} 旗下壽險子公司）**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞，找出**{life_sub_name} 本身**揭露的「**加計 FVOCI 股票處份利益後的獲利**」——**累計數為必要目標，當月數若新聞有揭露也一併抓取**。

搜尋限制：工商時報、經濟日報、鉅亨網、自由財經（已透過 allowed_domains 限制，不必加 site:）。

【背景】
2026 年起壽險公司接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年同期可比，富邦、凱基等金控會在月損益新聞稿**直接揭露壽險子公司本身**的「加計 FVOCI 處份利益後的獲利」。

【重要：用語變更（2026年7月起）】
主管機關要求新聞稿**不得使用「調整後獲利」**一詞（與會計原則不符），各壽險公司自 2026 年 6 月損益（7 月發布）的新聞稿起改用新表述，搜尋時新舊用語都要涵蓋：
- 凱基人壽／富邦人壽等：「**加計FVOCI獲利**」「加計FVOCI（股票處分損益）後獲利」
- 國泰人壽：「**對保留盈餘影響數**」（加計 FVOCI 股票處分損益後對保留盈餘之影響）
- 2026 年 6 月以前的舊新聞才會用「調整後獲利」

⚠️ 本任務要找的是「**{life_sub_name}**」這家壽險公司**自己**的加計FVOCI後獲利，**不是**金控（{name}）合併層級的數字。新聞通常會兩個都列，但你必須抓壽險公司的那個。

【參考新聞語句範例】
- 「凱基人壽6月加計FVOCI獲利154.47億元，累計前6月加計FVOCI獲利為677.75億元」（→ 當月與累計都有）
- 「國泰人壽6月稅後純益113.7億元，累計稅後純益達462.4億元，加計FVOCI股票處分損益，累計前六月對保留盈餘影響數已突破1,300億元」（→ 累計為門檻型 lower_bound，當月未揭露）
- 舊用語（2026年6月前）：「富邦人壽…加計FVOCI股票處分損益後，…累計首季調整後獲利為472.8億」

【已知數字（壽險子公司原始 P&L）】
- {life_sub_name} {western_year}/{m:02d} 累計稅後淨利（原始 P&L）：{life_cumul} 百萬元
{monthly_line}
- 我要找的是：{life_sub_name} **加計 FVOCI 處份利益後**的累計獲利（理論上應大於原始累計 P&L），以及（若有揭露）當月加計 FVOCI 後獲利

【搜尋查詢建議】
1. `{life_sub_name} {m}月 加計FVOCI 獲利`
2. `{life_sub_name} 對保留盈餘影響數`
3. `{life_sub_name} {western_year} {m}月 FVOCI 億元`
4. `{life_sub_name} 累計 調整後獲利`（舊用語 fallback）

【輸出格式（嚴格 JSON，無前言、無後綴、無 markdown 標記）】

若搜尋到 {life_sub_name} **本身**明確揭露之加計 FVOCI 後累計獲利**具體數字**：
{{
  "found": true,
  "value_kind": "exact",
  "adjusted_cumulative_nt_million": <number>,
  "adjusted_monthly_nt_million": <number 或 null；新聞明確揭露「當月」加計FVOCI後獲利才填，否則 null>,
  "original_value_text": "<新聞中原始的數字與單位，例 '677.75 億元'>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字與「{life_sub_name}」公司名稱>"
}}

若 {life_sub_name} **本身**只揭露**區間/門檻**而非具體數字（例：國泰人壽「對保留盈餘影響數突破1,300億」「逾1,000億」「超過X億」），請回傳下界：
{{
  "found": true,
  "value_kind": "lower_bound",
  "adjusted_cumulative_nt_million": <門檻數值，百萬元，例 突破1,300億→130000>,
  "adjusted_monthly_nt_million": <number 或 null，同上>,
  "display_prefix": "<新聞用字：逾／突破／超過，擇一>",
  "original_value_text": "<新聞中原始字樣，例 '突破1,300億元'>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字與「{life_sub_name}」公司名稱>"
}}

若新聞僅揭露金控合併層級數字、未揭露壽險子公司本身的加計FVOCI後獲利：
{{
  "found": false,
  "reason": "<簡短說明>"
}}

【硬性規則】
- 只能引用搜尋結果中實際出現的數字，禁止瞎編或推算（當月數不可用「累計差額」自行回推）
- 數字必須是「{life_sub_name}」這家壽險公司**自己**的數字，不是金控合併層級。source_quote 必須清楚帶有「{life_sub_name}」字樣
- 「稅後純益」「稅後淨利」本身**不是**加計FVOCI後的數字，不要誤填；要找的是明確標示「加計FVOCI」「對保留盈餘影響數」（或舊稿「調整後獲利」）的數字
- 數字單位轉換：億 → ×100；皆換算成「百萬元」填入
- **value_kind 判定**：新聞給「具體精確數字」用 `exact`；只給「逾／突破／超過／上看 X 億」這類門檻、沒有精確值時用 `lower_bound`。有精確數字時一律用 exact，不要因為出現「逾」字就誤判
- adjusted_cumulative_nt_million 必須大於 {life_cumul}（加計處份利益會更大）；若搜到的數字反而較小，可能抓錯，視為 found=false
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


def fetch_one(client, name, code, period, life_sub_name, life_cumul, life_monthly=None, debug=False):
    """呼叫 Claude API + web_search，遇 429 退避重試最多 3 次"""
    import anthropic as _anthropic
    prompt = _build_prompt(name, code, period, life_sub_name, life_cumul, life_monthly)
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


def process_company(client, company, period, force=False, debug=False, override_manual=False):
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

    # 人工補入的 FVOCI（manual_fvoci.py 寫入 manual=true）一律保留，
    # 即使 --force 也不覆蓋；除非明確 --override-manual。
    existing = life_sub.get("fvoci_adjusted")
    if existing and existing.get("manual") and not override_manual:
        logger.info(f"[{name}] manual fvoci present, skip (use --override-manual to replace)")
        return "skipped"

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

    life_monthly = life_sub.get("monthly_profit")
    life_sub_name = life_sub.get("name", "壽險子公司")
    logger.info(f"[{name}] fetching FVOCI adjustment for {life_sub_name}...")

    try:
        parsed, raw = fetch_one(
            client, name, code, period, life_sub_name, life_cumul,
            life_monthly=life_monthly, debug=debug,
        )
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

    # 當月加計FVOCI後獲利（選填）：FVOCI 處份利益 >= 0，加計後不應小於原始當月 P&L；
    # 驗證不過只丟棄當月數，不影響累計數
    adjusted_monthly = parsed.get("adjusted_monthly_nt_million")
    if not isinstance(adjusted_monthly, (int, float)):
        adjusted_monthly = None
    elif life_monthly is not None and adjusted_monthly < life_monthly:
        logger.warning(
            f"[{name}] adjusted monthly ({adjusted_monthly}) < original monthly "
            f"({life_monthly}), discarding monthly figure only"
        )
        adjusted_monthly = None

    value_kind = parsed.get("value_kind", "exact")

    if value_kind == "lower_bound":
        # 區間/門檻型（如國泰人壽「突破1,000億」）：存下界 + display_prefix，不存 delta、不算 YoY。
        # main.compute_yoy 會因 value_type=='lower_bound' 跳過 YoY。
        life_sub["fvoci_adjusted"] = {
            "value_type": "lower_bound",
            "cumulative_profit": round(adjusted_life, 1),
            **({"monthly_profit": round(adjusted_monthly, 1)} if adjusted_monthly is not None else {}),
            "display_prefix": parsed.get("display_prefix", "逾"),
            "source_url": parsed.get("source_url", ""),
            "source_quote": parsed.get("source_quote", ""),
            "original_value_text": parsed.get("original_value_text", ""),
            "generated_at": datetime.now().isoformat(),
        }
        life_sub.pop("fvoci_not_found_count", None)
        logger.info(
            f"[{name}] {life_sub_name} adjusted (lower_bound): "
            f"{parsed.get('display_prefix','逾')} {adjusted_life} NT$m (original {life_cumul})"
        )
        return "updated"

    delta_vs_original = adjusted_life - life_cumul

    life_sub["fvoci_adjusted"] = {
        "cumulative_profit": round(adjusted_life, 1),
        **({"monthly_profit": round(adjusted_monthly, 1)} if adjusted_monthly is not None else {}),
        "delta_vs_original": round(delta_vs_original, 1),
        "source_url": parsed.get("source_url", ""),
        "source_quote": parsed.get("source_quote", ""),
        "original_value_text": parsed.get("original_value_text", ""),
        "generated_at": datetime.now().isoformat(),
    }
    # 找到後清除 retry counter（不再需要）
    life_sub.pop("fvoci_not_found_count", None)
    logger.info(
        f"[{name}] {life_sub_name} adjusted (direct): cumul {adjusted_life} NT$m "
        f"(original {life_cumul}, +{delta_vs_original}), monthly {adjusted_monthly}"
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
        "--override-manual", action="store_true",
        help="連同人工補入（manual=true）的 FVOCI 一併重新生成；預設一律保留人工內容",
    )
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
            existing = life_sub.get("fvoci_adjusted") if life_sub else None
            is_manual = bool(existing and existing.get("manual") and not args.override_manual)
            will_skip = life_sub and (
                is_manual
                or (not args.force and (
                    bool(existing)
                    or life_sub.get("fvoci_not_found_count", 0) >= 3
                ))
            )
            if life_sub and not will_skip:
                logger.info(f"Sleeping {args.inter_call_sleep}s before next call...")
                time.sleep(args.inter_call_sleep)

        result = process_company(
            client, company, period,
            force=args.force, debug=args.debug, override_manual=args.override_manual,
        )
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
