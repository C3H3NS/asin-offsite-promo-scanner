#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "正在从 GitHub 同步 asin-offsite-promo-scanner ..."
git -c credential.helper= pull --ff-only
echo ""
echo "更新完成。"
echo "提示：如果 scripts/package.json 有改动，请进入 scripts 目录运行 npm install 重新安装依赖。"
