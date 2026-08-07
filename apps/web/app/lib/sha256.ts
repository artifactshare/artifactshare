import { encodeBase64Url } from './base64url'

export async function computeFileSha256(
  source: Blob | ArrayBuffer,
): Promise<string> {
  const buffer =
    source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return encodeBase64Url(digest)
}

const TEXT_ENCODER = new TextEncoder()

export async function computeTextSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    TEXT_ENCODER.encode(text),
  )
  return encodeBase64Url(digest)
}

export async function computeTextSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    TEXT_ENCODER.encode(text),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
