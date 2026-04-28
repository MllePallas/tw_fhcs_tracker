# CLAUDE.md — Taiwan Financial Holdings Tracker

> 最後更新：2026-04-28

## 專案目的

自動爬取台灣 13 家上市金控的月自結損益公告（公開資訊觀測站），產生 JSON 資料，透過 GitHub Pages 公開展示。每月各金控在 MOPS 公告上個月的合併稅後淨利（含子公司明細、EPS、新聞摘要）。

---

## 目錄結構

```
tw_fhcs_tracker/
├── scraper/
│   ├── companies.py      # 13 家金控設定（代號、名稱、子公司提示）
│   ├── mops_client.py    # MOPS API 客戶端（2025 新版 gateway，含 retry）
│   ├── parser.py         # HTML 解析器（規則 + LLM fallback，含 EPS）
│   ├── news_summary.py   # 新聞摘要產生器（Claude API + web_search）
│   └── main.py           # 主程式，產生 JSON，更新 index.json
├── docs/                 # GitHub Pages 服務根目錄（原為 web/）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/             # ★ 資料檔放在 docs/data/，不是 repo root
│       ├── index.json    # 月份索引
│       ├── latest.json   # 最新月份資料（與最新月份 JSON 同內容）
│       ├── 115-01.json
│       ├── 115-02.json
│       └── 115-03.json
├── .github/workflows/
│   └── update_data.yml   # 每月 8~31 日自動執行（含 short-circuit）
├── .env                  # 本地用（ANTHROPIC_API_KEY），已加入 .gitignore
├── requirements.txt
├── PROGRESS.md           # 人工進度筆記
└── CLAUDE.md             # 本檔案
```

**重要**：GitHub Pages 設定為 branch `main` + folder `/docs`。`scraper/main.py` 的 `DATA_DIR` 指向 `docs/data/`，不是 repo root 的 `data/`。

---

## MOPS API（2025 改版後）

MOPS 在 2025 年改版為 SPA，舊的直接 POST `ajax_t05st02` 已失效。

### 新流程

```
1. POST https://mops.twse.com.tw/mops/api/redirectToOld
   Body: {"apiName": "ajax_t05st01", "parameters": {"co_id": "2881", "year": "115", "month": "04", ...}}
   （查詢公告月份，不是資料月份 → 3月資料在4月公告）

2. 回傳: {"code": 200, "result": {"url": "https://mopsov.twse.com.tw/..."}}
   （加密 URL，有效期短）

3. GET 該加密 URL → 取得 HTML（公告清單）

4. 從清單找到目標公告的 seq_no

5. 再次 POST redirectToOld（apiName: "ajax_t05st02"）取得公告詳細 HTML
```

### Retry 機制（mops_client.py）

步驟 1 與步驟 5 均有 3-attempt 指數退避 retry。只有三次都失敗才回傳 `[]`，避免網路短暫錯誤被誤判為「無公告」導致月份偏移。

### 關鍵參數

- 年份：民國年（`year="115"` 代表 2026）
- 查詢月份為**公告月份**（N月資料在N+1月公告，例：3月資料查4月）
- `TYPEK`: 上市公司用 `"sii"`

---

## 資料格式

### docs/data/index.json

```json
{
  "latest": "115/03",
  "months": [
    {
      "period": "115/03",
      "file": "115-03.json",
      "success_count": 13,
      "last_updated": "2026-04-28T10:00:00"
    }
  ]
}
```

月份依**新到舊**排序，`latest` 指向最新期間。

### docs/data/115-03.json（月份資料結構）

```json
{
  "report_period": "115/03",
  "last_updated": "2026-04-28T10:00:00",
  "success_count": 13,
  "fail_count": 0,
  "companies": [
    {
      "code": "2881",
      "name": "富邦金",
      "announcement_date": "115/04/15",
      "announcement_title": "公告本公司暨主要子公司115年3月合併自結損益",
      "source_url": "https://mops.twse.com.tw/...",
      "holding_company": {
        "name": "富邦金控",
        "monthly_profit": 2570.0,
        "cumulative_profit": 33270.0,
        "monthly_eps": null,
        "cumulative_eps": 3.52
      },
      "subsidiaries": [
        {
          "name": "台北富邦銀行",
          "monthly_profit": 3590.0,
          "cumulative_profit": 12160.0,
          "monthly_eps": null,
          "cumulative_eps": null
        }
      ],
      "unit": "百萬元",
      "report_month": "115/03",
      "parse_method": "llm",
      "news_summary": "富邦金3月自結...",
      "news_sources": ["https://ctee.com.tw/..."],
      "news_generated_at": "2026-04-28T10:05:00"
    }
  ]
}
```

**單位規則**：所有 profit 數字統一為 **NT$m（百萬元）**。億元×100、千元÷1000。EPS 單位固定「元」，不換算。

---

## EPS 欄位說明（parser.py）

- `monthly_eps`：當月稅後 EPS（元）；多數公司公告只列累計，此欄通常為 `null`
- `cumulative_eps`：累計稅後 EPS（元）；母公司業主應占為準（不是合併總損益）
- 解析時抓「**母公司業主**」欄，不抓「總損益」（後者含少數股東，會高估）
- 若公告完全無 EPS 資料，兩欄皆為 `null`

---

## 新聞摘要（news_summary.py）

每月 13 家全部收齊後，自動補上各家的新聞摘要。

```bash
cd scraper
python news_summary.py              # 補齊最新月份（冪等：已有摘要的跳過）
python news_summary.py --force      # 強制重新產生所有摘要
python news_summary.py --month 115/02  # 指定月份
```

**來源限定**：工商時報（ctee.com.tw）、經濟日報（money.udn.com）、鉅亨網（news.cnyes.com）

**模型**：`claude-sonnet-4-6`（含 web_search 工具）

**輸出欄位**：`news_summary`（~150字繁中）、`news_sources`（URL 列表）、`news_generated_at`

若查無相關報導，`news_summary` 填 `"無相關說明"`。

---

## 13 家金控（含異動記錄）

| 代號 | 簡稱 | 備註 |
|------|------|------|
| 2880 | 華南金 | 後來補入，115/01 前的資料可能缺少 |
| 2881 | 富邦金 | |
| 2882 | 國泰金 | |
| 2883 | 凱基金 | 原名「開發金」，2024年更名；MOPS 公告標題仍可能出現舊名 |
| 2884 | 玉山金 | |
| 2885 | 元大金 | |
| 2886 | 兆豐金 | |
| 2887 | 台新新光金 | 2025年台新金+新光金合併；MOPS 舊資料可能殘留「台灣金」 |
| 2889 | 國票金 | |
| 2890 | 永豐金 | |
| 2891 | 中信金 | |
| 2892 | 第一金 | |
| 5880 | 合庫金 | |

**已移除**：2888 新光金（已下市，併入 2887）

---

## 本地執行

```bash
# 設定環境變數（或建立 .env）
export ANTHROPIC_API_KEY=sk-ant-api03-...

cd scraper

# 爬取上個月（自動判斷）
python main.py

# 爬取指定月份
python main.py --month 115/03

# 只爬特定公司
python main.py --month 115/04 --codes 2881 2882

# 停用 LLM（純規則解析）
python main.py --no-llm

# 調整請求間隔（秒，預設 3.0）
python main.py --delay 5

# 補上新聞摘要（爬完之後）
python news_summary.py
```

**輸出位置**：`docs/data/latest.json`、`docs/data/115-03.json`、`docs/data/index.json`

---

## GitHub Actions（update_data.yml）

### 觸發規則

- **排程**：每月 **8~31 日**，UTC 09:00 與 12:00（台灣時間 17:00 / 20:00）各一次
- **Short-circuit**：schedule 觸發時，若 `latest.json` 已顯示目標月份 `success_count >= 13`，直接跳過所有步驟（節省 API 費用）
- **手動觸發**：Actions → Run workflow（不受 short-circuit 限制，方便補跑）

### 執行步驟

1. Checkout repo
2. 檢查是否已收齊（schedule only）
3. 安裝 Python 依賴（`requirements.txt`，不含 playwright）
4. 執行 `scraper/main.py`
5. 若 success_count ≥ 13，執行 `scraper/news_summary.py`（冪等）
6. `git add docs/data/` → commit → push

### Secret

`ANTHROPIC_API_KEY`（repo Settings → Secrets → Actions）

---

## GitHub Pages

- **URL**：`https://mllepallas.github.io/tw_fhcs_tracker/`
- **設定**：Settings → Pages → Branch: `main`, Folder: `/docs`
- **部署**：push 到 main 後自動更新（約 1 分鐘）
- **更新按鈕**：已移除（網站為唯讀展示，更新由 Actions 負責）

---

## 前端 app.js 功能

### 資料載入流程

```
fetch("./data/index.json") → renderMonthSelector() → loadData("115/03")
→ fetch("./data/115-03.json") → renderAll()
```

### 功能清單

- 月份選單（dropdown）：依 index.json 動態建立
- 排序：代號 / 當月↓ / 累計↓ / 累計 EPS↓
- 單位切換：百萬元（NT$m）/ 億元（前端換算，JSON 存百萬元）
- 摘要卡片：合計當月、合計累計 YTD、當月第一、累計第一
- 主表格：代號、金控名、當月獲利（含 bar）、累計 YTD、累計 EPS
- 子公司展開：點金控名稱顯示子公司明細 + bar chart
- 新聞摘要：子公司面板底部顯示
- 雙圖表：當月獲利橫條圖（藍）+ 累計 YTD 橫條圖（綠）

---

## 已知問題與注意事項

- **2883 名稱不一致**：MOPS 公告標題有時顯示「開發金」，程式以 `companies.py` 的「凱基金」為準
- **`monthly_eps` 多為 null**：金控月報通常只公告累計 EPS，不公告單月 EPS
- **OneDrive 同步可能損壞 JSON**：`docs/data/` 的 JSON 偶爾被 OneDrive 填入大量空白 padding，導致解析失敗。修復方式：用 `data/` root 的乾淨版本覆蓋
- **民國年換算**：西元年 − 1911 = 民國年（2026 = 115）
- **MOPS 請求間隔**：建議 3~5 秒（`--delay` 參數），避免被限流
- **LLM 費用估計**：約 $0.01~0.05 USD / 家（claude-opus-4-6 解析 HTML）
