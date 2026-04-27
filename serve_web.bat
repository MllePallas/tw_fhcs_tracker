@echo off
chcp 65001 >nul
echo ========================================
echo  啟動本地網頁伺服器
echo ========================================
echo.

REM 把最新資料複製到 web/data/（讓網頁可以讀到）
if exist data\latest.json (
    if not exist web\data mkdir web\data
    copy /Y data\latest.json web\data\latest.json >nul
    echo  已複製 data\latest.json 到 web\data\
) else (
    echo  [提示] 尚無 data\latest.json，請先執行 test_local.bat
)

echo.
echo  網址：http://localhost:8080
echo  按 Ctrl+C 停止
echo.
python -m http.server 8080 --directory web
pause
