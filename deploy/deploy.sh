#!/usr/bin/env bash
# 服务器端初始化脚本（在服务器上执行，普通用户 + sudo 即可）
# 用法：bash deploy.sh [端口] [安装目录]
#   bash deploy.sh                  → 8082 端口，装到 /opt/lottery
#   bash deploy.sh 8082 /opt/lottery
set -euo pipefail

PORT="${1:-8082}"
APP_DIR="${2:-/opt/lottery}"
SERVICE="lottery"

echo "=============================================="
echo " 抽奖系统部署"
echo " 目录：$APP_DIR"
echo " 端口：$PORT"
echo " 服务名：$SERVICE"
echo "=============================================="

# ---------- 0. 环境检查 ----------
if [ ! -f "$APP_DIR/server/index.js" ]; then
  echo "!! $APP_DIR 下没有 server/index.js，请先上传项目文件"
  exit 1
fi

# 端口占用检查（避免和你另外三个项目撞车）
if command -v ss >/dev/null 2>&1; then
  if ss -lntp 2>/dev/null | grep -q ":$PORT "; then
    echo "!! 端口 $PORT 已被占用，请换一个端口，例如：bash deploy.sh 8083 $APP_DIR"
    ss -lntp 2>/dev/null | grep ":$PORT " || true
    exit 1
  fi
fi

# ---------- 1. Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "==> 未检测到 Node.js，安装 Node 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
echo "==> Node $(node -v) / npm $(npm -v)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "!! Node 版本过低（需要 >= 18），请升级后重试"
  exit 1
fi

# ---------- 2. 依赖 ----------
cd "$APP_DIR"
if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "==> 安装生产依赖（express + xlsx）"
  npm install --omit=dev --no-audit --no-fund
else
  echo "==> 依赖已存在，跳过安装"
fi

# ---------- 3. 数据目录 ----------
mkdir -p "$APP_DIR/data"
if [ -f "$APP_DIR/data/lottery-data.json" ]; then
  echo "==> 已存在数据文件，保留原有数据"
else
  echo "==> 首次部署，数据文件将在启动时自动创建"
fi

# ---------- 4. systemd ----------
echo "==> 写入 systemd 单元 /etc/systemd/system/$SERVICE.service"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__PORT__|$PORT|g" \
  "$APP_DIR/deploy/lottery.service" | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE"

sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "==> 服务运行中"
else
  echo "!! 服务启动失败，最近日志："
  sudo journalctl -u "$SERVICE" -n 40 --no-pager
  exit 1
fi

# ---------- 5. 本机自检 ----------
echo "==> 自检 http://127.0.0.1:$PORT/"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/teams" >/dev/null 2>&1; then
    echo "==> 接口正常"
    break
  fi
  sleep 1
done
if ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/teams" >/dev/null 2>&1; then
  echo "!! 本机访问失败，日志："
  sudo journalctl -u "$SERVICE" -n 40 --no-pager
  exit 1
fi

# ---------- 6. 防火墙 ----------
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> ufw 已启用，放行 TCP $PORT"
  sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '服务器公网IP')"
echo ""
echo "=============================================="
echo " 部署完成 🎉"
echo ""
echo " 团队入口   http://$IP:$PORT/"
echo " CC 抽奖页  http://$IP:$PORT/cc"
echo " LP 抽奖页  http://$IP:$PORT/lp"
echo " 管理后台   http://$IP:$PORT/admin"
echo " 默认密码   CHANGE_ME_2026（登录后请立刻修改）"
echo "=============================================="
echo " 数据文件：$APP_DIR/data/lottery-data.json"
echo " 服务管理：sudo systemctl {status|restart|stop} $SERVICE"
echo " 实时日志：sudo journalctl -u $SERVICE -f"
echo ""
echo " ⚠ 如果外网打不开，请到腾讯云控制台："
echo "   轻量应用服务器 → 该实例 → 防火墙 → 添加规则 → TCP:$PORT → 允许"
echo "=============================================="
