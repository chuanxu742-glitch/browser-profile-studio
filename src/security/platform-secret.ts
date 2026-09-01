import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { atomicWriteFile } from '../storage/atomic-file.js';

/** Stores a secret with Windows DPAPI when available; Unix falls back to a 0600 local file. */
export async function loadOrCreatePlatformSecret(path: string): Promise<string> {
  const protectedPath = process.platform === 'win32' ? `${path}.dpapi` : path;
  if (existsSync(protectedPath)) {
    const stored = (await readFile(protectedPath, 'utf8')).trim();
    return process.platform === 'win32' ? runPowerShell(DPAPI_UNPROTECT, stored) : stored;
  }
  if (process.platform === 'win32' && existsSync(path)) {
    const legacy = (await readFile(path, 'utf8')).trim();
    await atomicWriteFile(protectedPath, await runPowerShell(DPAPI_PROTECT, legacy));
    await rm(path, { force: true });
    return legacy;
  }
  const secret = randomBytes(32).toString('base64url');
  await atomicWriteFile(protectedPath, process.platform === 'win32' ? await runPowerShell(DPAPI_PROTECT, secret) : secret);
  return secret;
}

const DPAPI_PROTECT = "Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))";
const DPAPI_UNPROTECT = "Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($value);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`DPAPI command failed (${code}): ${error.trim()}`)));
    child.stdin.end(input);
  });
}
