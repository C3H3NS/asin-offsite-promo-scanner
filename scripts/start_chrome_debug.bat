@echo off
REM ============================================================
REM  start_chrome_debug.bat  —  Windows 一键启动调试 Chrome
REM  用途：用本机已登录的 Chrome 打开 9222 调试端口，
REM        以便 facebook_search.js 复用你的 Facebook 登录态。
REM
REM  已内置解决三大坑：
REM   1) taskkill 先清掉后台残留 Chrome 进程（否则 profile 被占用）
REM   2) del SingletonLock 清掉 taskkill /F 强杀留下的陈旧锁（否则 Chrome
REM      误判目录被占、跳过绑定调试端口，9222 永远起不来）
REM   3) --proxy-bypass-list 让 127.0.0.1 不走系统代理（公司/科学上网环境必备）
REM   4) --remote-allow-origins=* 新版 Chrome 连 CDP 必备
REM
REM  用法：双击本文件，或在终端执行  scripts\start_chrome_debug.bat
REM ============================================================
taskkill /F /IM chrome.exe 2>nul
timeout /t 2 /nobreak >nul
del /f /q "%USERPROFILE%\AppData\Local\Google\Chrome\User Data\SingletonLock" 2>nul

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --remote-allow-origins=* ^
  --proxy-bypass-list="127.0.0.1;localhost" ^
  --user-data-dir="%USERPROFILE%\AppData\Local\Google\Chrome\User Data"

echo.
echo [OK] 调试 Chrome 已启动。请在弹出的窗口里登录 Facebook，
echo      然后另开一个终端运行：
echo        node facebook_search.js "你的品牌名"
echo.
echo      验证端口是否生效：浏览器访问  http://127.0.0.1:9222
echo      （应看到一个 JSON 页面，列出当前标签页）
echo.
echo      ⚠ 整个过程中只用这一个调试窗口，不要再去双击普通 Chrome 图标。
