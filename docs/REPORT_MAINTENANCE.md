# 分析報告維護

網站目前提供 2026/06、2026/07、2026/08 的金控自結獲利分析。新月份的分析文字改為人工確認後發布；既有報告維持原文。

## 每月作業

1. GitHub 排程持續擷取 MOPS 月自結、新聞摘要、FVOCI 補充揭露和市場資料。完整月報、趨勢重點的數字區塊及季度比較直接讀取月資料，自動更新，並標示缺漏；不依賴分析報告。
2. 確認 13 家金控及需要的子公司、新聞、市場資料已取得後，在 Codex 提供報導月份，請 Codex依當月網站資料和原始新聞撰寫自結獲利分析。
3. 先在 Codex 檢視及修訂報告。核准後，將最終 Markdown 存成 `docs/reports/YYYY-MM.md` 並提交到 GitHub。期間一律使用西元年／月。
4. `Publish Approved Monthly Analysis` 工作流程會在該 Markdown 提交後，使用最新月資料排版成同月份 HTML，更新資料包、狀態及 `docs/reports/index.json`。不呼叫 AI，也不改寫核准的 Markdown。只有索引中已有的月份才會在網站出現分析報告連結。

需要重新排版已提交的報告時，可在 GitHub Actions 手動執行 `Publish Approved Monthly Analysis`，指定月份。原始月資料若在核准後修正，重新排版會標示資料變動，報告內的分析文字仍需人工核對及更新。

## 檔案

- `YYYY-MM.md`：核准後的正式報告內容；請修改此檔，不要直接修改 HTML。
- `YYYY-MM.html`：網站頁面，由核准的 Markdown 排版產生。
- `YYYY-MM.pack.json`：該次排版使用的分析資料包。
- `YYYY-MM.meta.json`：發布狀態及資料變動標記。
- `index.json`：網站可見的報告月份索引。

早於 2026/06 的舊版報告存放於網站目錄外的 `archive/reports`。歷史獲利資料、趨勢比較與 Excel 下載不受報告發布流程影響。
