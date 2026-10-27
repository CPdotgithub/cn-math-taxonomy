#!/bin/bash
# 双击运行：用固定端口起站点（页面 + DeepSeek 同站转发），再用浏览器打开。
# 固定端口是为了让浏览器把「孩子档案 / DeepSeek 凭据」认成同一个网址——端口一变，数据就看不到了。
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8981}"
URL="http://127.0.0.1:$PORT/diagnose/"

if curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "已经在跑了，直接打开 $URL"
  open "$URL"
  exit 0
fi

echo "启动中… 地址：$URL"
echo "关掉这个窗口（或按 Ctrl+C）就停止服务。"
echo

PORT="$PORT" python3 server.py &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  if curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.25
done
open "$URL"

wait $SERVER_PID
