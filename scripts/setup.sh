#!/usr/bin/env bash
# 安装 facebook_search.js 依赖（playwright）。
# 设 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 跳过下载浏览器（脚本用本机已装 Chrome）。
cd "$(dirname "$0")"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install
echo "[done] 依赖安装完成。下一步请运行 bash start_chrome_debug.sh 并登录 Facebook。"
