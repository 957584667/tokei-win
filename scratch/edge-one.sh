#!/bin/sh
# 单个用例跑 headless Edge：绝对路径 profile + 前后清理，避免多例共用锁
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
ROOT="$(cd "$(dirname "$0")/.." && pwd -W)"
n="$1"
rm -rf "$ROOT/scratch/ep-$n"
"$EDGE" --headless=old --disable-gpu --no-first-run \
  --user-data-dir="$ROOT/scratch/ep-$n" \
  --virtual-time-budget=15000 --window-size=900,700 \
  --dump-dom "file:///$ROOT/scratch/panel-$n.html" > "scratch/dom-$n.txt" 2> "scratch/edge-$n.err"
rm -rf "$ROOT/scratch/ep-$n"
echo "== $n bytes=$(wc -c < scratch/dom-$n.txt) probe=$(grep -c 'probe' scratch/dom-$n.txt)"
