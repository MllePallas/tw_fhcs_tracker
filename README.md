# 台灣金控月自結獲利追蹤器

自動蒐集台灣 13 家上市金控的月自結損益公告，並展示在網頁上。

資料來源：[公開資訊觀測站 (MOPS)](https://mops.twse.com.tw)

---

## 功能

- 每月 8~15 日自動從 MOPS 爬取 13 家金控公告
- 解析金控本體及各子公司當月/累計稅後淨利
- 展示可排序、可切換單位的比較表格與長條圖
- 網頁按鈕手動觸發更新
- GitHub Pages 靜態網站部署

## 13 家金控

| 代號 | 名稱 | 代號 | 名稱 |
|------|------|------|------|
| 2881 | 富邦金 | 2887 | 台灣金 |
| 2882 | 國泰金 | 2888 | 新光金 |
| 2883 | 開發金 | 2889 | 國票金 |
| 2884 | 玉山金 | 2890 | 永豐金 |
| 2885 | 元大金 | 2891 | 中信金 |
| 2886 | 兆豐金 | 2892 | 第一金 |
| 5880 | 合庫金 | | |

---

## 部署步驟

### 1. Fork 或 Clone 此專案到 GitHub

```bash
git clone https://github.com/YOUR_USERNAME/taiwan-finhold-tracker.git
cd taiwan-finhold-tracker
```

### 2. 設定 GitHub Secrets

前往 `Settings → Secrets and variables → Actions`，新增：

| Secret 名稱 | 說明 |
|------------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key（用於 LLM 兜底解析） |

若不使用 LLM，可在 workflow 中加 `--no-llm`。

### 3. 啟用 GitHub Pages

前往 `Settings → Pages`：
- Source：選 **GitHub Actions**
- 儲存

### 4. 啟用 Actions 自動排程

GitHub Actions 預設對 fork 的 repo 關閉排程觸發，
請前往 `Actions` 頁面手動啟用。

### 5. 手動測試執行

```bash
# 本地測試（先安裝依賴）
pip install -r requirements.txt
playwright install chromium

# 測試單一公司
cd scraper
python main.py --codes 2881 --no-llm

# 測試全部（需要 API key）
export ANTHROPIC_API_KEY=sk-ant-xxxx
python main.py
```

---

## 專案結構

```
taiwan-finhold-tracker/
├── .github/
│   └── workflows/
│       └── update_data.yml     # GitHub Actions 自動化
├── scraper/
│   ├── companies.py            # 13 家金控設定
│   ├── mops_client.py          # MOPS API 爬蟲
│   ├── parser.py               # HTML 解析器（規則 + LLM）
│   └── main.py                 # 主程式
├── data/
│   ├── latest.json             # 最新資料（網站讀取此檔）
│   └── 115-03.json             # 月份歸檔
├── web/
│   ├── index.html              # 網頁主體
│   ├── style.css               # 樣式
│   └── app.js                  # 前端邏輯
├── requirements.txt
└── README.md
```

---

## 資料格式

`data/latest.json` 結構：

```json
{
  "report_period": "115/03",
  "last_updated": "2026-04-15T09:30:00",
  "success_count": 12,
  "fail_count": 1,
  "companies": [
    {
      "code": "2881",
      "name": "富邦金",
      "announcement_date": "115/04/15",
      "announcement_title": "公告本公司暨主要子公司115年3月合併自結損益",
      "source_url": "https://mops.twse.com.tw/...",
      "report_month": "115/03",
      "unit": "千元",
      "holding_company": {
        "name": "富邦金",
        "monthly_profit": 12500000,
        "cumulative_profit": 38200000
      },
      "subsidiaries": [
        {"name": "富邦人壽", "monthly_profit": 8200000, "cumulative_profit": 25100000},
        {"name": "台北富邦銀行", "monthly_profit": 2800000, "cumulative_profit": 8900000}
      ]
    }
  ]
}
```

---

## 網站按鈕觸發說明

點擊「🔄 更新資料」後，需填入：

1. **GitHub Personal Access Token**
   - 前往 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - 權限：`Actions: Read and write`

2. **你的 GitHub 使用者名稱**

3. **Repository 名稱**（預設已填 `taiwan-finhold-tracker`）

Token 僅在本次請求使用，不會被儲存。

---

## 解析策略

公告格式因公司不同而有差異，採兩層解析：

1. **規則式表格解析**（`parser.py → TableParser`）
   - 掃描 HTML 表格，依欄位名稱辨識當月/累計獲利欄
   - 無 API 費用，速度快

2. **Claude LLM 兜底**（`parser.py → llm_parse`）
   - 當規則解析失敗時，呼叫 Claude API
   - 使用 `claude-opus-4-6` 理解非結構化文本
   - 需要 `ANTHROPIC_API_KEY`

---

## 注意事項

- 本工具僅用於蒐集公開資訊觀測站的公開資料
- 請遵守 MOPS 使用規範，不要過度頻繁請求
- 金融數據僅供參考，不構成投資建議
- 每次爬取間隔預設 3~5 秒，避免對伺服器造成負擔
