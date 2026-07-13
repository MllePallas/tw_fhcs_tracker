# CLAUDE.md — Taiwan Financial Holdings Tracker

> 最後更新：2026-05-15

## 專案目的

自動爬取台灣 13 家上市金控的月自結損益公告（公開資訊觀測站），產生 JSON 資料，透過 GitHub Pages 公開展示。每月各金控在 MOPS 公告上個月的合併稅後淨利（含子公司明細、EPS、新聞摘要）。

---

## 目錄結構

```
tw_fhcs_tracker/
├── scraper/
│   ├── companies.py            # 13 家金控設定（代號、名稱、子公司提示）
│   ├── mops_client.py          # MOPS API 客戶端（2025 新版 gateway，含 retry）
│   ├── parser.py               # HTML 解析器（規則 + LLM fallback，含 EPS）
│   ├── news_summary.py         # 新聞摘要產生器（Claude API + web_search）
│   ├── fvoci_adjustment.py     # 壽險 IFRS 17：抓金控揭露之調整後獲利、推算到壽險子公司
│   ├── market_summary.py       # 本月市場概況（FX/指數/殖利率，yfinance + TWSE）
│   ├── bootstrap_history.py    # 一次性：批次爬取整年歸檔（YoY baseline）
│   └── main.py                 # 主程式，產生 JSON、計算 YoY、更新 index.json
├── docs/                       # GitHub Pages 服務根目錄（原為 web/）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/                   # ★ 資料檔放在 docs/data/，不是 repo root
│       ├── index.json          # 月份索引
│       ├── latest.json         # 最新月份資料（與最新月份 JSON 同內容）
│       ├── 114-01.json ~ 114-12.json   # YoY baseline（2026-04-28 一次爬完）
│       ├── 115-01.json
│       ├── 115-02.json
│       └── 115-03.json
├── .github/workflows/
│   ├── update_data.yml         # 每月 8~31 日 MOPS 爬蟲（含 short-circuit）
│   └── update_market.yml       # 每月 5 號市場概況（yfinance + TWSE）
├── .env                        # 本地用（ANTHROPIC_API_KEY），已加入 .gitignore
├── requirements.txt
├── PROGRESS.md                 # 人工進度筆記
└── CLAUDE.md                   # 本檔案
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
        "cumulative_profit_yoy_pct": -19.1,
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
      "news_sources": [{"url": "https://ctee.com.tw/...", "title": "..."}],
      "news_generated_at": "2026-04-28T10:05:00"
    }
  ],
  "market_summary": {
    "period": "115/03",
    "generated_at": "2026-04-28T14:17:32",
    "items": {
      "usdtwd":         {"value": 32.039, "prev_value": 31.2468, "pct_change": 2.54, ...},
      "taiex":          {"value": 31722.99, "prev_value": 35414.49, "pct_change": -10.42, ...},
      "taiex_turnover": {"value_yi": 8166.6, "prev_value_yi": 8154.2, "pct_change": 0.15, ...},
      "spx":            {"value": 6528.52, "prev_value": 6878.88, "pct_change": -5.09, ...},
      "us10y":          {"value_pct": 4.311, "prev_value_pct": 3.962, "bps_change": 35, ...}
    }
  }
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

## 累計 YoY 欄位（main.py: compute_yoy）

每次 `main.py` 跑完爬取後，自動讀**去年同期歸檔**（例：115/03 → 讀 `114-03.json`），計算累計獲利 YoY。

- 公式：`(curr - prev) / abs(prev) × 100`（prev 為負時不會反轉）
- 寫入 `holding_company.cumulative_profit_yoy_pct`（一位小數）
- **跨零點（虧轉盈 / 盈轉虧）特殊處理**：
  - `cumulative_profit_yoy_abs`：絕對差額 `curr - prev`（NT$m，整數），同號時也會寫入
  - `cumulative_profit_yoy_status`：`"loss_to_profit"`（prev<0, curr>0）/ `"profit_to_loss"`（prev>0, curr<0）；同號時欄位省略
  - 前端：status 存在時改顯示「虧轉盈 +X 億」/「盈轉虧 -X 億」，不顯示百分比（因為跨零點時 % 在數學上可算但語意誤導，例如元大人壽 114/04 -4.6 億 → 115/04 +19.14 億，pct 為 +516% 看似 6 倍成長，實為由虧轉盈）
  - 排序：跨零點案例獨立分層（虧轉盈最高、盈轉虧最低），同層內依 pct 排序
- 子公司、`fvoci_adjusted` 的 YoY 欄位亦套用同樣三件組（`yoy_pct` / `yoy_abs` / `yoy_status`）
- **M&A cutoff（`YOY_CUTOFFS`）**：2887 台新新光金合併於 2025-07-24，114/07 起就是合併後資料；因此 cutoff 設為 `115/07`，**`target_period < 115/07` 時跳過**（115/01-06 顯示 `—`），115/07 以後可正常算 YoY
- **子公司白名單（`YOY_SUB_ALLOWED_PRE_CUTOFF`）**：cutoff 適用時通常整家子公司一起跳過，但若某子公司尚未實質整併、且 baseline 對得齊，可加入白名單照常算 YoY。目前 `2887` 旗下 `台新銀行` 為唯一例外（台新銀行尚未與新光銀行合併，114 年 baseline 以「台新銀行」獨立存在）→ 115/01-06 期間 2887 holding 顯示 `—`，但台新銀行子公司列會顯示 YoY
- baseline 不存在或公司缺資料時，欄位省略不寫，前端顯示 `—`

### 對既有 JSON 補 YoY（不必重爬）

```python
import sys, json; sys.path.insert(0, 'scraper')
from main import compute_yoy
with open('docs/data/115-03.json', encoding='utf-8') as f: d = json.load(f)
compute_yoy(d, '115/03')
with open('docs/data/115-03.json', 'w', encoding='utf-8') as f: json.dump(d, f, ensure_ascii=False, indent=2)
```

---

## 本月市場概況（market_summary.py）

每月 11 號 cron 跑（與 MOPS 月損益排程同日，早幾小時），抓 6 項指標：

| 項目 | 來源 |
|------|------|
| USD/TWD | yfinance `TWD=X` |
| 加權指數 | yfinance `^TWII` |
| 台股集中市場日均成交額 | TWSE FMTQIK API（**注意：成交金額在 row[2]，不是 row[3]**）。**僅上市集中市場**，不含上櫃（TPEx）、興櫃、期權；前端卡片標示「台股集中市場日均成交額」以免誤解為全市場 |
| S&P 500 | yfinance `^GSPC` |
| US 10Y 殖利率 | yfinance `^TNX` |
| TLT（iShares 20+ Year Treasury Bond ETF） | yfinance `TLT` — 壽險 FVTPL 境外長債部位代理指標 |

**台灣 10Y 公債不抓**（無乾淨免費 API，且參考度低）。

值與「上個月最後交易日」比較。寫入該月份 JSON 的 `market_summary` 欄位 + 同步 `latest.json`。`main.py` 的 `save_data()` 會 read-merge-write，避免 MOPS 爬蟲覆蓋掉 `market_summary`（與 news_summary 同樣保留）。

```bash
python scraper/market_summary.py                  # 預設上個月
python scraper/market_summary.py --period 115/04  # 指定月份
python scraper/market_summary.py --dry-run        # 只印不寫
```

---

## 新聞摘要（news_summary.py）

每月 13 家全部收齊後，自動補上各家的新聞摘要。

```bash
cd scraper
python news_summary.py              # 補齊最新月份（冪等：已有摘要的跳過）
python news_summary.py --force      # 強制重新產生所有摘要
python news_summary.py --month 115/02  # 指定月份
```

**來源限定**：工商時報（ctee.com.tw）、經濟日報（money.udn.com）、鉅亨網（news.cnyes.com）、自由財經（ec.ltn.com.tw）

**模型**：`claude-sonnet-4-6`（含 web_search 工具）

**輸出欄位**：`news_summary`（~150字繁中）、`news_sources`（URL 列表）、`news_generated_at`

若查無相關報導，`news_summary` 填 `"無相關說明"`。

---

## 壽險 FVOCI 調整後獲利（fvoci_adjustment.py）

2026 年起壽險公司接軌 IFRS 17，FVOCI 股票處份利益不再計入 P&L，使得壽險子公司的 P&L 與去年同期（仍含 FVOCI 計入 P&L）難以直接比較。富邦、凱基等金控會在月損益新聞稿**直接揭露壽險子公司本身**（富邦人壽、凱基人壽）「**加計 FVOCI 處份利益後的累計調整後獲利**」，以利同基比較。

```bash
cd scraper
python fvoci_adjustment.py              # 補齊最新月份（冪等）
python fvoci_adjustment.py --force      # 強制重抓
python fvoci_adjustment.py --period 115/03
python fvoci_adjustment.py --codes 2881 2883
```

**模型**：`claude-sonnet-4-6` + web_search（限定工商時報 / 經濟日報 / 鉅亨網 / 自由財經）

**作用對象**：`LIFE_INSURANCE_CODES = {2881, 2882, 2883, 2887, 2891}` 旗下的壽險子公司（名稱含「人壽」者）。其他金控不處理。

**抓取邏輯**：
1. LLM 直接搜尋**壽險子公司本身**（如「富邦人壽」、「凱基人壽」）在新聞中揭露的「累計調整後獲利」（NT$m）
2. `life_sub.fvoci_adjusted.cumulative_profit = adjusted_life_cumul`（直接寫入，不再透過金控差額推算）
3. 合理性檢查：`adjusted_life_cumul > life_sub.cumulative_profit`（加計處份利益應更大）；否則視為 not_found
4. 若新聞僅揭露金控合併層級而未列出壽險子公司本身的調整後獲利 → not_found，欄位不寫
5. **來源日期防呆**（`_extract_source_date` / `_announcement_month_start`）：要求新聞發布日 ≥ 公告月份第一天（N 月資料於 N+1 月公告，例 115/05 → 須 ≥ 2026-06-01）。擋掉公告前的「事前預估／掌握」稿（例：富邦/國泰常有 5/29 即報「前5月」的推估稿，數字未定）。**僅對 URL 帶日期的來源有效**（工商時報 ctee `/news/YYYYMMDD`）；cnyes/udn/ltn 的 URL 無日期 → 無法驗證、維持放行
6. **區間/門檻型（`value_type: "lower_bound"`）**：少數壽險公司（目前**國泰人壽**）只揭露區間而非具體數字（例「累計調整後獲利突破1,000億」）。LLM 回傳 `value_kind: "lower_bound"` 時，存下界數值 + `display_prefix`（逾／突破／超過），**不寫 `delta_vs_original`、不算 YoY**（下界與去年精確值相除會得出假精度的百分比）。`main.compute_yoy` 偵測 `value_type=="lower_bound"` 自動跳過 YoY

> **歷史備註**：舊版（< 2026-05-04）透過金控層級調整後獲利推算（`delta = adjusted_holding − holding_cumul` 全數歸給壽險子公司）。但金控合併 P&L 包含其他子公司、少數權益、內部交易抵銷，差額**不等於**壽險的 FVOCI 處份利益，數字會有差數。已停用。

**輸出欄位**（壽險子公司物件下新增 nested object）：
```json
"fvoci_adjusted": {
  "cumulative_profit": 47280,          // NT$m，直接從新聞抓到的壽險公司累計調整後獲利
  "delta_vs_original": 32160,          // = cumulative_profit − 壽險原始累計 P&L（純紀錄用）
  "yoy_pct": 72.8,                     // 由 main.compute_yoy 填入
  "source_url": "https://news.cnyes.com/...",
  "source_quote": "富邦人壽…累計前3月調整後獲利為472.8億元…",
  "original_value_text": "472.8 億元",
  "generated_at": "2026-05-04T..."
}
```

**YoY 語意**：今年加計 FVOCI 後的調整數 vs 去年同期 baseline 的原始 P&L（去年仍含 FVOCI 計入 P&L）→ 兩邊皆「含 FVOCI 影響」，apples-to-apples。`main.compute_yoy` 自動計算並寫入 `fvoci_adjusted.yoy_pct`。

**區間/門檻型輸出欄位**（國泰人壽）：
```json
"fvoci_adjusted": {
  "value_type": "lower_bound",
  "cumulative_profit": 100000,         // NT$m，門檻下界（突破1,000億 → 100000）
  "display_prefix": "逾",              // 新聞用字（逾／突破／超過）
  "source_url": "https://money.udn.com/...",
  "source_quote": "國泰人壽…累計前5月調整後獲利突破1,000億元…",
  "original_value_text": "突破1,000億元",
  "generated_at": "2026-06-11T..."
  // 無 delta_vs_original、無 yoy_*
}
```

**前端顯示**：壽險產業 tab、子公司展開面板皆於壽險子公司列下方加一行「（加上FVOCI股票處份利益）*」+ 累計 + YoY，註腳說明數字來源。其他產業 tab 不顯示。資料缺漏顯示 `—`。**不**併入合計卡片或圖表。前端 `fvociDisplay()` 統一格式化：`lower_bound` 顯示「逾 X」且 YoY 欄為 `—`；具體值顯示數字 + YoY。

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

## 每月更新 SOP（自動化 / 低階模型照抄用）

> 目標：每月不需自行推理，照下列順序執行即可。所有腳本皆**冪等**，中途失敗可直接重跑，不會重複累加或損壞資料。

**執行時機**：每月 11 日之後（多數金控已於 N+1 月上旬公告 N 月損益）。

```bash
# 1. 先同步，避免與 GitHub Actions 的 commit 衝突
git pull

# 2. 進 scraper，設好金鑰（或已有 .env）
cd scraper
export ANTHROPIC_API_KEY=sk-ant-api03-...

# 3. 爬上個月（不帶 --month 會自動判斷）→ 自動算 YoY、更新 index/latest
python main.py

# 4. 補新聞摘要與壽險 FVOCI 調整（冪等，已有的會跳過）
python news_summary.py
python fvoci_adjustment.py
```

**完成前的驗收檢查（務必逐項確認，不可略過）**：

1. `docs/data/index.json` 的 `latest` 已指向本次目標月份（例：處理 115/05 → `latest` 應為 `115/05`）。
2. 該月份的 `success_count` 為 **13**。若 < 13：屬部分金控尚未公告，**當日重跑或隔日再跑**即可補齊（腳本只補缺漏的家）。
3. `docs/data/latest.json` 與該月份 JSON（如 `115-05.json`）內容一致。
4. `market_summary` 欄位仍在（不應被覆蓋——`save_data()` 會 read-merge-write 保留它）。

**確認無誤後才 commit + push**：

```bash
cd ..
git add docs/data/
git commit -m "chore: update financial data $(date +'%Y-%m-%d %H:%M')"
git push
```

**常見狀況處理**：

- **某家一直撲空**：多為該金控尚未公告，非程式錯誤。等下一批公告後重跑，勿手動偽造資料。
- **JSON 被 OneDrive 填入空白 padding**：用 `data/` root 的乾淨版覆蓋 `docs/data/`（見「已知問題」）。
- **只想補單一家**：`python main.py --month 115/05 --codes 2881`。
- **前端（`docs/*.html/js/css`）與資料 pipeline 互不影響**：改前端不會動到 `docs/data/`，改 scraper 也不會動到前端；兩者可分開處理與驗證。

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

# 抓本月市場概況
python market_summary.py

# 一次性：爬整個 114 年作為 YoY baseline（已執行過，~75 分鐘）
python bootstrap_history.py --year 114
```

**輸出位置**：`docs/data/latest.json`、`docs/data/115-03.json`、`docs/data/index.json`

---

## GitHub Actions

### update_data.yml（MOPS 月損益 + 新聞摘要 + FVOCI 調整）

- **排程**：每月 **11~15 日**，UTC 11:00（台灣時間 19:00）一次。5~10 日改人工手動觸發（多數金控還沒公告，自動跑容易撲空 + 假性成功）
- **Short-circuit**：schedule 觸發時，若 `latest.json` 已顯示目標月份 `success_count >= 13`，直接跳過所有步驟（節省 API 費用）
- **手動觸發**：Actions → Run workflow（不受 short-circuit 限制，方便補跑）
- 執行 `scraper/main.py`（含 YoY 計算）→ 接著依序執行 `news_summary.py` → `fvoci_adjustment.py`（皆冪等）→ commit + push
- **Partial commit**：news/fvoci/commit 三 steps 用 `if: always()`。即使 scraper 因部分公司失敗而 `exit 1`，依然會把已成功的家 commit + push（`save_data` 在 `sys.exit` 之前已完成，JSON 是 consistent 狀態）

### update_market.yml（市場概況）

- **排程**：每月 **11 號** UTC 01:00（台灣時間 09:00）。與 MOPS 排程同日早幾小時（MOPS 為 11~15 日 UTC 11:00）。會自己建立月份 stub 檔。
- 設計考量：本網站主軸為月獲利公告，避免新月份在 5~10 日只有市場概況、公司列空白的觀感。市場數據其他管道可取得，不需提前。
- 執行 `scraper/market_summary.py` → commit + push
- MOPS 當日稍晚（19:00）跑時，`save_data()` 會保留 `market_summary` 欄位

### Secret

`ANTHROPIC_API_KEY`（repo Settings → Secrets → Actions）— 只 update_data.yml 用，update_market.yml 不需要 LLM。

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

- 月份選單（dropdown）：依 index.json 動態建立（含 114 baseline 月份）
- 排序：代號 / 當月↓ / 累計↓ / **累計 YoY↓** / 累計 EPS↓
- 單位切換：百萬元（NT$m）/ 億元（前端換算，JSON 存百萬元）
- **本月市場概況**：表格上方獨立區塊，5 張卡片（FX、TAIEX、日均量、S&P、US 10Y）
- 摘要卡片：合計當月、合計累計 YTD、當月第一、累計第一
- **產業 Tab 切換**：金控總覽 / 銀行 / 壽險 / 證券。子公司依名稱 pattern matching 分類（含「銀行」/「人壽」/「證券」），表格、圖表、標題跟著切；產業 tab 無 EPS 欄位
- 主表格（金控視角）：代號、金控名、當月、累計、**累計 YoY**、當月 EPS、累計 EPS
- 主表格（產業視角）：集團、子公司、當月、累計、累計 YoY
- 子公司展開：點金控名/集團名顯示子公司明細 + bar chart
- 新聞摘要：子公司面板底部顯示「延伸閱讀」清單
- 雙圖表：當月獲利橫條圖（藍）+ 累計 YTD 橫條圖（綠），跟著 tab 切換資料源

---

## 已知問題與注意事項

- **2883 名稱不一致**：MOPS 公告標題有時顯示「開發金」，程式以 `companies.py` 的「凱基金」為準
- **`monthly_eps` 多為 null**：金控月報通常只公告累計 EPS，不公告單月 EPS
- **OneDrive 同步可能損壞 JSON**：`docs/data/` 的 JSON 偶爾被 OneDrive 填入大量空白 padding，導致解析失敗。修復方式：用 `data/` root 的乾淨版本覆蓋
- **民國年換算**：西元年 − 1911 = 民國年（2026 = 115）
- **MOPS 請求間隔**：建議 3~5 秒（`--delay` 參數），避免被限流
- **LLM 費用估計**：約 $0.01~0.05 USD / 家（claude-opus-4-6 解析 HTML）
