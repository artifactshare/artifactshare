import { customAlphabet } from 'nanoid'

// DNS-safe ('-' を含めず英数字のみ)。`<id>.sandbox.artifactshare.com` の
// label として常に RFC 1123 を満たし、`/a/<id>` URL slug でも兼用できる。
// 10 文字 × 36 種 = 約 3.7e15 通り (~52 bit)。10^9 行に到達してもペア衝突は
// 1e18/3.7e15 オーダーで稀。retry ループが残った微小確率をカバーする。
export const createShareableId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  10,
)
