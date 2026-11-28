import { customAlphabet } from 'nanoid'

// DNS-safe ('-' を含めず英数字のみ)。`<id>.sandbox.artifactshare.com` の
// label として常に RFC 1123 を満たし、`/a/<id>` URL slug でも兼用できる。
export const createShareableId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  10,
)
