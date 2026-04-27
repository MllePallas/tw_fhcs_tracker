@echo off
chcp 65001 >nul
echo ========================================
echo  台灣金控爬蟲 — 本地測試
echo ========================================
echo.

REM 檢查 Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [錯誤] 找不到 Python，請先安裝 Python 3.10+
    exit /b 1
)

echo [1/3] 安裝 Python 套件...
pip install "requests>=2.31,<3" "beautifulsoup4>=4.12,<5" "lxml>=5.1,<6" "anthropic>=0.28,<1" -q
if errorlevel 1 (
    echo [錯誤] 套件安裝失敗
    exit /b 1
)
echo       完成！
echo.

echo [2/3] 執行爬蟲（測試富邦金 2881，不使用 LLM）...
echo       這會連到公開資訊觀測站，請確認網路正常
echo.
cd scraper
python main.py --codes 2881 --no-llm
set SCRAPER_EXIT=%errorlevel%
cd ..
if %SCRAPER_EXIT% neq 0 (
    echo.
    echo [警告] 爬蟲回傳錯誤碼 %SCRAPER_EXIT%，可能有部分公司未取得資料
    echo        請查看上方的錯誤訊息
)

echo.
echo [3/3] 檢查輸出...
if exist data\latest.json (
    echo       data\latest.json 已產生！
    python check_result.py
) else (
    echo [錯誤] data\latest.json 未產生，請查看上方錯誤訊息
    exit /b 1
)

echo.
echo ========================================
echo  完成！執行 serve_web.bat 開啟網頁
echo ========================================
