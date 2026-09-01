@echo off
chcp 65001 >nul
title 👑 Antigravity 商业级防关联指纹浏览器工作台

echo ===============================================================================
echo   👑 正在启动 Antigravity 指纹浏览器 (AdsPower / 紫鸟商业级形态)
echo   🛡️ 独立隔离环境 · 物理隔离存储 · 10重反检测伪装引擎 · 支持多开与代理绑定
echo ===============================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境，请先安装 Node.js (v18+): https://nodejs.org/
    pause
    exit /b 1
)

echo [1/2] 正在初始化指纹浏览器核心引擎与本地持久化沙箱...
echo [2/2] 正在拉起桌面控制台工作台...
echo.

npm run studio

pause
