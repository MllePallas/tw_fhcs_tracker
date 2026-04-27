# parser.py
# 公告 HTML 解析器
# 第一層：規則式表格解析
# 第二層：Claude LLM 兜底解析

import re
import json
import logging
from typing import Optional

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


# ── 工具函數 ─────────────────────────────────────────────

def clean_number(text: str) -> Optional[float]:
    """
    將文字數字清理成 float。
    處理：千分位逗號、括號負數、空白、'-' 表示零。
    """
    if not text:
        return None
    t = text.strip().replace(",", "").replace(" ", "")
    if t in ("-", "－", "—", ""):
        return 0.0
    # 括號表示負數：(1,234) → -1234
    m = re.match(r"^\(([0-9.]+)\)$", t)
    if m:
        return -float(m.group(1))
    # 負號
    m = re.match(r"^[-－]([0-9.]+)$", t)
    if m:
        return -float(m.group(1))
    try:
        return float(t)
    except ValueError:
        return None


def detect_unit(html: str) -> str:
    """從 HTML 中偵測金額單位（千元、百萬元、億元）"""
    patterns = [
        (r"單位[：:]\s*(千元|百萬元|億元|元)", 1),
        (r"(千元|百萬元|億元)", 1),
    ]
    for pat, grp in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(grp)
    return "千元"  # MOPS 預設單位


def build_month_patterns(target_month: Optional[str]) -> list[str]:
    """
    將 '115/03' 展開成 MOPS 標題可能出現的多種格式。

    MOPS 標題常見格式：
      - '115年3月'   （最常見）
      - '115年03月'
      - '115/03'
      - '115/3'
    """
    if not target_month:
        return []
    parts = target_month.split("/")
    if len(parts) != 2:
        return [target_month]
    roc_year, month_str = parts
    month_int = int(month_str)
    return [
        f"{roc_year}年{month_int}月",        # 115年3月
        f"{roc_year}年{month_int:02d}月",    # 115年03月
        f"{roc_year}/{month_int:02d}",       # 115/03
        f"{roc_year}/{month_int}",           # 115/3
    ]


def find_profit_announcement(
    announcements: list[dict],
    keywords: list[str],
    target_month: Optional[str] = None,
) -> Optional[dict]:
    """
    從公告列表中找出月自結損益公告。
    target_month 格式：'115/03'（民國年/月）

    MOPS 標題格式不一，例如：
      '公告本公司暨主要子公司115年3月合併自結損益'
    因此 target_month 會被展開成多種可能格式比對。
    """
    month_patterns = build_month_patterns(target_month)

    def month_match(title: str) -> bool:
        if not month_patterns:
            return True
        return any(p in title for p in month_patterns)

    # 第一輪：損益關鍵字 + 月份匹配
    for ann in announcements:
        title = ann.get("title", "")
        if any(kw in title for kw in keywords) and month_match(title):
            logger.info(f"Matched announcement: {ann['date']} {title}")
            return ann

    # 第二輪：放寬關鍵字，保留月份條件
    for ann in announcements:
        title = ann.get("title", "")
        if ("自結" in title or ("損益" in title and "月" in title)) and month_match(title):
            logger.info(f"Loose-matched announcement: {ann['date']} {title}")
            return ann

    return None


# ── 第一層：規則式 HTML 表格解析 ─────────────────────────

class TableParser:
    """嘗試用規則解析 MOPS 公告中的損益表格"""

    PROFIT_KEYWORDS = ["稅後淨利", "稅後純益", "合併損益", "淨利", "稅後盈餘"]
    MONTHLY_KEYWORDS = ["當月", "本月", "單月"]
    CUMULATIVE_KEYWORDS = ["累計", "本年", "今年"]
    COMPANY_COL_KEYWORDS = ["公司", "名稱", "子公司"]

    def parse(self, html: str, company_name: str) -> Optional[dict]:
        """
        解析 HTML，回傳標準化結構。
        失敗時回傳 None，由 LLM 接手。
        """
        soup = BeautifulSoup(html, "html.parser")
        unit = detect_unit(html)

        # 取得所有表格
        tables = soup.find_all("table")
        logger.debug(f"[{company_name}] Found {len(tables)} tables")

        best_result = None
        best_score = 0

        for table in tables:
            result = self._try_parse_table(table, company_name, unit)
            if result:
                score = self._score_result(result)
                if score > best_score:
                    best_score = score
                    best_result = result

        if best_result:
            logger.info(f"[{company_name}] TableParser succeeded (score={best_score})")
        return best_result

    def _try_parse_table(self, table, company_name: str, unit: str) -> Optional[dict]:
        """嘗試解析單一表格"""
        rows = table.find_all("tr")
        if len(rows) < 2:
            return None

        # 分析表頭
        header_row = rows[0]
        headers = [th.get_text(strip=True) for th in header_row.find_all(["th", "td"])]
        full_text = table.get_text()

        # 必須包含損益相關關鍵字
        if not any(kw in full_text for kw in self.PROFIT_KEYWORDS):
            return None

        # 嘗試辨識欄位索引
        col_map = self._identify_columns(headers)
        if col_map is None:
            # 嘗試多列表頭
            col_map = self._identify_columns_multirow(rows)

        if col_map is None:
            return None

        # 解析資料列
        subsidiaries = []
        holding = None

        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue

            texts = [c.get_text(strip=True) for c in cells]

            # 取得公司名稱
            name_idx = col_map.get("name", 0)
            if name_idx >= len(texts):
                continue
            row_name = texts[name_idx]
            if not row_name or row_name in headers:
                continue

            # 取得數值
            monthly = None
            cumulative = None

            if "monthly" in col_map and col_map["monthly"] < len(texts):
                monthly = clean_number(texts[col_map["monthly"]])
            if "cumulative" in col_map and col_map["cumulative"] < len(texts):
                cumulative = clean_number(texts[col_map["cumulative"]])

            if monthly is None and cumulative is None:
                continue

            entry = {
                "name": row_name,
                "monthly_profit": monthly,
                "cumulative_profit": cumulative,
                "unit": unit,
            }

            # 判斷是否為金控本體
            if company_name in row_name or "合計" in row_name or "金控" in row_name:
                holding = entry
            else:
                subsidiaries.append(entry)

        if not subsidiaries and not holding:
            return None

        # 如果沒有找到金控本體，嘗試從最後一列或合計列找
        if holding is None and subsidiaries:
            for sub in subsidiaries:
                if "合計" in sub["name"] or "合併" in sub["name"]:
                    holding = sub
                    subsidiaries.remove(sub)
                    break
            if holding is None:
                # 用第一個有數值的作為金控
                holding = subsidiaries[0]
                subsidiaries = subsidiaries[1:]

        return {
            "holding_company": holding,
            "subsidiaries": subsidiaries,
            "unit": unit,
            "parse_method": "table_rule",
        }

    def _identify_columns(self, headers: list[str]) -> Optional[dict]:
        """從單列表頭辨識欄位"""
        col_map = {}

        for i, h in enumerate(headers):
            # 公司名稱欄
            if any(kw in h for kw in self.COMPANY_COL_KEYWORDS) or i == 0:
                if "name" not in col_map:
                    col_map["name"] = i

            # 當月獲利欄
            if any(kw in h for kw in self.MONTHLY_KEYWORDS):
                if any(kw in h for kw in self.PROFIT_KEYWORDS + ["金額", "損益"]):
                    col_map["monthly"] = i
                elif "monthly" not in col_map:
                    col_map["monthly"] = i

            # 累計獲利欄
            if any(kw in h for kw in self.CUMULATIVE_KEYWORDS):
                if any(kw in h for kw in self.PROFIT_KEYWORDS + ["金額", "損益"]):
                    col_map["cumulative"] = i
                elif "cumulative" not in col_map:
                    col_map["cumulative"] = i

        if "monthly" in col_map or "cumulative" in col_map:
            return col_map
        return None

    def _identify_columns_multirow(self, rows) -> Optional[dict]:
        """嘗試合併多列表頭"""
        if len(rows) < 2:
            return None
        combined = []
        for row in rows[:3]:
            cells = row.find_all(["th", "td"])
            combined.append([c.get_text(strip=True) for c in cells])

        # 簡單策略：合併前兩列
        if len(combined) >= 2:
            merged = [
                f"{a} {b}".strip()
                for a, b in zip(combined[0], combined[1])
            ]
            return self._identify_columns(merged)
        return None

    def _score_result(self, result: dict) -> int:
        """評分解析結果的可信度"""
        score = 0
        if result.get("holding_company"):
            score += 10
            if result["holding_company"].get("monthly_profit") is not None:
                score += 5
            if result["holding_company"].get("cumulative_profit") is not None:
                score += 5
        score += len(result.get("subsidiaries", [])) * 2
        return score


# ── 第二層：Claude LLM 兜底解析 ──────────────────────────

def llm_parse(html: str, company_name: str, api_key: str) -> Optional[dict]:
    """
    使用 Claude API 解析無法用規則解析的公告內容。
    需要設定 ANTHROPIC_API_KEY 環境變數或傳入 api_key。
    """
    try:
        import anthropic
    except ImportError:
        logger.error("anthropic package not installed")
        return None

    # 清理 HTML，只保留文字內容，縮短 token 用量
    soup = BeautifulSoup(html, "html.parser")
    # 移除 script/style
    for tag in soup(["script", "style", "meta", "link"]):
        tag.decompose()
    clean_text = soup.get_text(separator="\n", strip=True)
    # 截斷（避免超過 context window）
    clean_text = clean_text[:6000]

    source_unit = detect_unit(html)

    # 換算倍率：統一輸出百萬元
    UNIT_FACTOR = {"千元": 0.001, "百萬元": 1.0, "億元": 100.0}
    factor = UNIT_FACTOR.get(source_unit, 1.0)
    if source_unit == "億元":
        conversion_note = f"原始單位為億元，每個數字 × 100 換算成百萬元（例如：25.7 億元 → 2570 百萬元）"
    elif source_unit == "千元":
        conversion_note = f"原始單位為千元，每個數字 ÷ 1000 換算成百萬元（例如：2,749,000 千元 → 2749 百萬元）"
    else:
        conversion_note = "原始單位已是百萬元，數字不需換算"

    prompt = f"""以下是台灣金控公司「{company_name}」發布的月自結損益公告內容。

請從中擷取財務數據，並以 JSON 格式回傳。

【⚠️ 單位換算（必須執行）】
{conversion_note}
→ 所有數字必須換算成「百萬元（NT$m）」後填入 JSON。
→ unit 欄位固定填 "百萬元"，不論原始公告用什麼單位。

【回傳格式】
{{
  "holding_company": {{
    "name": "公司名稱",
    "monthly_profit": 當月稅後淨利（百萬元，負數用負號），
    "cumulative_profit": 累計稅後淨利（百萬元），
    "monthly_eps": 當月稅後 EPS（元，可為 null），
    "cumulative_eps": 累計稅後 EPS（元）
  }},
  "subsidiaries": [
    {{
      "name": "子公司名稱",
      "monthly_profit": 當月稅後淨利（百萬元）,
      "cumulative_profit": 累計稅後淨利（百萬元），
      "monthly_eps": 當月稅後 EPS（元，可為 null）,
      "cumulative_eps": 累計稅後 EPS（元，可為 null）
    }}
  ],
  "unit": "百萬元",
  "report_month": "民國年/月，如 115/03",
  "parse_method": "llm"
}}

【EPS 規則】
- EPS 單位固定「元」，不需換算
- 公告若只列「累計 EPS」（最常見）→ cumulative_eps 填數字，monthly_eps 填 null
- 公告若同時列「當月 EPS」與「累計 EPS」→ 兩者都填
- 公告完全沒列 EPS（罕見）→ 兩個都填 null

【欄位選擇】
- 公告若同時列「總損益」「母公司業主」「非控制權益」三欄
  → 一律取「母公司業主」欄（這才是嚴格定義的稅後淨利歸屬於母公司股東）
  → 不要取「總損益」（含非控制權益）
- 公告若只有單一稅後淨利欄位（沒有上述三欄拆解）→ 直接取該欄

【其他規則】
- 數字若為括號表示法如 (1,234)，代表負數 -1234
- 找不到的數字填 null
- subsidiaries 陣列可為空
- 只擷取稅後淨利（tax after profit），不要抓稅前

【公告內容】
{clean_text}

只回傳 JSON，不要其他說明文字。"""

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        # 移除可能的 markdown code block
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        result = json.loads(raw)
        logger.info(f"[{company_name}] LLM parse succeeded")
        return result
    except Exception as e:
        logger.error(f"[{company_name}] LLM parse failed: {e}")
        return None


# ── 主要解析入口 ─────────────────────────────────────────

def parse_profit_announcement(
    html: str,
    company_name: str,
    api_key: Optional[str] = None,
) -> Optional[dict]:
    """
    兩層解析策略：
    1. 規則式表格解析（快速、無費用）
    2. Claude LLM 兜底（準確、需 API key）
    """
    if not html:
        return None

    # 第一層
    table_parser = TableParser()
    result = table_parser.parse(html, company_name)

    if result and result.get("holding_company"):
        return result

    # 第二層：LLM
    if api_key:
        logger.info(f"[{company_name}] Falling back to LLM parser")
        result = llm_parse(html, company_name, api_key)
        return result

    logger.warning(f"[{company_name}] Both parsers failed, no API key provided for LLM fallback")
    return None
