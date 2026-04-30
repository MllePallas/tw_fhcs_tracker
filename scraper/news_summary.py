# news_summary.py
# 為已抓到的金控月自結資料補上「新聞摘要」欄位。
# 透過 Claude API + web_search 工具，限定 工商時報 / 經濟日報 / 鉅亨網
# 查詢各家當月損益相關報導並產生 ~150 字繁體中文摘要。
#
# 冪等：已有 news_summary 的 entry 預設跳過；--force 才重做。

import os
import sys
import json
import time
import logging
import argparse
from datetime import datetime
from pathlib import Path

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


# 有壽險子公司的金控代號（IFRS 17 適用，需關注 CSM / 調整後獲利 / FVOCI）
LIFE_INSURANCE_CODES = {"2881", "2882", "2883", "2887", "2891"}
# 2881 富邦人壽、2882 國泰人壽、2883 凱基人壽、2887 新光人壽、2891 台灣人壽


def _build_prompt(name, code, period, monthly, cumul, subs):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    sub_lines = "\n".join(
        f"  - {s.get('name')}: 當月 {s.get('monthly_profit')} 百萬元，"
        f"累計 {s.get('cumulative_profit')} 百萬元"
        for s in subs
    ) or "  - （無子公司明細）"

    # 壽險金控：加入第三組專屬查詢
    life_search = ""
    life_context = ""
    if code in LIFE_INSURANCE_CODES:
        life_ins_name = next(
            (s.get("name") for s in subs if "人壽" in s.get("name", "")), "壽險子公司"
        )
        life_search = f"3. `{life_ins_name} CSM 調整後獲利` 或 `{name} 壽險 FVOCI`"
        life_context = f"""
【壽險子公司特別注意（IFRS 17）】
此金控旗下有壽險子公司（{life_ins_name}），媒體報導可能涉及：
- **CSM（合約服務邊際）**：IFRS 17 下壽險核心獲利指標，反映未來利潤釋放速度
- **調整後獲利**：排除 FVOCI 股票處份利益的核心獲利（較能反映業務本質）
- **FVOCI 股票處份利益**：壽險公司處分 FVOCI 股票認列的一次性利益，波動大
- **投資收益 vs 承保利益**：IFRS 17 下壽險獲利拆解為這兩大來源

若新聞有提到以上任何指標，請在摘要中標注。"""

    return f"""你是台灣金融分析師。請查詢「{name}（{code}）」**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞報導，並產生繁體中文摘要。

搜尋限制：工商時報、經濟日報、鉅亨網（透過 allowed_domains 限制，你不需要在 query 加 site:）。

【搜尋策略】請至少嘗試以下查詢字串：
1. `{name} {m}月 自結 稅後`
2. `{name} {m}月 EPS 累計`
{life_search}

⚠️ 媒體標題通常用「西元年 + 月份」（例如「{name}3月」、「{m}月稅後」），**不會**用「民國年」格式。
⚠️ 媒體**經常以「累計第 N 季」或「Q{((m-1)//3)+1} 累計」**報導同一份月自結資料；這也算 RELEVANT。
⚠️ 報導中的數字若與我提供的不完全一致（例如新聞說 EPS、累計、合併、淨值，與我給的當月稅後不同），那**很正常**——以新聞數字為準摘要即可，不要因此判 IRRELEVANT。
{life_context}
【relevance 標記（重要）】
你必須在輸出第一行寫一個標記，告訴下游 script 是否真的找到相關新聞：
- 找到 1 則以上專門報導 {western_year}/{m:02d} 月損益（含累計 Q{((m-1)//3)+1}、EPS、月增/年增等延伸報導）：第一行寫 `RELEVANT`
- 完全沒搜到 {western_year} 年該月份的損益新聞，只有去年舊報導、股利、股東會、ESG：第一行寫 `IRRELEVANT`

判斷時請看新聞日期（URL 中的 YYYYMMDD 或標題中的時間）：報導 {western_year}/{m:02d} 月損益的新聞通常發佈於該月隔月的 8-15 日，絕大多數都是 RELEVANT。

【輸出格式】
第一行：`RELEVANT` 或 `IRRELEVANT`
第二行起：摘要內容（markdown，~200 字）

若 RELEVANT，摘要分兩段：
**重點**
1-2 句說明當月主要驅動因素（利息淨收益、股債市影響、保險業務變化、信用成本、匯率避險、CSM 釋放等）。

**子公司明細**
依新聞具體提到的數字（壽險 CSM／調整後獲利／FVOCI 處份利益、銀行手續費／利差、證券手續費等）。若新聞未提就省略整段。

若 IRRELEVANT，摘要寫單句：「{period} 無相關媒體報導；當月合併稅後淨利 {monthly} 百萬元，累計 {cumul} 百萬元。」

【硬性規則】
- 只引用搜尋結果中實際出現的數字與描述，禁止瞎編
- 不要使用「以上資訊」「希望對您有幫助」等客套話
- 不要重複公告日期或公告標題

【財報數字（已抓取，供你避免錯置）】
- {name} 合併稅後淨利當月：{monthly} 百萬元
- 累計：{cumul} 百萬元
- 子公司明細：
{sub_lines}

請開始搜尋並產生摘要。"""


def _extract_text_and_sources(response, western_year: int, debug=False):
    """
    從 Claude response.content 抽出最終文字與搜尋結果。
    過濾策略：只保留 URL 或標題中含有目標西元年份的搜尋結果（最多 3 條）。
    不依賴 LLM 輸出格式，因為 CITED_URLS marker 不穩定。
    """
    text_parts = []
    all_sources = []
    seen_urls = set()

    for block in response.content:
        btype = getattr(block, "type", "")
        if btype == "text":
            text_parts.append(block.text)
        elif btype == "server_tool_use":
            if debug:
                inp = getattr(block, "input", {})
                logger.info(f"[DEBUG] LLM search query: {inp}")
        elif btype == "web_search_tool_result":
            results = getattr(block, "content", [])
            if debug:
                logger.info(f"[DEBUG] returned {len(results)} results")
            for r in results:
                url = getattr(r, "url", None)
                title = getattr(r, "title", None)
                if debug:
                    logger.info(f"[DEBUG]   - {title} | {url}")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    all_sources.append({"url": url, "title": title or url})

    full_text = "\n".join(text_parts).strip()

    # 只保留包含目標年份的來源（過濾舊年份文章）
    year_str = str(western_year)
    relevant = [
        s for s in all_sources
        if year_str in s["url"] or year_str in s.get("title", "")
    ]
    # 若過濾後為空（極少數情況），退回取前 2 條
    sources = relevant[:3] if relevant else all_sources[:2]

    if debug:
        logger.info(f"[DEBUG] filtered sources ({len(sources)}/{len(all_sources)}): {[s['url'] for s in sources]}")

    return full_text, sources


def summarize_one(client, name, code, period, monthly, cumul, subs, debug=False):
    """呼叫 Claude API + web_search，遇 429 自動退避重試最多 3 次"""
    import anthropic as _anthropic
    roc_year = period.split("/")[0]
    western_year = int(roc_year) + 1911
    prompt = _build_prompt(name, code, period, monthly, cumul, subs)
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
            return _extract_text_and_sources(response, western_year, debug=debug)
        except _anthropic.RateLimitError as e:
            last_err = e
            wait = 65 * (attempt + 1)
            logger.warning(f"[{name}] Rate limit hit, wait {wait}s and retry ({attempt+1}/3)")
            time.sleep(wait)
    raise last_err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--period",
        help="目標月份 民國年/月，例 115/03。預設讀 latest.json",
        default=None,
    )
    ap.add_argument("--codes", nargs="+", help="只處理特定代號", default=None)
    ap.add_argument(
        "--force",
        action="store_true",
        help="強制重新生成（即使已有 news_summary）",
    )
    ap.add_argument(
        "--inter-call-sleep",
        type=int,
        default=30,
        help="每家之間 sleep 秒數（避開 30K tokens/min rate limit），預設 30",
    )
    ap.add_argument(
        "--debug",
        action="store_true",
        help="印出 LLM 實際的搜尋 query 與所有結果",
    )
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
    logger.info(f"Generating news summaries for {period} ({len(companies)} companies)")

    updated = 0
    skipped = 0
    failed = 0

    for company in companies:
        if "error" in company:
            continue
        code = company.get("code", "")
        name = company.get("name", "")

        if args.codes and code not in args.codes:
            continue

        if company.get("news_summary") and not args.force:
            logger.info(f"[{name}] already has summary, skip")
            skipped += 1
            continue

        h = company.get("holding_company", {})
        monthly = h.get("monthly_profit")
        cumul = h.get("cumulative_profit")
        subs = company.get("subsidiaries", [])

        # 第一家不睡，後續每家之間 sleep 避開 rate limit
        if updated > 0 or failed > 0:
            logger.info(f"Sleeping {args.inter_call_sleep}s before next call...")
            time.sleep(args.inter_call_sleep)

        logger.info(f"[{name}] generating news summary...")
        try:
            raw, sources = summarize_one(client, name, code, period, monthly, cumul, subs, debug=args.debug)
            if not raw:
                logger.warning(f"[{name}] empty summary returned")
                failed += 1
                continue

            # 解析 RELEVANT / IRRELEVANT 標記（在前 6 行內找，LLM 有時會加前言）
            lines = raw.splitlines()
            marker_idx = -1
            relevant = False
            for i, ln in enumerate(lines[:6]):
                t = ln.strip().upper()
                if t == "RELEVANT" or t.startswith("RELEVANT "):
                    relevant = True
                    marker_idx = i
                    break
                if t == "IRRELEVANT" or t.startswith("IRRELEVANT "):
                    relevant = False
                    marker_idx = i
                    break

            if marker_idx >= 0:
                # 標記後的內容為摘要正文
                summary = "\n".join(lines[marker_idx + 1 :]).strip()
            else:
                # 沒找到標記就保守當 IRRELEVANT
                summary = raw
                relevant = False
                logger.warning(f"[{name}] no marker found, treating as IRRELEVANT")

            if not relevant:
                # 沒搜到專屬報導 → 直接標記「無相關說明」，不再 retry
                company["news_summary"] = "無相關說明"
                company["news_sources"] = []
                company["news_generated_at"] = datetime.now().isoformat()
                updated += 1
                logger.info(f"[{name}] marked IRRELEVANT → 無相關說明")
            else:
                # 限定保留有實際引用的 sources（過濾無 url 的）
                company["news_summary"] = summary
                company["news_sources"] = [s for s in sources if s.get("url")]
                company["news_generated_at"] = datetime.now().isoformat()
                updated += 1
                logger.info(f"[{name}] OK ({len(summary)} chars, {len(sources)} sources)")
        except Exception as e:
            logger.error(f"[{name}] Summary generation failed: {e}", exc_info=True)
            failed += 1
            continue

    # 寫回原檔
    with open(period_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"Saved {period_file.name}: updated={updated}, skipped={skipped}, failed={failed}")

    # 同步另一個檔案：latest.json ↔ 對應月份歸檔（115-03.json 等）
    archive_path = DATA_DIR / f"{period.replace('/', '-')}.json" if period else None
    latest_path = DATA_DIR / "latest.json"
    other = archive_path if period_file.name == "latest.json" else latest_path
    if other and other != period_file:
        # 若另一檔存在且指向同一期，才覆寫；否則直接寫（latest 永遠跟最新跑）
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
