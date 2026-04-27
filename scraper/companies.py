# companies.py
# 台灣 13 家上市金控公司設定檔
# 最後更新：2026-04-21
# 來源：金管會上市金控名單
#
# 異動記錄：
#   - 2880 華南金控：補入（原本漏掉）
#   - 2883 開發金 → 凱基金控（2024年更名）
#   - 2887 台灣金 → 台新新光金控（2025年台新金+新光金合併）
#   - 2888 新光金：移除（已下市，併入 2887）

FINANCIAL_HOLDINGS = [
    {
        "code": "2880",
        "name": "華南金",
        "full_name": "華南金控",
        "short": "hnfhc",
        "subsidiaries_hint": ["華南銀行", "華南證券", "華南產險", "華南投信"],
    },
    {
        "code": "2881",
        "name": "富邦金",
        "full_name": "富邦金控",
        "short": "fubon",
        "subsidiaries_hint": ["富邦人壽", "台北富邦銀行", "富邦證券", "富邦產險", "富邦投信"],
    },
    {
        "code": "2882",
        "name": "國泰金",
        "full_name": "國泰金控",
        "short": "cathay",
        "subsidiaries_hint": ["國泰人壽", "國泰世華銀行", "國泰產險", "國泰證券", "國泰投信"],
    },
    {
        "code": "2883",
        "name": "凱基金",
        "full_name": "凱基金控",
        "short": "kgi",
        "subsidiaries_hint": ["凱基人壽", "凱基銀行", "凱基證券", "凱基投信", "中華開發資本"],
    },
    {
        "code": "2884",
        "name": "玉山金",
        "full_name": "玉山金控",
        "short": "esun",
        "subsidiaries_hint": ["玉山銀行", "玉山證券", "玉山創投", "玉山投信"],
    },
    {
        "code": "2885",
        "name": "元大金",
        "full_name": "元大金控",
        "short": "yuanta",
        "subsidiaries_hint": ["元大銀行", "元大證券", "元大期貨", "元大人壽", "元大投信"],
    },
    {
        "code": "2886",
        "name": "兆豐金",
        "full_name": "兆豐金控",
        "short": "mega",
        "subsidiaries_hint": ["兆豐銀行", "兆豐證券", "兆豐票券", "兆豐產險"],
    },
    {
        "code": "2887",
        "name": "台新新光金",
        "full_name": "台新新光金控",
        "short": "tsnsfhc",
        "subsidiaries_hint": ["台新銀行", "新光銀行", "新光人壽", "台新證券", "元富證券", "台新投信"],
    },
    {
        "code": "2889",
        "name": "國票金",
        "full_name": "國票金控",
        "short": "ibf",
        "subsidiaries_hint": ["國際票券", "國票證券"],
    },
    {
        "code": "2890",
        "name": "永豐金",
        "full_name": "永豐金控",
        "short": "sinopac",
        "subsidiaries_hint": ["永豐銀行", "永豐金證券", "永豐產險"],
    },
    {
        "code": "2891",
        "name": "中信金",
        "full_name": "中信金控",
        "short": "ctbc",
        "subsidiaries_hint": ["中國信託銀行", "台灣人壽", "中信證券", "中信投信"],
    },
    {
        "code": "2892",
        "name": "第一金",
        "full_name": "第一金控",
        "short": "firstfh",
        "subsidiaries_hint": ["第一銀行", "第一金證券", "第一金投信", "第一金人壽"],
    },
    {
        "code": "5880",
        "name": "合庫金",
        "full_name": "合庫金控",
        "short": "tcfhc",
        "subsidiaries_hint": ["合作金庫銀行", "合庫人壽", "合庫證券", "合庫產險", "合庫投信"],
    },
]

# 公告標題關鍵字（用於模糊匹配月自結損益公告）
ANNOUNCEMENT_KEYWORDS = [
    "合併自結損益",
    "自結損益",
    "月合併損益",
    "月自結",
    "合併損益",
    "自結盈餘",
    "自結合併盈餘",
    "自結業績",
]

# 用字典方便依代號查詢
HOLDINGS_BY_CODE = {c["code"]: c for c in FINANCIAL_HOLDINGS}
