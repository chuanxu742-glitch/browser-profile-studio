@echo off
cd /d "%~dp0"
title Antigravity Browser Studio
node --import tsx/esm scripts/start-studio.ts
if %errorlevel% neq 0 pause
