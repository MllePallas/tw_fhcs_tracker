# 專案進度記錄

---

## 2026-04-24 成果（第二次工作日）

### 資料修正
- ✅ 所有單位統一為 **NT$m（百萬元）**：億元×100、千元÷1000
- ✅ 移除 **2888 新光金**（已下市）殘留的 error 列
- ✅ **2887** 顯示名稱修正為「台新新光金」（原始 JSON 殘留舊名「台灣金」）
- ✅ `parser.py` LLM prompt 升級：強制換算成 NT$m，unit 固定輸出「百萬元」

### 115/03 最終數據（單位 NT$m）

| 代號 | 公司 | 當月 | 累計 YTD |
|------|------|-----:|--------:|
| 2881 | 富邦金 | 2,570 | 33,270 |
| 2882 | 國泰金 | 5,030 | 31,660 |
| 2883 | 凱基金 | 2,027 | 11,692 |
| 2884 | 玉山金 | 3,013 | 10,057 |
| 2885 | 元大金 | 4,616 | 14,409 |
| 2886 | 兆豐金 | 2,401 | 9,397 |
| 2887 | 台新新光金 | 6,070 | 21,060 |
| 2889 | 國票金 | 205 | 897 |
| 2890 | 永豐金 | 2,749 | 10,941 |
| 2891 | 中信金 | 7,577 | 23,104 |
| 2892 | 第一金 | 2,711 | 8,244 |
| 5880 | 合庫金 | 1,955 | 5,812 |
| **合計** | **12家** | **44,924** | **180,543** |

### 前端網站
- ✅ 預設單位 NT$m，支援切換億元
- ✅ 點金控名稱展開子公司明細＋橫向 bar chart
- ✅ 雙圖表：左「當月獲利排行」、右「累計 YTD 排行」
- ✅ 排序（代號 / 當月↑↓ / 累計↓）

### 月份歷史選單架構
- ✅ `scraper/main.py` 每次跑完自動更新 `data/index.json`
- ✅ `web/app.js` 啟動時讀 `index.json`，動態建立月份 dropdown
- ✅ `data/index.json` 已建立（目前含 115/03 一筆）
- ✅ `backfill.bat` 補跑腳本（執行後補入 115/01、115/02）

---

## 架構現況

```
taiwan-finhold-tracker/
├── .github/workflows/update_data.yml  ✅ 自動排程(每月8-15日) + 手動觸發
├── scraper/
│   ├── companies.py    ✅ 12家（移除已下市2888）
│   ├── mops_client.py  ✅ 新版 MOPS API（redirectToOld）
│   ├── parser.py       ✅ 規則 + LLM兜底，強制輸出 NT$m
│   └── main.py         ✅ 含 update_index() 自動更新 index.json
├── data/
│   ├── index.json      ✅ 月份索引（目前：115/03）
│   ├── latest.json     ✅ 115/03，12家，單位 NT$m
│   └── 115-03.json     ✅ 歸檔
├── web/
│   ├── index.html      ✅ 含月份選單
│   ├── style.css       ✅
│   └── app.js          ✅ 月份切換 + 雙圖表
├── preview.html        ✅ 獨立預覽（內嵌資料，雙擊可開）
└── backfill.bat        ✅ 補跑 115/01、115/02 歷史資料
```

---

## 關鍵技術發現

- **MOPS 在 2025 年改版為 SPA**，舊的 `ajax_t05st02` POST 直接呼叫已失效
- **新版 API 流程**：`POST /mops/api/redirectToOld` → 加密 URL → `GET` 取 HTML
- **查詢參數**：改用 `year` + `month`（民國年），不再支援 date1/date2
- **LLM 解析（claude-opus-4-6）**：12/13 家成功，已強制統一單位換算

---

## 下週待做事項

### 優先
1. **執行 `backfill.bat`** — 補跑 115/01、115/02，讓月份選單有 3 個月可切換
2. **推上 GitHub**
   - `git init` → 建立 repo（建議名稱：`taiwan-finhold-tracker`）
   - 設定 Secret：`ANTHROPIC_API_KEY`
   - 啟用 GitHub Pages（branch: `main`, folder: `/web`）
   - 測試 workflow_dispatch 手動觸發

### 之後
3. 確認 2880 華南金（已加入 companies.py 但尚未有爬取資料）
4. 考慮加入趨勢折線圖（多月份比較，補完歷史後可做）
5. 考慮加入 YoY 同期比較欄位
