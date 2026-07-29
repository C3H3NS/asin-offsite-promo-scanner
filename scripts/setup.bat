@echo off
REM 安装 facebook_search.js 依赖（playwright）。
REM 设 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 跳过下载浏览器（脚本用本机已装 Chrome）。
cd /d "%~dp0"
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
call npm install
echo [done] 依赖安装完成。下一步请运行 start_chrome_debug.bat 并登录 Facebook。
