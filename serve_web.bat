@echo off
chcp 65001 >nul
echo ========================================
echo  啟動本地預覽伺服器（與 GitHub Pages 同構：直接服務 docs/）
echo ========================================
echo.
echo  網址：http://localhost:8080
echo  按 Ctrl+C 停止（瀏覽器請用 Ctrl+F5 強制重新整理，避免快取到舊版 app.js）
echo.
start "" http://localhost:8080
python -m http.server 8080 --directory "%~dp0docs"
pause
