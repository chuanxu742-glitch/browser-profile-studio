import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const desktop = join(homedir(), 'Desktop');
const shortcutPath = join(desktop, 'Antigravity 指纹浏览器.lnk');
const targetScript = join(process.cwd(), 'start-browser-studio.bat');
const workingDir = process.cwd();

const psCommand = `
$wscript = New-Object -ComObject WScript.Shell;
$shortcut = $wscript.CreateShortcut('${shortcutPath.replace(/\\/g, '\\\\')}');
$shortcut.TargetPath = '${targetScript.replace(/\\/g, '\\\\')}';
$shortcut.WorkingDirectory = '${workingDir.replace(/\\/g, '\\\\')}';
$shortcut.Description = 'Antigravity Browser Studio - 本地浏览器环境隔离工作台';
$shortcut.Save();
`;

try {
  execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`, { stdio: 'inherit' });
  console.log(`✅ 成功在桌面生成快捷方式: ${shortcutPath}`);
} catch (e: any) {
  console.error('快捷方式创建警告:', e.message);
}
