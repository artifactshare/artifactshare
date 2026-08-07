// 静的サイトバンドルのアップロード時、各ファイルの相対パスが構造的に安全
// であることを確認する純粋関数。`<workspaceId>/<shareableId>/<versionId>/...`
// の R2 キー組み立てに使われる前のガード。
//
// 設計方針: regex による content scan (secret / 外部リソース警告など) は実装しない。Browser
// の origin 隔離と CSP が本来の防御層であり、配信レイヤでの content scan は
// 業界主流 (Anthropic / OpenAI / CodePen / Vercel 等) でも採用されていない。
// path 系の問題はアプリ層の正当な責務として残し、それ以外はやらない。

export type PathValidationResult =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }

const EXECUTABLE_EXTENSION_PATTERN = /\.(?:exe|sh|php|py|rb|bat|cmd|dll|so)$/i
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/
const URL_RESERVED_CHAR_PATTERN = /[#?]/

function hasC0ControlCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (path.charCodeAt(i) <= 0x1f) return true
  }
  return false
}

export function validateBundlePath(path: string): PathValidationResult {
  if (hasC0ControlCharacter(path)) {
    return {
      kind: 'blocked',
      reason: `Blocked control character in path: ${path}`,
    }
  }

  // バックスラッシュも区切り文字として正規化したうえで `..` セグメントを検出。
  // `'..foo'` のような名前は traversal ではないので segment 完全一致で判定する。
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) {
    return { kind: 'blocked', reason: `Blocked path traversal: ${path}` }
  }

  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(path)) {
    return { kind: 'blocked', reason: `Blocked Windows absolute path: ${path}` }
  }

  if (EXECUTABLE_EXTENSION_PATTERN.test(path)) {
    return {
      kind: 'blocked',
      reason: `Blocked executable file extension: ${path}`,
    }
  }

  // `#` `?` は配信時に fragment / query 境界として URL を切断するため、
  // R2 受け入れの可否によらず path に含めることを許さない。Netlify も
  // 同じ理由で API レベルで reject している。
  if (URL_RESERVED_CHAR_PATTERN.test(path)) {
    return {
      kind: 'blocked',
      reason: `Blocked URL reserved character in path: ${path}`,
    }
  }

  return { kind: 'ok' }
}
