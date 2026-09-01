import { createHmac } from 'node:crypto';

/**
 * Standard RFC 6238 Time-Based One-Time Password (TOTP) Generator.
 * Fully compatible with Google Authenticator, Microsoft Authenticator, and Bitwarden.
 */

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBuffer(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_CHARS.indexOf(clean.charAt(i));
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, timeStepSeconds = 30): { code: string; remainingSeconds: number } {
  if (!secret) return { code: '000000', remainingSeconds: 30 };
  try {
    const key = base32ToBuffer(secret);
    const now = Math.floor(Date.now() / 1000);
    const counter = Math.floor(now / timeStepSeconds);
    const remainingSeconds = timeStepSeconds - (now % timeStepSeconds);

    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter), 0);

    const hmac = createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const binary =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);

    const otp = binary % 1000000;
    const code = otp.toString().padStart(6, '0');
    return { code, remainingSeconds };
  } catch {
    return { code: 'ERR2FA', remainingSeconds: 0 };
  }
}
