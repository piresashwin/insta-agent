/**
 * Lesson 14 — encrypt tokens at rest (AES-256-GCM).
 * Key from TOKEN_ENCRYPTION_KEY (32-byte hex or any passphrase hashed).
 */
import crypto from 'crypto'

const PREFIX = 'v1:'

function keyBytes(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || 'dev-only-change-me-instagram-agent'
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return crypto.createHash('sha256').update(raw).digest()
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64url')
}

export function decryptSecret(payload: string): string {
  if (!payload.startsWith(PREFIX)) {
    // Legacy plaintext (pre-encryption) — still readable once.
    return payload
  }
  const buf = Buffer.from(payload.slice(PREFIX.length), 'base64url')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
