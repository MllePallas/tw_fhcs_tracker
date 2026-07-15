# news_summary.py
# 為已抓到的金控月自結資料補上「新聞摘要」欄位。
# 透過 Claude API + web_search 工具，限定 工商時報 / 經濟日報 / 鉅亨網
# 查詢各家當月損益相關報導並產生 ~150 字繁體中文摘要。
#
# 冪等：已有 news_summary 的 entry 預設跳過；--force 才重做。

import os
import re
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

ALLOWED_DOMAINS = ["ctee.com.tw", "money.udn.com", "news.cnyes.com", "ec.ltn.com.tw"]
MODEL = "claude-sonnet-4-6"

# 「無相關說明」永久跳過前的 retry 上限。
# 預設 3；大型金控媒體必定報導，撲空幾乎都是 web_search 索引延遲（偽陰性），
# 故拉高到 6，避免新聞還沒被索引時就提前永久放棄。
NEWS_RETRY_CAP_DEFAULT = 3
NEWS_RETRY_CAP_OVERRIDE = {
    "2881": 6,  # 富邦金
    "2882": 6,  # 國泰金
    "2883": 6,  # 凱基金
    "2887": 6,  # 台新新光金
    "2891": 6,  # 中信金
}


def _retry_cap(code):
    return NEWS_RETRY_CAP_OVERRIDE.get(code, NEWS_RETRY_CAP_DEFAULT)


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


# 有壽險子公司的金控代號（IFRS 17 適用，需關注 CSM / 加計FVOCI後獲利）
LIFE_INSURANCE_CODES = {"2881", "2882", "2883", "2887", "2891"}
# 2881 富邦人壽、2882 國泰人壽、2883 凱基人壽、2887 新光人壽、2891 台灣人壽


def normalize_summary(text):
    """統一各家摘要格式（LLM 輸出偶爾夾雜 ## 大標題、---、判斷前言）：
    - 丟棄分隔線與「XX金控…摘要」大標題行
    - #/##/### 標題一律轉成 **粗體** 段落標題
    - 若存在 **重點** 標題，丟棄其前的前言（LLM 判斷過程等）
    冪等：已符合模板的摘要不會被改動。"""
    if not text:
        return text
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(r"^-{3,}$", s):
            continue
        m = re.match(r"^#{1,6}\s*(.+?)\s*$", s)
        if m:
            inner = m.group(1).strip().strip("*").strip()
            # 「XX金（1234）115年X月自結損益摘要」這類大標題直接丟棄
            if inner.endswith("摘要"):
                continue
            out.append(f"**{inner}**")
            continue
        out.append(ln)
    result = "\n".join(out)
    idx = result.find("**重點**")
    if idx > 0:
        result = result[idx:]
    # 孤懸的清單符號「- 」＋換行 → 與下一行接回同一列
    result = re.sub(r"^(-[ \t]*)\n+(?=\S)", "- ", result, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", result).strip()


def _extract_source_date(url):
    """從新聞 URL 嘗試解析發布日期；ctee `/news/YYYYMMDD` 可解析，其餘多回傳 None。"""
    if not url:
        return None
    m = re.search(r"/news/(\d{8})", url)
    if not m:
        m = re.search(r"(?<!\d)(20\d{6})(?!\d)", url)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d").date()
    except ValueError:
        return None


def _announcement_month_start(period):
    """目標月份 N → 公告月份 N+1 的第一天。例 115/06 → 2026-07-01。
    公告月份之前發布的新聞必屬其他月份（甚至去年），不可列為來源。"""
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    if m < 12:
        return datetime(western_year, m + 1, 1).date()
    return datetime(western_year + 1, 1, 1).date()


def _build_prompt(name, code, period, monthly, cumul, subs):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    # 公告月份 = 目標月份的下個月（例：1月損益於2月公告）
    pub_year = western_year if m < 12 else western_year + 1
    pub_month = m + 1 if m < 12 else 1
    is_quarter_end = m in (3, 6, 9, 12)  # 只有 Q 末月才能用「累計 Q」字樣
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
        life_search = f"3. `{life_ins_name} 加計FVOCI 獲利` 或 `{life_ins_name} 對保留盈餘影響數`"
        life_context = f"""
【壽險子公司特別注意（IFRS 17）】
此金控旗下有壽險子公司（{life_ins_name}），媒體報導可能涉及：
- **CSM（合約服務邊際）**：IFRS 17 下壽險核心獲利指標，反映未來利潤釋放速度
- **加計FVOCI後獲利／對保留盈餘影響數**：主管機關已要求新聞稿不得使用「調整後獲利」一詞；
  2026年7月起媒體改以「加計FVOCI（股票處分損益）獲利」（富邦、凱基）或「對保留盈餘影響數」
  （國泰）表達加回 FVOCI 處份利益後的同基比較數字。摘要中請沿用新聞的新用語，不要自行改寫成「調整後獲利」
- **FVOCI 股票處份利益**：壽險公司處分 FVOCI 股票認列的一次性利益，波動大
- **投資收益 vs 承保利益**：IFRS 17 下壽險獲利拆解為這兩大來源

若新聞有提到以上任何指標，請在摘要中標注。"""

    return f"""你是台灣金融分析師。請查詢「{name}（{code}）」**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞報導，並產生繁體中文摘要。

搜尋限制：工商時報、經濟日報、鉅亨網、自由財經（透過 allowed_domains 限制，你不需要在 query 加 site:）。

【搜尋策略】請至少嘗試以下查詢字串：
1. `{name} {m}月 自結 稅後`
2. `{name} {m}月 EPS 累計`
{life_search}

⚠️ 媒體標題通常用「西元年 + 月份」（例如「{name}{m}月」、「{m}月稅後」），**不會**用「民國年」格式。
⚠️ 報導中的數字若與我提供的不完全一致是正常的，以新聞數字為準即可——但**月份必須對齊**（見下方嚴格時間檢查）。
{life_context}
【relevance 標記（嚴格 — 過去曾大量錯置月份，務必逐項檢查）】

你必須在輸出第一行寫 `RELEVANT` 或 `IRRELEVANT`。

✅ 標 **RELEVANT** 的條件（**核心：以新聞內容描述的月份為準，不以發布日期為準**）：
1. **新聞內文明確描述「{western_year} 年 {m} 月」（即西元 {western_year} 年 {m} 月）的月自結損益、稅後純益、EPS 或累計數字**
2. 即使發布日期較晚（例如 {pub_year}/{pub_month:02d} 之後才出現的法說會整理稿、季末回顧、年度回顧），只要**內文確實在報導 {western_year}/{m:02d} 月的數字**就算 RELEVANT
3. {"是季底月份（Q" + str((m-1)//3 + 1) + " 末），新聞使用「累計 Q" + str((m-1)//3 + 1) + "」或「累計前" + str(m) + "月」描述同一份月自結資料 → 算 RELEVANT" if is_quarter_end else "**不是**季底月份；新聞若只用「Q1/Q2/Q3/Q4 累計」概括（無 " + str(m) + " 月數字）→ IRRELEVANT"}

❌ 標 **IRRELEVANT** 的情境（**過去最常見的錯置**）：
- 搜尋只回傳**其他月份**的新聞（內容描述的數字屬於 {western_year} 年的**其他**月份，**非** {m} 月）→ **IRRELEVANT**，**不要**拿其他月份的新聞數字湊 {m} 月摘要
- 內文出現的月份數字（X 月稅後 Y 億）X ≠ {m} → IRRELEVANT
- 只有去年（{western_year - 1} 年）舊報導、股利、股東會、ESG → IRRELEVANT。**特別注意去年同月的損益報導**（例：{western_year - 1} 年報導「{m - 1 if m > 1 else 12}月／前{m - 1 if m > 1 else 12}月獲利」），年份不對即 IRRELEVANT；可由 URL 中的日期（如 ctee `/news/YYYYMMDD`）輔助判斷年份
- 完全沒有搜到任何相關新聞 → IRRELEVANT

⚠️ **判斷重點**：看「**內文寫的是哪一月的數字**」，不是看「**新聞何時發布**」。
⚠️ 寧可標 IRRELEVANT 也不要強行用其他月份的新聞代替。下游 script 會把 IRRELEVANT 標為「無相關說明」，這是預期行為。

⚠️ **輸出格式硬性要求（過去常見錯誤：把分析寫在 marker 前面）**：
**第一行**必須是純文字 `RELEVANT` 或 `IRRELEVANT`（無 markdown、無前綴）。
不要在 marker 之前加任何分析、說明、客套話。要分析判斷過程的話，寫在 marker 之後的摘要正文裡。

【輸出格式（嚴格模板——13 家金控的摘要必須呈現一致，逐字遵守）】
第一行：`RELEVANT` 或 `IRRELEVANT`

若 RELEVANT，第二行起**必須**依下列模板，恰好兩段（專業分析師風格）：

**重點**
1-2 句說明當月獲利水準與主要驅動因素（利息淨收益、股債市影響、保險業務變化、信用成本、匯率避險、CSM 釋放等）。

**子公司明細**
- 子公司A：新聞具體提到的數字（壽險加計FVOCI後獲利／對保留盈餘影響數／CSM、銀行手續費／利差、證券手續費等）
- 子公司B：…

模板硬性規則：
- 段落標題**固定**為 `**重點**`、`**子公司明細**`（粗體），**禁止**改用 #、##、### markdown 標題
- **禁止**輸出大標題（如「## XX金控（代號）115年X月自結損益摘要」）、分隔線（---）、表格、emoji
- **禁止**輸出你的判斷過程（如「搜尋結果中…符合 RELEVANT 標準」）；marker 之後直接從 `**重點**` 開始
- 若新聞未提及子公司具體數字，省略整個 `**子公司明細**` 段（不要寫「新聞未提及」）
- 總長約 200 字

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
        "--override-manual",
        action="store_true",
        help="連同人工補入（news_manual=true）的摘要一併重新生成；預設一律保留人工內容",
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

        # 人工補入的摘要（manual_news.py 寫入 news_manual=true）一律保留，
        # 即使 --force 也不覆蓋；除非明確 --override-manual。
        if company.get("news_manual") and not args.override_manual:
            logger.info(f"[{name}] manual summary present, skip (use --override-manual to replace)")
            skipped += 1
            continue

        # 跳過條件（除非 --force）：
        #   1. 已有真實新聞摘要（非「無相關說明」）→ skip
        #   2. 已標記「無相關說明」且 retry_count >= 3 → permanently skip
        #   否則：retry（拉早跑時新聞可能還沒索引到，下一輪可能成功）
        if not args.force:
            summary_val = company.get("news_summary")
            retry_count = company.get("news_retry_count", 0)
            if summary_val and summary_val != "無相關說明":
                logger.info(f"[{name}] already has summary, skip")
                skipped += 1
                continue
            if summary_val == "無相關說明" and retry_count >= _retry_cap(code):
                logger.info(
                    f"[{name}] no relevant news (retried {retry_count}x, cap {_retry_cap(code)}), permanently skip"
                )
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

            # 解析 RELEVANT / IRRELEVANT 標記
            # LLM 不一定把標記放第一行（有時會加分析），所以掃整份輸出，
            # 並允許 markdown 包裹（**RELEVANT**、## RELEVANT 等）。
            # 找到的第一個 marker 為準。
            import re as _re
            lines = raw.splitlines()
            marker_idx = -1
            relevant = False
            for i, ln in enumerate(lines):
                # 去掉 markdown 標記符號、前綴 emoji、空白
                t = _re.sub(r"^[\s#*`>\-✅❌⚠️\U0001f4cd]+", "", ln).strip()
                t = _re.sub(r"[\s#*`]+$", "", t).upper()
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
                # 標記「無相關說明」+ 累加 retry_count（上限由 skip 邏輯把關）
                new_count = company.get("news_retry_count", 0) + 1
                company["news_summary"] = "無相關說明"
                company["news_sources"] = []
                company["news_generated_at"] = datetime.now().isoformat()
                company["news_retry_count"] = new_count
                updated += 1
                logger.info(f"[{name}] marked IRRELEVANT (retry {new_count}/{_retry_cap(code)}) → 無相關說明")
            else:
                # 找到真實新聞 → 統一格式後寫入並清除 retry_count
                summary = normalize_summary(summary)
                # 來源日期防呆：公告月份（N+1 月）之前發布的新聞必屬其他月份，剔除
                # （僅 URL 帶日期者可驗證，如 ctee /news/YYYYMMDD；其餘放行）
                ann_start = _announcement_month_start(period)
                kept_sources = []
                for s in sources:
                    if not s.get("url"):
                        continue
                    d = _extract_source_date(s["url"])
                    if d and d < ann_start:
                        logger.warning(f"[{name}] dropping stale source dated {d}: {s['url']}")
                        continue
                    kept_sources.append(s)
                company["news_summary"] = summary
                company["news_sources"] = kept_sources
                company["news_generated_at"] = datetime.now().isoformat()
                company.pop("news_retry_count", None)
                updated += 1
                logger.info(f"[{name}] OK ({len(summary)} chars, {len(kept_sources)} sources)")
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
