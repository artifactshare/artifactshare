// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import {
  createViewerHashSync,
  restoreViewerHash,
  viewerReturnPath,
  VIEWER_FRAME_BOOTSTRAP_SCRIPT,
} from './viewer-hash'

const original = window.location.href
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.history.replaceState(null, '', original)
})

test.each(['/a/abc123def4?version=v1', '/?version=v1'])(
  'sign-in round trip keeps path, query and state at %s',
  (path) => {
    const callback = viewerReturnPath(path, '#q=abc&media=video')
    expect(callback).not.toContain('#')
    window.history.replaceState({ retained: true }, '', callback)
    const length = window.history.length
    restoreViewerHash()
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(path + '#q=abc&media=video')
    expect(window.history.state).toEqual({ retained: true })
    expect(window.history.length).toBe(length)
  },
)

test.each(['invalid', '#' + 'x'.repeat(2048), '//example.com'])(
  'invalid transported fragment %s cannot replace the hash',
  (hash) => {
    window.history.replaceState(
      null,
      '',
      '/?keep=1&as_hash=' + encodeURIComponent(hash) + '#keep',
    )
    restoreViewerHash()
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#keep')
  },
)

test('accepts the 2048-code-unit transported fragment', () => {
  const hash = '#' + 'x'.repeat(2047)
  window.history.replaceState(null, '', viewerReturnPath('/a/abc123def4', hash))
  restoreViewerHash()
  expect(window.location.hash).toBe(hash)
})

test('rapid reports coalesce, expose the latest value for recovery, and retain the final value', () => {
  vi.useFakeTimers()
  window.history.replaceState({ retained: true }, '', '/?keep=1#old')
  const sync = createViewerHashSync()
  const replace = vi.spyOn(window.history, 'replaceState')
  for (let i = 0; i < 250; i++) sync.accept('#step=' + i)
  expect(sync.latest()).toBe('#step=249')
  expect(replace).not.toHaveBeenCalled()
  vi.advanceTimersByTime(200)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(window.location.hash).toBe('#step=249')
  sync.accept('')
  vi.advanceTimersByTime(200)
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe('/?keep=1')
  expect(window.history.state).toEqual({ retained: true })
})

test.each(['#accepted', ''])(
  'flush applies accepted fragment %s immediately and cancels its old timer',
  (hash) => {
    vi.useFakeTimers()
    window.history.replaceState({ retained: true }, '', '/?keep=1#old')
    const length = window.history.length
    const sync = createViewerHashSync()
    const replace = vi.spyOn(window.history, 'replaceState')
    sync.accept(hash)
    vi.advanceTimersByTime(50)
    expect(replace).not.toHaveBeenCalled()
    sync.flush()
    expect(window.location.hash).toBe(hash)
    expect(window.location.pathname + window.location.search).toBe('/?keep=1')
    expect(window.history.state).toEqual({ retained: true })
    expect(window.history.length).toBe(length)
    expect(replace).toHaveBeenCalledTimes(1)
    sync.accept('#next-document')
    vi.advanceTimersByTime(150)
    expect(replace).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(window.location.hash).toBe('#next-document')
    expect(replace).toHaveBeenCalledTimes(2)
    sync.flush()
    vi.advanceTimersByTime(200)
    expect(replace).toHaveBeenCalledTimes(2)
  },
)

test('deduplicates against the last pending report and cancels stale documents', () => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '#old')
  const sync = createViewerHashSync()
  const replace = vi.spyOn(window.history, 'replaceState')
  sync.accept('#new')
  sync.accept('#old')
  vi.advanceTimersByTime(200)
  expect(replace).not.toHaveBeenCalled()
  sync.accept('#stale')
  sync.clear()
  vi.advanceTimersByTime(200)
  expect(replace).not.toHaveBeenCalled()
})

test.each(['#final', ''])(
  'retries the final fragment %s after throttling without another report',
  (hash) => {
    vi.useFakeTimers()
    window.history.replaceState({ retained: true }, '', '/?keep=1#old')
    const length = window.history.length
    const sync = createViewerHashSync()
    const deny = () => {
      throw new DOMException('Throttled', 'SecurityError')
    }
    const replace = vi
      .spyOn(window.history, 'replaceState')
      .mockImplementationOnce(deny)
      .mockImplementationOnce(deny)
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    sync.accept(hash)
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(() => vi.advanceTimersByTime(200)).not.toThrow()
      expect(replace).toHaveBeenCalledTimes(attempt)
      expect(window.location.hash).toBe('#old')
      expect(sync.latest()).toBe(hash)
      expect(dispatch).not.toHaveBeenCalled()
    }
    vi.advanceTimersByTime(199)
    expect(replace).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(window.location.hash).toBe(hash)
    expect(window.location.pathname + window.location.search).toBe('/?keep=1')
    expect(window.history.state).toEqual({ retained: true })
    expect(window.history.length).toBe(length)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].type).toBe('artifactshare:hash-changed')
    vi.advanceTimersByTime(1000)
    expect(replace).toHaveBeenCalledTimes(3)
  },
)

test('new reports supersede a failed write and document cleanup cancels retries', () => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '#old')
  const sync = createViewerHashSync()
  const deny = () => {
    throw new DOMException('Throttled', 'SecurityError')
  }
  const replace = vi
    .spyOn(window.history, 'replaceState')
    .mockImplementationOnce(deny)
  sync.accept('#failed')
  vi.advanceTimersByTime(200)
  sync.accept('#latest')
  vi.advanceTimersByTime(200)
  expect(window.location.hash).toBe('#latest')
  expect(replace).toHaveBeenCalledTimes(2)
  replace.mockImplementationOnce(deny)
  sync.accept('#stale')
  vi.advanceTimersByTime(200)
  expect(sync.latest()).toBe('#stale')
  sync.clear()
  vi.advanceTimersByTime(1000)
  expect(replace).toHaveBeenCalledTimes(3)
  expect(window.location.hash).toBe('#latest')
  expect(sync.latest()).toBe('#latest')
})

test.each(['#q=abc', 'invalid', '#' + 'x'.repeat(2048)])(
  'SSR bootstrap restores only valid transported fragments before setting src: %s',
  (hash) => {
    window.history.replaceState(
      { retained: true },
      '',
      '/?keep=1&as_hash=' + encodeURIComponent(hash) + '#old',
    )
    const frame = document.createElement('iframe')
    frame.dataset.src = 'https://example.test/index.html?t=synthetic-token'
    const script = { previousElementSibling: frame }
    const run = new Function(
      'window',
      'document',
      VIEWER_FRAME_BOOTSTRAP_SCRIPT,
    )
    run(window, { currentScript: script })
    const expected = hash.startsWith('#') && hash.length <= 2048 ? hash : '#old'
    expect(frame.src).toBe(frame.dataset.src + expected)
    expect(window.location.pathname + window.location.search).toBe('/?keep=1')
    expect(window.history.state).toEqual({ retained: true })
    // Rerunning the bootstrap must never restart a one-time token navigation.
    window.history.replaceState(null, '', '#different')
    run(window, { currentScript: script })
    expect(frame.src).toBe(frame.dataset.src + expected)
  },
)

test('auth transport escapes fragment punctuation including asterisks', () => {
  const hash = "#q=one%20two&chars=*~!'()"
  const callback = viewerReturnPath('/a/abc123def4?version=v1', hash)
  expect(callback).not.toMatch(/[#*!'()~]/)
  window.history.replaceState(null, '', callback)
  restoreViewerHash()
  expect(window.location.hash).toBe(hash)
})
