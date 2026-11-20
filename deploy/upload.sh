#!/usr/bin/env bash
# 本地打包上传 + 远程初始化（macOS / Linux / Windows Git-Bash 通用）
#
# 用法：
#   KEY=~/Downloads/YOUR_KEY_ID.pem bash deploy/upload.sh
#   KEY=/c/Users/YOUR_USERNAME/Downloads/skey.pem HOST=ubuntu@YOUR_SERVER_IP PORT=80 bash deploy/upload.sh
set -euo pipefail

HOST="${HOST:-ubuntu@YOUR_SERVER_IP}"
KEY="${KEY:?请通过 KEY=私钥路径 指定私钥，例如 KEY=~/Downloads/skey.pem}"
REMOTE_DIR="${REMOTE_DIR:-/opt/lottery}"
PORT="${PORT:-8082}"
PKG="lottery-deploy.tar.gz"

cd "$(dirname "$0")/.."

if [ ! -f "$KEY" ]; then
  echo "!! 找不到私钥文件：$KEY"
  exit 1
fi

echo "==> 1/4 打包（排除 node_modules / 本地数据 / 日志）"
rm -f "$PKG" 2>/dev/null || true
tar czf "$PKG" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=data \
  --exclude='*.log' \
  --exclude="$PKG" \
  .
echo "    包大小：$(du -h "$PKG" | cut -f1)"

echo "==> 2/4 上传到 $HOST:/tmp/"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$PKG" "$HOST:/tmp/"

echo "==> 3/4 解压到 $REMOTE_DIR"
ssh -i "$KEY" "$HOST" "sudo mkdir -p $REMOTE_DIR && sudo tar xzf /tmp/$PKG -C $REMOTE_DIR && sudo chown -R ubuntu:ubuntu $REMOTE_DIR && rm -f /tmp/$PKG"

echo "==> 4/4 远程安装依赖并注册服务（端口 $PORT）"
ssh -i "$KEY" "$HOST" "bash $REMOTE_DIR/deploy/deploy.sh $PORT $REMOTE_DIR"

printf '\n本地安装包已生成：%s（可删除）\n' "$PKG"
