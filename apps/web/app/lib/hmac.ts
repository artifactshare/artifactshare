import { encodeBase64Url } from './base64url'

const ENCODER = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function getHmacKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret)
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw',
      ENCODER.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    keyCache.set(secret, cached)
  }
  return cached
}

export async function hmacSha256(
  secret: string,
  message: string,
): Promise<ArrayBuffer> {
  const key = await getHmacKey(secret)
  return crypto.subtle.sign('HMAC', key, ENCODER.encode(message))
}

export async function hmacSha256Base64Url(
  secret: string,
  message: string,
): Promise<string> {
  return encodeBase64Url(await hmacSha256(secret, message))
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = ENCODER.encode(a)
  const bBytes = ENCODER.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i]! ^ bBytes[i]!
  }
  return diff === 0
}
