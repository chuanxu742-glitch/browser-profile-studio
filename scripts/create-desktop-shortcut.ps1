$wscript = New-Object -ComObject WScript.Shell
$desktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$shortcutPath = Join-Path $desktopPath "Antigravity 指纹浏览器.lnk"
$targetScript = Join-Path $PSScriptRoot "..\start-browser-studio.bat"
$workingDir = Resolve-Path (Join-Path $PSScriptRoot "..")

$shortcut = $wscript.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetScript
$shortcut.WorkingDirectory = $workingDir.Path
$shortcut.Description = "Antigravity Browser Studio - 本地浏览器环境隔离工作台"
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "✅ 已成功在 Windows 桌面创建快捷方式: $shortcutPath"
