# 部署手册（Ubuntu 24.04 · 8082 端口）

> 目标服务器：`YOUR_SERVER_IP`　SSH 用户：`ubuntu`　部署端口：**8082**
> 项目目录：`/opt/lottery`　服务名：`lottery`（systemd 常驻 + 开机自启）

这套系统在服务器上占 **1 个 Node 进程 + 1 个端口**，和你另外 3 个项目互不干扰：

| 项目 | 建议端口 | 目录 | systemd 服务名 |
| --- | --- | --- | --- |
| 项目 A | 8080 | `/opt/xxx` | `xxx` |
| 项目 B | 8081 | `/opt/xxx` | `xxx` |
| 项目 C | 8083 | `/opt/xxx` | `xxx` |
| **抽奖系统** | **8082** | `/opt/lottery` | **`lottery`** |

要点只有三条：**端口不撞、目录分开、服务名唯一**。本项目全部遵守，不会覆盖别人的配置。

---

## 一、准备：拿到私钥

你提供的是 **公钥**（`ssh-rsa AAAA... YOUR_KEY_ID`），公钥只能放在服务器上，不能用来登录。
登录需要配套的 **私钥**：

1. 打开腾讯云控制台 → **轻量应用服务器** → 左侧 **密钥对**
2. 找到 `YOUR_KEY_ID` → 下载私钥（文件名类似 `YOUR_KEY_ID.pem`）
3. 保存到本机，例如 `C:\Users\YOUR_USERNAME\Downloads\YOUR_KEY_ID.pem`

> 如果找不到私钥了：控制台可以 **重置密码**，然后用密码登录；或新建密钥对并绑定到该实例
> （绑定会重启实例，注意别影响另外三个项目）。

先在 PowerShell 里确认能连上（把路径换成你的）：

```powershell
ssh -i "C:\Users\YOUR_USERNAME\Downloads\YOUR_KEY_ID.pem" ubuntu@YOUR_SERVER_IP "echo 连接成功 && uname -a"
```

第一次会提示 `Are you sure you want to continue connecting?`，输入 `yes`。
如果报 `Permission denied (publickey)` → 私钥不对；`Connection timed out` → 控制台防火墙没放行 22 端口。

---

## 二、上传项目（三选一）

### 方式 A：双击一键部署（最省事）

打开文件夹 `lottery\deploy\`，双击 **`一键部署.bat`**，按提示输入：

```
1) 私钥文件完整路径：C:\Users\YOUR_USERNAME\Downloads\YOUR_KEY_ID.pem
2) 服务器 IP：直接回车（默认 YOUR_SERVER_IP）
3) 对外端口：直接回车（默认 8082）
```

脚本会自动：打包 → 上传 → 解压到 `/opt/lottery` → 装依赖 → 注册 systemd → 启动 → 自检。

### 方式 B：PowerShell 手打命令（推荐，出问题好排查）

在**项目根目录**（`...\2026-11-10-11-02-27\lottery`）打开 PowerShell，逐段复制执行：

```powershell
$KEY = "C:\Users\YOUR_USERNAME\Downloads\YOUR_KEY_ID.pem"
$IP  = "YOUR_SERVER_IP"

# 1) 打包（排除 node_modules 和本地数据，包约 640KB）
if (Test-Path lottery-deploy.tar.gz) { Remove-Item lottery-deploy.tar.gz -Force }
tar czf lottery-deploy.tar.gz --exclude=node_modules --exclude=.git --exclude=data --exclude=*.log .

# 2) 上传
scp -i $KEY lottery-deploy.tar.gz ubuntu@${IP}:/tmp/

# 3) 解压到 /opt/lottery
ssh -i $KEY ubuntu@$IP "sudo mkdir -p /opt/lottery && sudo tar xzf /tmp/lottery-deploy.tar.gz -C /opt/lottery && sudo chown -R ubuntu:ubuntu /opt/lottery && rm -f /tmp/lottery-deploy.tar.gz"

# 4) 初始化（装 Node、装依赖、写 systemd、启动、自检）
ssh -i $KEY ubuntu@$IP "bash /opt/lottery/deploy/deploy.sh 8082 /opt/lottery"
```

### 方式 C：先把代码放到服务器再本地部署

如果你的代码在 git 仓库里，可以直接在服务器上：

```bash
ssh -i 私钥 ubuntu@YOUR_SERVER_IP
sudo mkdir -p /opt/lottery && sudo chown ubuntu:ubuntu /opt/lottery
git clone <你的仓库地址> /opt/lottery      # 或用 scp / sftp 上传
bash /opt/lottery/deploy/deploy.sh 8082 /opt/lottery
```

---

## 三、初始化脚本做了什么

`deploy/deploy.sh` 是幂等的，重复执行只会重启服务，不会丢数据：

| 步骤 | 说明 |
| --- | --- |
| 0. 检查 | 项目文件是否存在；**8082 是否已被别的项目占用**（占用会直接报错让你换端口） |
| 1. Node | 没有 Node 就装 Node 20 LTS；已有则跳过；版本 < 18 会提示升级 |
| 2. 依赖 | `npm install --omit=dev`，只装 express + xlsx，装到 `/opt/lottery/node_modules`，**不污染全局** |
| 3. 数据 | 创建 `data/`；已有 `lottery-data.json` 则保留，不覆盖 |
| 4. 服务 | 生成 `/etc/systemd/system/lottery.service`，`systemctl enable + restart` |
| 5. 自检 | 反复请求 `http://127.0.0.1:8082/api/teams`，通了才算成功 |
| 6. 防火墙 | 若启用了 ufw，自动放行 8082/tcp |

`lottery.service` 关键配置：

```ini
[Service]
User=ubuntu
WorkingDirectory=/opt/lottery
ExecStart=/usr/bin/node /opt/lottery/server/index.js
Environment=PORT=8082
Restart=always
RestartSec=3
```

> 用 systemd 而不是 pm2：不与另外三个项目抢 pm2 进程列表，也不会因为 `pm2 kill` 被误伤。
> 如果你其他项目都用 pm2，也可以 `pm2 start /opt/lottery/server/index.js --name lottery`，
> 但**先停掉 systemd 服务**（`sudo systemctl disable --now lottery`），两者只能选一个，否则端口冲突。

---

## 四、开放 8082 端口（关键，漏了外网打不开）

腾讯云轻量应用服务器有**独立于系统防火墙的控制台防火墙**，必须两边都放行：

1. 控制台 → 轻量应用服务器 → 点实例 `Ubuntu24.04-Docker29-bbiy`
2. 左侧 **防火墙** → **添加规则**
3. 应用类型选「自定义」，协议 **TCP**，端口 **8082**，策略 **允许** → 确定
4. 服务器内部如果开了 ufw，也放行一下（deploy.sh 会自动做）：

```bash
sudo ufw status                 # 如果是 inactive，不用管
sudo ufw allow 8082/tcp         # 如果 active，执行这句
```

验证端口通不通（本机 PowerShell）：

```powershell
Test-NetConnection YOUR_SERVER_IP -Port 8082
# TcpTestSucceeded : True   → 通了
```

---

## 五、验证

浏览器打开（手机也可以，同一公网地址）：

| 用途 | 链接 |
| --- | --- |
| 团队入口（两个团队选一个进） | **http://YOUR_SERVER_IP:8082/** |
| CC 团队抽奖页 | **http://YOUR_SERVER_IP:8082/cc** |
| LP 团队抽奖页 | **http://YOUR_SERVER_IP:8082/lp** |
| CC 现金抽奖页 | **http://YOUR_SERVER_IP:8082/cash** |
| 管理后台 | **http://YOUR_SERVER_IP:8082/admin** |

管理后台默认密码 **CHANGE_ME_2026**，登录后立刻去「系统设置 → 管理密码」改掉。

上线前建议按这个顺序过一遍：

1. **改密码**（系统设置）
2. **钉钉测试**：系统设置 → 「发送测试消息」，群里应收到一条含「抽中」的消息
3. **切到 CC 团队 → 库存管理 → 下载模板 → 填好后导入**
4. 顶部切到 **LP 团队**，同样导入一套（两个团队库存完全独立）
5. **抽奖人管理 → 添加姓名 + 次数**（支持批量粘贴 `姓名,次数`）
6. 手机打开 `/cc`，输入姓名抽一次，确认：转盘转动有声音、中奖弹窗正常、钉钉群收到 `张三抽中XXX`
7. 抽完次数后再抽应提示"次数已用完"，后台该人状态变成「已抽奖」；点「＋次数」可恢复
8. **现金抽奖（新）**：后台「④ 现金抽奖（CC）」→ 下载模板 → 填入奖项/金额/库存/每次发放/**概率** → 导入 → 单独添加现金参与人 → 手机打开 `/cash` 抽一次。现金的库存、名单、次数与实物完全独立；概率只决定中奖结果，转盘扇区一律等分（面积与概率无关），改完即时生效

---

## 六、日常运维

```bash
# 看服务状态
sudo systemctl status lottery

# 重启 / 停止 / 启动
sudo systemctl restart lottery
sudo systemctl stop lottery
sudo systemctl start lottery

# 实时日志（排错第一现场）
sudo journalctl -u lottery -f
tail -f /opt/lottery/server.log

# 备份数据（就一个 JSON 文件）
cp /opt/lottery/data/lottery-data.json ~/lottery-backup-$(date +%F).json
```

### 更新代码

改完代码后重新上传并重启即可，**数据不会丢**（数据在 `data/`，打包时已排除）：

```powershell
tar czf lottery-deploy.tar.gz --exclude=node_modules --exclude=.git --exclude=data --exclude=*.log .
scp -i $KEY lottery-deploy.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
ssh -i $KEY ubuntu@YOUR_SERVER_IP "sudo tar xzf /tmp/lottery-deploy.tar.gz -C /opt/lottery && sudo chown -R ubuntu:ubuntu /opt/lottery && sudo systemctl restart lottery"
```

### 想用域名 + HTTPS（可选）

四个项目共用一台机器时，常见做法是让 Nginx 占 80/443，按域名反代：

```nginx
server {
    listen 80;
    server_name lottery.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 重要：抽奖页用 SSE 做实时同步，必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

配好后 `sudo nginx -t && sudo systemctl reload nginx`，再用 certbot 签证书即可。

---

## 七、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器打不开、连接超时 | 8082 未在**控制台防火墙**放行 | 控制台 → 防火墙 → 添加 TCP:8082 |
| `Test-NetConnection` 通、页面空白 | 服务没起来 | `sudo journalctl -u lottery -n 50` |
| 部署脚本提示端口被占用 | 8082 已被别的项目用 | `bash deploy.sh 8083 /opt/lottery` 换个端口 |
| 页面 502 / 一直转圈 | Node 进程崩了 | `sudo systemctl restart lottery`，再看日志 |
| 实时同步不生效（要点刷新） | 前面挂了 Nginx 且开了 buffering | 按上面配置加 `proxy_buffering off;` |
| 钉钉收不到消息 | 机器人安全设置不匹配 | 后台记录里悬停「推送失败」看 errcode；`310000` = 关键词/加签不对，关键词填「抽中」 |
| 提示"不在抽奖名单中" | 该团队名单里没这个人 | 后台切到对应团队添加；注意姓名要和身份证/工牌一致 |
| 抽奖页显示"暂无奖品" | 该团队礼品发完或没导入 | 切到该团队导入 Excel 或补货 |
| 想清空重来 | — | 后台「系统设置 → 危险操作 → 清空当前团队」，只影响当前团队 |

---

## 八、上线检查清单

- [ ] `/opt/lottery` 存在，`systemctl status lottery` 为 `active (running)`
- [ ] 控制台防火墙已放行 TCP 8082
- [ ] 四个链接都能打开，CC 页面是红金主题、LP 页面是蓝金主题
- [ ] 管理密码已从 `CHANGE_ME_2026` 改掉
- [ ] 两个团队的 Excel 库存都导入成功，剩货数量对得上
- [ ] 抽奖人名单已添加，次数正确
- [ ] 钉钉群测试消息收到，实际抽奖也能收到 `姓名抽中奖品`
- [ ] 备份过一次 `data/lottery-data.json`
