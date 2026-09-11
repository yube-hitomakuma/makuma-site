#!/bin/zsh

set -u
cd "/Users/rarabai/makuma-site"
node scripts/desktop-update.mjs

echo ""
echo "処理を終了しました。Enterキーでこのウィンドウを閉じます。"
read -r
