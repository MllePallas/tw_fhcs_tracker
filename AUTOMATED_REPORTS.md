# 月資料與分析報告流程

網站期間一律顯示西元 `YYYY/MM`。MOPS 原始資料的檔名及爬蟲索引保留民國識別碼，不更動原始公告。

## 自動更新的部分

`Update Financial Holdings Data` 定期擷取 13 家金控 MOPS 月自結，並增量補入新聞摘要及 FVOCI 揭露；`Update Market Summary` 更新市場資料。GitHub 提交 `docs/data/` 後，網站直接從月資料計算並呈現：

- 首頁「完整月報」的金控、子公司、單月及累計數字與市場概況。
- 「趨勢重點」的 MoM、近三月比較、歷史走勢及變化標記；自結獲利分析報告連結另行發布。
- 「季度比較」及其他期間比較。缺少月份或公司時顯示資料不足，不補值。
- 首頁下載的原有六張 Excel 工作表。

以上資料頁面不需等文字分析報告才更新。資料擷取中若尚未取得 13 家，頁面會顯示公告完整度與缺漏；分析報告則等資料收齊後再撰寫。

## 自結獲利分析報告：先確認再發布

1. 確認 13 家金控、主要子公司、新聞及市場資料已取得。新聞摘要是線索，撰寫時仍須核對原始報導／公司新聞稿及其報導月份。
2. 在 Codex 指定西元月份，請 Codex依當月資料撰寫四段分析。先在對話中檢視、修訂；不由 GitHub 排程自動寫作。
3. 核准後將最終稿提交為 `docs/reports/YYYY-MM.md`。若是修改舊月，編輯同一檔案即可。
4. `Publish Approved Monthly Analysis` 只在該 Markdown 提交後執行，更新 HTML、資料包、狀態及索引。它不使用 Anthropic 或 DeepSeek API，不改寫核准文字。新月份在這一步後才出現報告連結。

需要重新排版已上傳的報告，可手動執行同一 GitHub Actions workflow 並指定 `YYYY/MM`；指定月份必須已有 Markdown。若原始資料在報告核准後修正，需再核對文字，修訂後重新提交。報告及索引的詳細檔案說明見 [docs/REPORT_MAINTENANCE.md](docs/REPORT_MAINTENANCE.md)。

`Evaluate DeepSeek Monthly Report` 僅保留為手動、未發布的模型測試，不影響正式網站。資料擷取仍使用既有 `ANTHROPIC_API_KEY`；正式報告發布不需要撰稿 API Key。公司內部管理帳資料不應加入公開儲存庫。

## 本機驗證

```text
node tests/analytics.test.cjs
node tests/analysis-pack.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```
