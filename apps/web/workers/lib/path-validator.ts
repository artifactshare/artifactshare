import { hasRefusedExtension } from '@artifactshare/viewer-kit/reporter/refused-extensions'

export type PathValidationResult =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }

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

  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) {
    return { kind: 'blocked', reason: `Blocked path traversal: ${path}` }
  }

  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(path)) {
    return { kind: 'blocked', reason: `Blocked Windows absolute path: ${path}` }
  }

  if (hasRefusedExtension(path)) {
    return {
      kind: 'blocked',
      reason: `Blocked executable file extension: ${path}`,
    }
  }

  if (URL_RESERVED_CHAR_PATTERN.test(path)) {
    return {
      kind: 'blocked',
      reason: `Blocked URL reserved character in path: ${path}`,
    }
  }

  return { kind: 'ok' }
}
