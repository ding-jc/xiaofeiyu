@echo off
chcp 65001 >nul
REM 卸载桌宠深链协议注册（HKCU，无需管理员）。安装版卸载器会自动调用；
REM 免安装版用户删除文件夹后，可手动运行本脚本清理残留的 video-json-pet:// 协议。
set "KEY=HKCU\Software\Classes\video-json-pet"
reg query "%KEY%" >nul 2>&1
if errorlevel 1 (
  echo 未发现桌宠协议注册，无需清理。
) else (
  reg delete "%KEY%" /f
  echo 已清理桌宠协议注册 video-json-pet://。
)
pause
