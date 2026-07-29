@echo off
cd /d "%~dp0"
echo 正在从 GitHub 同步 asin-offsite-promo-scanner ...
git -c credential.helper= fetch origin
git -c credential.helper= reset --hard origin/main
echo.
echo 更新完成（已对齐到远程 main，工作树已拉平）。
echo 提示：如果 scripts\package.json 有改动，请进入 scripts 目录运行 npm install 重新安装依赖。
pause
