import { describe, expect, test } from 'vitest'
import { validateBundlePath } from './path-validator'

describe('validateBundlePath', () => {
  test('accepts ordinary bundle paths', () => {
    for (const path of [
      '/index.html',
      '/assets/app.js',
      '/images/logo.png',
      '/sub/page.html',
    ]) {
      expect(validateBundlePath(path)).toEqual({ kind: 'ok' })
    }
  })

  test('accepts top-level directories that match OS-like names', () => {
    // POSIX 絶対パス判定は撤廃済み。`/Users` `/home` `/tmp` 等が bundle 内
    // path として登場しても block しない。
    for (const path of [
      '/Users/profile.html',
      '/home/index.html',
      '/tmp/preview.html',
      '/etc/spec.html',
    ]) {
      expect(validateBundlePath(path)).toEqual({ kind: 'ok' })
    }
  })

  test('blocks path traversal with .. segments', () => {
    for (const path of ['/foo/../bar.html', '../leak.html', '/a/b/..']) {
      expect(validateBundlePath(path)).toMatchObject({ kind: 'blocked' })
    }
  })

  test('blocks backslash-separated traversal too', () => {
    expect(validateBundlePath('foo\\..\\bar.html')).toMatchObject({
      kind: 'blocked',
    })
  })

  test('blocks C0 control characters in path', () => {
    for (const path of ['/foo\x00.html', '/foo\nbar.html', '/foo\tbar.html']) {
      expect(validateBundlePath(path)).toMatchObject({ kind: 'blocked' })
    }
  })

  test('blocks executable file extensions', () => {
    for (const path of ['/deploy.sh', '/run.exe', '/script.PY', '/admin.php']) {
      expect(validateBundlePath(path)).toMatchObject({ kind: 'blocked' })
    }
  })

  test('blocks Windows absolute paths', () => {
    for (const path of [
      'C:\\Windows\\system32\\config',
      'D:/profile.html',
      'a:/foo',
    ]) {
      expect(validateBundlePath(path)).toMatchObject({ kind: 'blocked' })
    }
  })

  test('blocks URL reserved characters # and ?', () => {
    for (const path of [
      '/release#draft.html',
      '/search?q=foo.html',
      '/notes/#chapter.md',
      '/notes/?id=1.md',
    ]) {
      expect(validateBundlePath(path)).toMatchObject({ kind: 'blocked' })
    }
  })

  test('does NOT block names that merely contain .. without being a segment', () => {
    // ファイル名に `..` が含まれても segment 完全一致でなければ traversal とは
    // 看做さない。例: `/release-notes-v1..2.md`
    expect(validateBundlePath('/release-notes-v1..2.md')).toEqual({
      kind: 'ok',
    })
  })

  test('returns reason that includes the offending path for debugging', () => {
    const result = validateBundlePath('/deploy.sh')
    expect(result).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('/deploy.sh'),
    })
  })
})
