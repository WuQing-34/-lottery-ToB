@echo off
chcp 65001 >nul
cd /d %~dp0
title 幸运大转盘抽奖系统
echo.
echo   ============================================
echo      幸运大转盘抽奖系统 正在启动...
echo   ============================================
echo.
echo   抽奖页面： http://localhost:8082/
echo   CC 团队：  http://localhost:8082/cc
echo   LP 团队：  http://localhost:8082/lp
echo   CC 现金：  http://localhost:8082/cash
echo   管理后台： http://localhost:8082/admin
echo   默认密码： CHANGE_ME_2026
echo.
echo   关闭此窗口即停止服务
echo   ============================================
echo.
node server/index.js
pause
