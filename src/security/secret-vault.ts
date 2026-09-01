import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

/** Small AES-256-GCM envelope used for secrets persisted by the local Studio. */
export class SecretVault {
  private readonly key: Buffer;

  public constructor(secret: string | Buffer) {
    const material = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'utf8');
    if (material.length < 16) throw new Error('SecretVault requires at least 16 bytes of key material');
    this.key = createHash('sha256').update(material).digest();
  }

  public isEncrypted(value: string): boolean { return value.startsWith(PREFIX); }

  public encrypt(value: string): string {
    if (!value || this.isEncrypted(value)) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
  }

  public decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (payload.length < 29) throw new Error('Encrypted secret envelope is invalid');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  }
}
