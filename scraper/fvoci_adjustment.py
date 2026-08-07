# fvoci_adjustment.py
# 為壽險金控補上「加上 FVOCI 股票處分利益後獲利」欄位——**兩個層級**：
#   A. 壽險子公司本身（富邦人壽、凱基人壽…）→ subsidiaries[*].fvoci_adjusted
#   B. 金控合併層級（115/06 起富邦、凱基、國泰於新聞稿揭露）→ holding_company.fvoci_adjusted
#
# 背景：2026 年起接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年
# 同期可比，各金控會在月損益新聞稿揭露「加計 FVOCI 處分利益後的獲利」——
# 起初僅壽險子公司層級，115/06 損益新聞稿起亦揭露金控合併層級
# （國泰以「對保留盈餘影響數」表述金控層級加計數）。
#
# 本腳本透過 Claude API + web_search 一次呼叫同時抓兩個層級的數字。
# （禁止由差額推算：金控合併 P&L 包含其他子公司、少數權益、內部交易抵銷，
#  兩層級的加計數只能各自取自新聞明確揭露。）
#
# 寫入格式（兩層級相同，金控層級多一個 label / cumulative_eps 選填欄位）：
# "fvoci_adjusted": {
#   "cumulative_profit": <NT$m>,        # 新聞揭露的累計加計FVOCI後獲利
#   "monthly_profit": <NT$m>,           # 當月加計FVOCI後獲利（新聞有揭露才寫，可能缺）
#   "delta_vs_original": <NT$m>,        # cumulative_profit - 原始累計 P&L（純紀錄）
#   "label": "對保留盈餘影響數",         # 僅金控層級、且新聞用語非「加計FVOCI」時寫入（國泰）
#   "cumulative_eps": 13.17,            # 僅金控層級選填：新聞揭露「總計EPS」（富邦）
#   "source_url": "...", "source_quote": "...",
#   "original_value_text": "...",
#   "generated_at": "..."
# }
# 門檻型（僅揭露「突破X億」）同舊制：value_type="lower_bound" + display_prefix，不算 YoY。
#
# 用語備註（2026-07 起）：主管機關要求新聞稿不得使用「調整後獲利」一詞（與會計
# 原則不符）。各金控 115/06 損益新聞稿起改用：凱基／富邦「加計FVOCI（股票處分
# 損益）後獲利」；國泰「對保留盈餘影響數」。搜尋關鍵字需同時涵蓋新舊用語。
# YoY 由 main.compute_yoy 統一計算（呼叫於本腳本尾端，兩層級皆算）。
#
# 冪等：已有 fvoci_adjusted 的層級預設跳過；--force 才重做。manual=true 一律保留。

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

# 於新聞稿揭露「金控合併層級」加計FVOCI後獲利的金控（115/06 起）。
# 富邦／凱基：「金控稅後淨利加計FVOCI後獲利」；國泰：「對保留盈餘影響數」。
# 台新新光（2887）、中信（2891）目前僅揭露壽險子公司層級，故不在此清單；
# 未來若開始揭露金控層級，把代號加進來即可。
HOLDING_FVOCI_CODES = {"2881", "2882", "2883"}


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


def _build_prompt(name, code, period, life_sub_name, life_cumul, life_monthly=None,
                  want_holding=False, holding_cumul=None, holding_monthly=None):
    roc_year, roc_month = period.split("/")
    western_year = int(roc_year) + 1911
    m = int(roc_month)
    monthly_line = (
        f"- {life_sub_name} {western_year}/{m:02d} 當月稅後淨利（原始 P&L）：{life_monthly} 百萬元"
        if life_monthly is not None else ""
    )

    if want_holding:
        task_scope = f"""本任務要抓**兩個層級**的加計FVOCI後獲利，缺一不可分開判斷（找到哪個填哪個）：
- **A. 壽險子公司層級**：「{life_sub_name}」本身的加計FVOCI後獲利
- **B. 金控合併層級**：「{name}」金控合併稅後淨利加計FVOCI後的數字（國泰金控以「**對保留盈餘影響數**」表述）"""
        holding_known = f"""- {name}（金控合併）{western_year}/{m:02d} 累計稅後淨利（原始 P&L）：{holding_cumul} 百萬元""" + (
            f"\n- {name}（金控合併）{western_year}/{m:02d} 當月稅後淨利（原始 P&L）：{holding_monthly} 百萬元"
            if holding_monthly is not None else "")
        holding_examples = """
【金控合併層級的參考新聞語句範例（115/06 起，B 層級要找的就是這類句子）】
- 富邦：「透過其他綜合損益按公允價值衡量(FVOCI)之股票處分損益，6月金控合計197.3億元，累計前6月金控合計910.7億元；金控6月本期淨利加計FVOCI權益工具稅後處分利益292.2億元，累計前6月共1,884.1億元，超越歷年全年獲利表現，總計之每股稅後盈餘為13.17元」
  （→ 金控層級當月 29220、累計 188410，總計EPS 13.17 填 adjusted_cumulative_eps）
- 國泰：「國泰金強調，加計FVOCI股票處分損益，累計上半年對保留盈餘之影響數達1,659億元，已超越歷年全年水準」
  （→ 金控層級累計 165900、exact、label 填「對保留盈餘影響數」；國泰通常不揭露金控層級當月加計數）
- 凱基：「凱基金控…單月稅後獲利61.1億元，今年上半年累計稅後獲利284.4億元…若加計6月份的FVOCI股票處分利益，合計達到154.47億元…上半年累計稅後獲利加計FVOCI股票處分利益則為677.75億元」
  （→ 金控層級當月 15447、累計 67775）
⚠️ A、B 兩層級的數字**各自**取自新聞明確揭露的句子；金控層級與壽險層級的加計數**不一定相等**，不可互相套用、不可用差額推算。"""
        holding_search = f"""
5. `{name} 加計FVOCI 獲利`
6. `{name} 對保留盈餘影響數 金控`"""
        holding_output = f"""
"holding": —— 金控「{name}」**合併層級**的加計FVOCI後獲利（找不到時填 {{"found": false, "reason": "..."}}）
{{
  "found": true,
  "value_kind": "exact" 或 "lower_bound",
  "adjusted_cumulative_nt_million": <number；必須大於 {holding_cumul}>,
  "adjusted_monthly_nt_million": <number 或 null；新聞明確揭露金控層級「當月」加計數才填>,
  "adjusted_cumulative_eps": <number 或 null；新聞揭露加計後「總計EPS」才填（如富邦 13.17）>,
  "label": "<新聞用語：「加計FVOCI股票處分利益」或「對保留盈餘影響數」（國泰），擇一照抄>",
  "display_prefix": "<僅 lower_bound 時填：逾／突破／超過>",
  "original_value_text": "<新聞原始字樣>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字與「{name}」金控名稱>"
}}"""
    else:
        task_scope = f"""本任務要抓的是「**{life_sub_name}**」這家壽險公司**自己**的加計FVOCI後獲利（{name} 目前未於新聞稿揭露金控合併層級加計數，"holding" 一律填 null）。"""
        holding_known = ""
        holding_examples = ""
        holding_search = ""
        holding_output = '\n"holding": null（此金控不揭露金控層級加計數，固定填 null）'

    return f"""你是台灣金融分析師。請查詢「{name}（{code}）」**民國 {roc_year} 年 {m} 月（西元 {western_year} 年 {m} 月）月自結損益**新聞，找出「**加計 FVOCI 股票處分利益後的獲利**」——**累計數為必要目標，當月數若新聞有揭露也一併抓取**。

{task_scope}

搜尋限制：工商時報、經濟日報、鉅亨網、自由財經（已透過 allowed_domains 限制，不必加 site:）。

【背景】
2026 年起壽險公司接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L。為了與去年同期可比，各金控會在月損益新聞稿揭露「加計 FVOCI 處分利益後的獲利」——壽險子公司層級為主，115/06 起富邦、國泰、凱基亦揭露**金控合併層級**。

【重要：用語變更（2026年7月起）】
主管機關要求新聞稿**不得使用「調整後獲利」**一詞（與會計原則不符），各公司自 2026 年 6 月損益（7 月發布）的新聞稿起改用新表述，搜尋時新舊用語都要涵蓋：
- 凱基／富邦（壽險與金控層級）：「**加計FVOCI獲利**」「加計FVOCI（股票處分損益）後獲利」
- 國泰（壽險與金控層級）：「**對保留盈餘影響數**」（加計 FVOCI 股票處分損益後對保留盈餘之影響）
- 2026 年 6 月以前的舊新聞才會用「調整後獲利」

【壽險子公司層級的參考新聞語句範例】
- 「凱基人壽6月加計FVOCI獲利154.47億元，累計前6月加計FVOCI獲利為677.75億元」（→ 當月與累計都有）
- 「國泰人壽6月稅後純益113.7億元，累計稅後純益達462.4億元，加計FVOCI股票處分損益，累計前六月對保留盈餘影響數已突破1,300億元」（→ 累計為門檻型 lower_bound，當月未揭露）
- 舊用語（2026年6月前）：「富邦人壽…加計FVOCI股票處分損益後，…累計首季調整後獲利為472.8億」
{holding_examples}
【已知數字（原始 P&L，供你驗證抓到的層級沒抓錯）】
- {life_sub_name} {western_year}/{m:02d} 累計稅後淨利（原始 P&L）：{life_cumul} 百萬元
{monthly_line}
{holding_known}
- 加計 FVOCI 後的數字理論上應**大於**對應層級的原始 P&L

【搜尋查詢建議】
1. `{life_sub_name} {m}月 加計FVOCI 獲利`
2. `{life_sub_name} 對保留盈餘影響數`
3. `{life_sub_name} {western_year} {m}月 FVOCI 億元`
4. `{life_sub_name} 累計 調整後獲利`（舊用語 fallback）{holding_search}

【輸出格式（嚴格 JSON，無前言、無後綴、無 markdown 標記）】
最外層固定為 {{"life": ..., "holding": ...}} 兩個 key：

"life": —— 「{life_sub_name}」壽險公司**自己**的加計FVOCI後獲利（找不到時填 {{"found": false, "reason": "..."}}）
具體數字時：
{{
  "found": true,
  "value_kind": "exact",
  "adjusted_cumulative_nt_million": <number；必須大於 {life_cumul}>,
  "adjusted_monthly_nt_million": <number 或 null；新聞明確揭露「當月」加計FVOCI後獲利才填，否則 null>,
  "original_value_text": "<新聞中原始的數字與單位，例 '677.75 億元'>",
  "source_url": "<新聞 URL>",
  "source_quote": "<引用原句，需含數字與「{life_sub_name}」公司名稱>"
}}
僅揭露區間/門檻（例「突破1,300億」「逾1,000億」）時：value_kind 改 "lower_bound"、adjusted_cumulative_nt_million 填門檻數值（突破1,300億→130000）、多填 "display_prefix": "<逾／突破／超過>"。
{holding_output}

【硬性規則】
- 只能引用搜尋結果中實際出現的數字，禁止瞎編或推算（當月數不可用「累計差額」自行回推；兩層級數字不可互相套用）
- source_quote 必須清楚帶有對應層級的公司名稱（壽險層級＝「{life_sub_name}」、金控層級＝「{name}」）
- 「稅後純益」「稅後淨利」本身**不是**加計FVOCI後的數字，不要誤填；要找的是明確標示「加計FVOCI」「對保留盈餘影響數」（或舊稿「調整後獲利」）的數字
- 數字單位轉換：億 → ×100；皆換算成「百萬元」填入
- **value_kind 判定**：新聞給「具體精確數字」用 `exact`；只給「逾／突破／超過／上看 X 億」這類門檻、沒有精確值時用 `lower_bound`。有精確數字時一律用 exact，不要因為出現「逾」字就誤判（例：國泰金控層級「達1,659億元」是 exact）
- adjusted_cumulative_nt_million 必須大於對應層級的原始累計 P&L（加計處分利益會更大）；若搜到的數字反而較小，可能抓錯層級，該層級視為 found=false
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


def fetch_one(client, name, code, period, life_sub_name, life_cumul, life_monthly=None,
              want_holding=False, holding_cumul=None, holding_monthly=None, debug=False):
    """呼叫 Claude API + web_search（單次呼叫同時抓壽險＋金控兩層級），遇 429 退避重試最多 3 次"""
    import anthropic as _anthropic
    prompt = _build_prompt(
        name, code, period, life_sub_name, life_cumul, life_monthly,
        want_holding=want_holding, holding_cumul=holding_cumul, holding_monthly=holding_monthly,
    )
    last_err = None
    for attempt in range(3):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=1600,
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


def _level_needs(target, force=False, override_manual=False):
    """單一層級（life_sub 或 holding_company dict）是否需要抓取。
    manual=true 一律保留（除非 --override-manual）；已有結果或撲空滿 3 次則跳過（除非 --force）。"""
    if target is None:
        return False
    existing = target.get("fvoci_adjusted")
    if existing and existing.get("manual") and not override_manual:
        return False
    if force:
        return True
    if existing:
        return False
    if target.get("fvoci_not_found_count", 0) >= 3:
        return False
    return True


def _company_needs_api(company, force=False, override_manual=False):
    """此金控本輪是否需要呼叫 LLM（任一層級需要即為 True）。供 main() 的 sleep 判斷共用。"""
    code = company.get("code", "")
    if "error" in company or code not in LIFE_INSURANCE_CODES:
        return False
    life_sub = find_life_subsidiary(company.get("subsidiaries", []))
    if life_sub is None:
        return False
    holding = company.get("holding_company") if code in HOLDING_FVOCI_CODES else None
    return (
        _level_needs(life_sub, force, override_manual)
        or (holding is not None and _level_needs(holding, force, override_manual))
    )


def _apply_level(parsed_level, target, entity_name, original_cumul, original_monthly, period):
    """
    驗證 LLM 回傳的單一層級結果並寫入 target["fvoci_adjusted"]。
    回傳 'updated' / 'not_found' / 'failed'。
    驗證項目（兩層級相同）：加計累計 > 原始累計、加計當月 >= 原始當月（不過只丟當月）、
    來源日期防呆（公告月份之前的新聞必為事前預估稿）、lower_bound 門檻型處理。
    """
    def _miss(msg, level="warning"):
        target["fvoci_not_found_count"] = target.get("fvoci_not_found_count", 0) + 1
        getattr(logger, level)(f"[{entity_name}] {msg} (retry {target['fvoci_not_found_count']}/3)")
        return "not_found"

    if not isinstance(parsed_level, dict):
        return _miss("missing level object in LLM output")
    if not parsed_level.get("found"):
        return _miss(f"not found: {parsed_level.get('reason', '')}", level="info")

    adjusted = parsed_level.get("adjusted_cumulative_nt_million")
    if not isinstance(adjusted, (int, float)):
        logger.warning(f"[{entity_name}] invalid adjusted_cumulative_nt_million: {adjusted}")
        return "failed"
    if original_cumul is not None and adjusted <= original_cumul:
        return _miss(
            f"adjusted ({adjusted}) <= original ({original_cumul}), "
            f"discarding (likely wrong level or concept)"
        )

    # 來源日期防呆：公告月份之前的新聞必為「事前預估／掌握」稿，非實際月自結數字。
    # 要求來源發布日 >= 公告月份第一天；URL 無日期者無法驗證，維持放行。
    src_date = _extract_source_date(parsed_level.get("source_url", ""))
    ann_start = _announcement_month_start(period)
    if src_date and src_date < ann_start:
        return _miss(
            f"source dated {src_date} < announcement month start {ann_start} "
            f"(pre-announcement estimate), discarding"
        )

    # 當月加計數（選填）：FVOCI 處分利益 >= 0，加計後不應小於原始當月 P&L；
    # 驗證不過只丟棄當月數，不影響累計數
    adjusted_monthly = parsed_level.get("adjusted_monthly_nt_million")
    if not isinstance(adjusted_monthly, (int, float)):
        adjusted_monthly = None
    elif original_monthly is not None and adjusted_monthly < original_monthly:
        logger.warning(
            f"[{entity_name}] adjusted monthly ({adjusted_monthly}) < original monthly "
            f"({original_monthly}), discarding monthly figure only"
        )
        adjusted_monthly = None

    value_kind = parsed_level.get("value_kind", "exact")
    adj = {}
    if value_kind == "lower_bound":
        # 門檻型（如「突破1,300億」）：存下界 + display_prefix，不存 delta、不算 YoY
        adj["value_type"] = "lower_bound"
    adj["cumulative_profit"] = round(adjusted, 1)
    if adjusted_monthly is not None:
        adj["monthly_profit"] = round(adjusted_monthly, 1)
    if value_kind == "lower_bound":
        adj["display_prefix"] = parsed_level.get("display_prefix", "逾")
    elif original_cumul is not None:
        adj["delta_vs_original"] = round(adjusted - original_cumul, 1)

    # 金控層級選填欄位：label（國泰「對保留盈餘影響數」，前端以此覆寫列標籤）、
    # 加計後總計 EPS（富邦揭露，如 13.17）
    label = parsed_level.get("label")
    if isinstance(label, str) and "保留盈餘" in label:
        adj["label"] = "對保留盈餘影響數"
    eps = parsed_level.get("adjusted_cumulative_eps")
    if isinstance(eps, (int, float)) and eps > 0:
        adj["cumulative_eps"] = round(eps, 2)

    adj["source_url"] = parsed_level.get("source_url", "")
    adj["source_quote"] = parsed_level.get("source_quote", "")
    adj["original_value_text"] = parsed_level.get("original_value_text", "")
    adj["generated_at"] = datetime.now().isoformat()

    target["fvoci_adjusted"] = adj
    target.pop("fvoci_not_found_count", None)
    kind_txt = f"lower_bound（{adj.get('display_prefix', '逾')}）" if value_kind == "lower_bound" else "exact"
    logger.info(
        f"[{entity_name}] fvoci_adjusted written ({kind_txt}): "
        f"cumul {adj['cumulative_profit']} NT$m, monthly {adj.get('monthly_profit', '—')}"
    )
    return "updated"


def process_company(client, company, period, force=False, debug=False, override_manual=False):
    """
    對單一金控公司處理 FVOCI 加計後獲利——壽險子公司＋金控合併兩層級，單次 LLM 呼叫。
    回傳 dict：{"life": status, "holding": status, "called_api": bool}；
    status ∈ 'updated' / 'skipped' / 'not_found' / 'failed'，該層級不適用時為 None。
    """
    code = company.get("code", "")
    name = company.get("name", "")

    if "error" in company or code not in LIFE_INSURANCE_CODES:
        return {"life": None, "holding": None, "called_api": False}

    life_sub = find_life_subsidiary(company.get("subsidiaries", []))
    if not life_sub:
        logger.info(f"[{name}] no life subsidiary found")
        return {"life": None, "holding": None, "called_api": False}

    holding = company.get("holding_company") if code in HOLDING_FVOCI_CODES else None

    need_life = _level_needs(life_sub, force, override_manual)
    need_holding = holding is not None and _level_needs(holding, force, override_manual)

    if need_life and life_sub.get("cumulative_profit") is None:
        logger.warning(f"[{name}] life sub has no cumulative_profit, cannot validate; skip life level")
        need_life = False
    if need_holding and holding.get("cumulative_profit") is None:
        logger.warning(f"[{name}] holding has no cumulative_profit, cannot validate; skip holding level")
        need_holding = False

    result = {
        "life": "skipped",
        "holding": "skipped" if holding is not None else None,
        "called_api": False,
    }
    if not need_life and not need_holding:
        logger.info(f"[{name}] both levels present/skipped (manual or done), no API call")
        return result

    life_sub_name = life_sub.get("name", "壽險子公司")
    logger.info(
        f"[{name}] fetching FVOCI adjustment "
        f"(life={'Y' if need_life else 'skip'}, holding={'Y' if need_holding else ('skip' if holding is not None else 'n/a')})..."
    )

    try:
        parsed, raw = fetch_one(
            client, name, code, period,
            life_sub_name, life_sub.get("cumulative_profit"),
            life_monthly=life_sub.get("monthly_profit"),
            # 只要是有揭露金控層級的金控就把 B 段放進 prompt（保持敘述真實），
            # 但僅在 need_holding 時把結果寫入
            want_holding=holding is not None,
            holding_cumul=holding.get("cumulative_profit") if holding is not None else None,
            holding_monthly=holding.get("monthly_profit") if holding is not None else None,
            debug=debug,
        )
    except Exception as e:
        logger.error(f"[{name}] LLM call failed: {e}")
        result["called_api"] = True
        if need_life:
            result["life"] = "failed"
        if need_holding:
            result["holding"] = "failed"
        return result

    result["called_api"] = True
    if not parsed:
        logger.warning(f"[{name}] could not parse JSON from response: {raw[:200]}")
        if need_life:
            result["life"] = "failed"
        if need_holding:
            result["holding"] = "failed"
        return result

    if need_life:
        result["life"] = _apply_level(
            parsed.get("life"), life_sub, f"{name}/{life_sub_name}",
            life_sub.get("cumulative_profit"), life_sub.get("monthly_profit"), period,
        )
    if need_holding:
        result["holding"] = _apply_level(
            parsed.get("holding"), holding, f"{name}/金控合併",
            holding.get("cumulative_profit"), holding.get("monthly_profit"), period,
        )
    return result


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

    # 每層級各自計數（life = 壽險子公司層級、holding = 金控合併層級）
    counts = {"updated": 0, "skipped": 0, "not_found": 0, "failed": 0}
    api_calls = 0
    for company in companies:
        if args.codes and company.get("code") not in args.codes:
            continue

        # 第二次 API call 起 sleep（避開 rate limit）；與 process_company 共用同一判斷
        if api_calls > 0 and _company_needs_api(company, args.force, args.override_manual):
            logger.info(f"Sleeping {args.inter_call_sleep}s before next call...")
            time.sleep(args.inter_call_sleep)

        result = process_company(
            client, company, period,
            force=args.force, debug=args.debug, override_manual=args.override_manual,
        )
        if result["called_api"]:
            api_calls += 1
        for level in ("life", "holding"):
            status = result.get(level)
            if status:
                counts[status] = counts.get(status, 0) + 1

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
        f"Saved {period_file.name} (levels): updated={counts['updated']}, "
        f"not_found={counts['not_found']}, skipped={counts['skipped']}, "
        f"failed={counts['failed']}; api_calls={api_calls}"
    )

    # 同步 latest.json ↔ 對應月份歸檔
    archive_path = DATA_DIR / f"{period.replace('/', '-')}.json" if period else None
    latest_path = DATA_DIR / "latest.json"
    other = archive_path if period_file.name == "latest.json" else latest_path
    if other and other != period_file:
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
            logger.info(f"Also synced {other.name}")


if __name__ == "__main__":
    main()
