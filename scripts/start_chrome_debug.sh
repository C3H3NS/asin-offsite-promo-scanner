#!/usr/bin/env bash
# ============================================================
#  start_chrome_debug.sh  —  macOS / Linux 一键启动调试 Chrome
#  用途：用本机已登录的 Chrome 打开 9222 调试端口，
#        以便 facebook_search.js 复用你的 Facebook 登录态。
#
#  已内置：
#    - 关闭所有 Chrome（避免 profile 被占用）
#    - --remote-allow-origins=*  （新版 Chrome 连 CDP 必备）
#    - --proxy-bypass-list        （让 127.0.0.1 不走系统代理）
#
#  用法：  bash scripts/start_chrome_debug.sh
# ============================================================
set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  PROFILE="$HOME/Library/Application Support/Google/Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || echo '')"
  PROFILE="$HOME/.config/google-chrome"
  if [[ -z "$CHROME_BIN" ]]; then
    echo "未找到 google-chrome / chromium，请先安装 Chrome。" >&2
    exit 1
  fi
else
  echo "不支持的系统: $OSTYPE" >&2
  exit 1
fi

# 关闭所有 Chrome（确保 profile 不被占用）
pkill -f "remote-debugging-port=9222" 2>/dev/null || true
pkill -f "$CHROME_BIN" 2>/dev/null || true
sleep 2

# 启动带调试端口的 Chrome（后台）
# --disable-backgrounding-occluded-windows / --disable-renderer-backgrounding：
#   静默模式下窗口会被挪出可视区，不加这两个参数 Chrome 会降频渲染，导致抓取结果变少。
"$CHROME_BIN" \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --proxy-bypass-list="127.0.0.1;localhost" \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --user-data-dir="$PROFILE" \
  "about:blank" &

echo "[OK] 调试 Chrome 已后台启动。请在弹出的窗口里登录 Facebook"
echo "     （顺手把 Pinterest / Instagram 也登录了，覆盖更全）。"
echo ""
echo "     登录完成后运行（一条命令跑完全流程）："
echo "       node scan.js B0XXXXXXXX"
echo ""
echo "     运行时窗口会自动移出屏幕静默抓取，不打断你的工作；加 --show 可显示过程。"
echo ""
echo "      验证端口：浏览器访问  http://127.0.0.1:9222"
echo "      （应看到一个 JSON 页面，列出当前标签页）"
