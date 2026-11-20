@echo off
chcp 65001 >nul
title 抽奖系统 - 部署到服务器
cd /d "%~dp0.."

echo.
echo ============================================
echo   抽奖系统 部署向导
echo   私钥下载：腾讯云轻量控制台 - 密钥对 - YOUR_KEY_ID
echo ============================================
echo.

set /p KEYPEM=1) 私钥文件完整路径（例如 C:\Users\YOUR_USERNAME\Downloads\skey.pem）:
set /p SRVIP=2) 服务器 IP（回车默认 YOUR_SERVER_IP）:
if "%SRVIP%"=="" set SRVIP=YOUR_SERVER_IP
set /p PORT=3) 对外端口（回车默认 8082）:
if "%PORT%"=="" set PORT=8082

echo.
echo [1/4] 打包（不含 node_modules / 本地数据 / 日志）
if exist lottery-deploy.tar.gz del /f /q lottery-deploy.tar.gz
tar czf lottery-deploy.tar.gz --exclude=node_modules --exclude=.git --exclude=data --exclude=*.log .

echo [2/4] 上传到 %SRVIP%
scp -i "%KEYPEM%" -o StrictHostKeyChecking=accept-new lottery-deploy.tar.gz ubuntu@%SRVIP%:/tmp/

echo [3/4] 解压到 /opt/lottery
ssh -i "%KEYPEM%" ubuntu@%SRVIP% "sudo mkdir -p /opt/lottery && sudo tar xzf /tmp/lottery-deploy.tar.gz -C /opt/lottery && sudo chown -R ubuntu:ubuntu /opt/lottery && rm -f /tmp/lottery-deploy.tar.gz"

echo [4/4] 安装依赖并配置 systemd 服务（端口 %PORT%）
ssh -i "%KEYPEM%" ubuntu@%SRVIP% "bash /opt/lottery/deploy/deploy.sh %PORT% /opt/lottery"

del /f /q lottery-deploy.tar.gz 2>nul

echo.
echo ============================================
echo   如果上面没有报错，就是部署成功：
echo.
echo   团队入口    http://%SRVIP%:%PORT%/
echo   CC 抽奖页   http://%SRVIP%:%PORT%/cc
echo   LP 抽奖页   http://%SRVIP%:%PORT%/lp
echo   管理后台    http://%SRVIP%:%PORT%/admin
echo   默认密码    CHANGE_ME_2026
echo ============================================
echo.
pause
