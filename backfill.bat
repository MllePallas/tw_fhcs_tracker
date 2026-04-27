@echo off
REM backfill.bat — 補跑 115/01、115/02 歷史資料
REM 請確認已設定 .env（含 ANTHROPIC_API_KEY）再執行
REM 執行順序：1月 → 2月 → 重新跑3月（確保 latest.json 是最新）

cd /d "%~dp0"

echo ========================================
echo  補跑 115/01（2026年1月）
echo ========================================
python scraper\main.py --month 115/01
if errorlevel 1 (
    echo [警告] 115/01 有部分失敗，繼續執行...
)
timeout /t 5 /nobreak >nul

echo.
echo ========================================
echo  補跑 115/02（2026年2月）
echo ========================================
python scraper\main.py --month 115/02
if errorlevel 1 (
    echo [警告] 115/02 有部分失敗，繼續執行...
)
timeout /t 5 /nobreak >nul

echo.
echo ========================================
echo  重新確認 115/03（確保 latest.json 正確）
echo ========================================
python scraper\main.py --month 115/03
if errorlevel 1 (
    echo [警告] 115/03 有部分失敗
)

echo.
echo ========================================
echo  完成！data\index.json 現在應有 3 個月
echo ========================================
type data\index.json
