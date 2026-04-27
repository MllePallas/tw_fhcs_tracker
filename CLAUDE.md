# CLAUDE.md — Taiwan Financial Holdings Tracker

## 專案目的

自動爬取台灣 13 家上市金控的月自結損益公告（公開資訊觀測站），產生 JSON 資料，透過 GitHub Pages 公開展示。

每月 8~15 日，各金控會在 MOPS 公告上個月的合併稅後淨利（含子公司明細）。GitHub Actions 自動爬取並更新網站。

---

## 目錄結構

```
tw_fhcs_tracker/
├── scraper/
│   ├── companies.py      # 13 家金控設定（代號、名稱、子公司提示）
│   ├── mops_client.py    # MOPS API 客戶端（2025 新版 gateway）
│   ├── parser.py         # HTML 解析器（規則 + LLM fallback）
│   └── main.py           # 主程式，產生 JSON，更新 index.json
├── docs/                 # GitHub Pages 服務根目錄（原為 web/）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/             # ★ 資料檔放在 docs/data/，不是 repo root 的 data/
│       ├── index.json    # 月份索引
│       ├── latest.json   # 最新月份資料
│       ├── 115-01.json   # 月份歸檔（民國年-月）
│       ├── 115-02.json
│       └── 115-03.json
├── .github/workflows/
│   └── update_data.yml   # 每月 8~15 日 09:00 台灣時間自動執行
├── .env                  # 本地用（ANTHROPIC_API_KEY），已加入 .gitignore
├── requirements.txt
└── PROGRESS.md           # 人工記錄的進度筆記
```

**重要**：GitHub Pages 設定為 branch `main` + folder `/docs`。`scraper/main.py` 的 `DATA_DIR` 指向 `docs/data/`，不是 repo root 的 `data/`。

---

## MOPS API（2025 改版後）

MOPS 在 2025 年改版為 SPA，舊的直接 POST `ajax_t05st02` 已失效。

### 新流程

```
1. POST https://mops.twse.com.tw/mops/api/redirectToOld
   Body: {"apiName": "ajax_t05st01", "parameters": {"co_id": "2881", "year": "115", "month": "03", ...}}

2. 回傳: {"code": 200, "result": {"url": "https://mopsov.twse.com.tw/..."}}
   （URL 含加密 token，有效期短）

3. GET 該加密 URL → 取得 HTML（公告清單）

4. 從清單找到目標公告的 seq_no

5. 再次 POST redirectToOld（apiName: "ajax_t05st02"）取得公告詳細 HTML
```

### 關鍵參數

- 年份：民國年（`year="115"` 代表 2026）
- 查詢月份為**公告月份**（N月資料在N+1月公告）
  - 例：搜尋 3月資料 → 查詢 4月的公告（`month="04"`）
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
      "success_count": 12,
      "last_updated": "2026-04-21T18:39:56"
    }
  ]
}
```

月份依**新到舊**排序，`latest` 指向最新期間。

### docs/data/115-03.json（月份資料）

```json
{
  "report_period": "115/03",
  "last_updated": "2026-04-21T18:39:56",
  "success_count": 12,
  "fail_count": 1,
  "companies": [
    {
      "code": "2881",
      "name": "富邦金",
      "holding_company": {
        "name": "富邦金控",
        "monthly_profit": 2570.0,
        "cumulative_profit": 33270.0
      },
      "subsidiaries": [
        {"name": "台北富邦銀行", "monthly_profit": 3590.0, "cumulative_profit": 12160.0}
      ],
      "unit": "百萬元",
      "report_month": "115/03",
      "parse_method": "llm"
    }
  ]
}
```

**所有數字單位統一為 NT$m（百萬元）**。億元×100、千元÷1000。

---

## 13 家金控（含異動記錄）

| 代號 | 簡稱 | 備註 |
|------|------|------|
| 2880 | 華南金 | 後來補入，115/03 前的資料可能缺少 |
| 2881 | 富邦金 | |
| 2882 | 國泰金 | |
| 2883 | 凱基金 | 原名「開發金」，2024年更名；MOPS 公告標題仍可能出現舊名 |
| 2884 | 玉山金 | |
| 2885 | 元大金 | |
| 2886 | 兆豐金 | |
| 2887 | 台新新光金 | 2025年台新金+新光金合併，MOPS 舊資料可能殘留「台灣金」 |
| 2889 | 國票金 | |
| 2890 | 永豐金 | |
| 2891 | 中信金 | |
| 2892 | 第一金 | |
| 5880 | 合庫金 | |

**已移除**：2888 新光金（已下市，併入 2887）

---

## 已知 Bug 與修正

### 1. retry 導致月份錯誤（mops_client.py）

**症狀**：網路錯誤被吞成 `[]`，`main.scrape_company` 誤判為「無公告」，觸發擴大搜尋（-60天），導致月份偏移（例如搜尋 4 月卻找到 1 月的公告）。

**修正方向**：`mops_client` 加 retry，讓網路錯誤不再回傳空 `[]`。

### 2. find_profit_announcement 第三輪 fallback 誤匹配（parser.py）

**症狀**：第三輪 fallback「不限月份」會把去年 12 月的公告匹配回來。

**修正方向**：移除第三輪 fallback，或加入月份合理性驗證。

### 3. 2883 名稱不一致

MOPS 公告標題有時顯示「開發金」，`companies.py` 設定為「凱基金」。解析後 `name` 欄位以 `companies.py` 的設定為準。

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

# 調整請求間隔（秒）
python main.py --delay 5
```

**輸出位置**：`docs/data/latest.json`、`docs/data/115-03.json`、`docs/data/index.json`

---

## GitHub Actions

- **觸發**：每月 8~15 日 01:00 UTC（台灣時間 09:00）
- **手動觸發**：GitHub → Actions → "Update Financial Holdings Data" → Run workflow
- **Secret**：`ANTHROPIC_API_KEY`（repo Settings → Secrets → Actions）
- **commit bot**：`github-actions[bot]`，自動 push 到 `docs/data/`

---

## GitHub Pages

- **URL**：`https://mllepallas.github.io/tw_fhcs_tracker/`
- **設定**：Settings → Pages → Branch: `main`, Folder: `/docs`
- **部署方式**：push 到 main 後自動更新（約 1 分鐘）

---

## 前端 app.js 載入流程

```
1. fetch("./data/index.json")        → 取得月份清單
2. renderMonthSelector(months)       → 建立 dropdown
3. loadData("115/03")                → fetch("./data/115-03.json")
4. renderAll()                       → 表格 + 圖表
```

單位換算在前端做（`displayUnit`：百萬元 / 億元），JSON 內一律儲存百萬元。

---

## 注意事項

- MOPS 有反爬機制，請求間隔建議 3~5 秒（`--delay` 參數）
- LLM（claude-opus-4-6）用於解析複雜 HTML，費用約 $0.01~0.05 USD/家
- 民國年換算：西元年 - 1911 = 民國年（2026 = 115）
- `docs/data/` 的 JSON 不可有 BOM 或亂碼（OneDrive 同步偶爾會損壞檔案）
