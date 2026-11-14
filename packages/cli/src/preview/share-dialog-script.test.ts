// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true}}
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, test, vi } from 'vitest'
import { createShareDialogHandler } from './share-dialog.js'

test('refreshes only the editable dialog, coalescing pending snapshots and preserving auth, upload and result', async () => {
  const listeners = vi.spyOn(window, 'addEventListener')
  const opener = window
  vi.stubGlobal('opener', opener)
  vi.useFakeTimers()
  let finishSnapshot: (value: Response) => void = () => {}
  let finishShare: (value: Response) => void = () => {}
  const snapshots: string[] = []
  const uploads: unknown[] = []
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/snapshot') {
      snapshots.push(url)
      return new Promise<Response>((resolve) => {
        finishSnapshot = resolve
      })
    }
    if (url === '/api/share') {
      uploads.push(JSON.parse(init!.body as string))
      return new Promise<Response>((resolve) => {
        finishShare = resolve
      })
    }
    if (url.startsWith('/api/auth-status'))
      return Promise.resolve(Response.json({ status: 'authenticated' }))
    return Promise.resolve(
      Response.json({
        authenticated: false,
        projects: [],
        default_visibility: 'private',
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    let html = ''
    createShareDialogHandler({
      filePath: '/tmp/sample.html',
      fileName: 'sample.html',
      artifactOrigin: 'https://example.com',
      readFileBytes: () => Buffer.from('sample'),
      cliOptions: {},
    })(
      {
        method: 'GET',
        url: '/',
        headers: { host: '127.0.0.1' },
      } as IncomingMessage,
      {
        writeHead() {},
        end(value: string) {
          html = value
        },
      } as unknown as ServerResponse,
    )
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const script = parsed.querySelector('script')!.textContent!
    parsed.querySelector('script')!.remove()
    document.body.innerHTML = parsed.body.innerHTML
    const executable = document.createElement('script')
    executable.textContent = script
    document.body.appendChild(executable)
    const refresh = (
      origin = 'https://example.com',
      source: Window | null = opener,
    ) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source,
          data: { source: 'artifactshare-preview', kind: 'refresh-snapshot' },
        }),
      )
    const share = document.querySelector<HTMLButtonElement>('#shareBtn')!
    refresh()
    refresh()
    expect(snapshots).toHaveLength(1)
    expect(share.disabled).toBe(true)
    finishSnapshot(
      Response.json({
        snapshot_id: 'first',
        taken_at: new Date().toISOString(),
      }),
    )
    await vi.waitFor(() => expect(share.disabled).toBe(false))
    refresh('https://unrelated.example.com')
    refresh('https://example.com', null)
    expect(snapshots).toHaveLength(1)
    const visibility = document.querySelector<HTMLSelectElement>('#visibility')!
    visibility.value = 'link'
    visibility.dispatchEvent(new Event('change'))
    share.focus()
    refresh()
    visibility.focus()
    expect(snapshots).toHaveLength(2)
    finishSnapshot(
      Response.json({
        snapshot_id: 'second',
        taken_at: new Date().toISOString(),
      }),
    )
    await vi.waitFor(() => expect(share.disabled).toBe(false))
    expect(visibility.value).toBe('link')
    expect(document.activeElement).toBe(visibility)
    share.click()
    refresh()
    share.click()
    expect(uploads).toEqual([{ snapshot_id: 'second', visibility: 'link' }])
    expect(snapshots).toHaveLength(2)
    finishShare(
      Response.json({
        auth_required: true,
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        auth_id: 'auth',
        interval_seconds: 5,
      }),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('#dialog')!.className).toBe('dialog auth'),
    )
    expect(document.activeElement).toBe(document.querySelector('#authLink'))
    refresh()
    refresh()
    expect(document.querySelector('#userCode')!.textContent).toBe('CODE')
    expect(snapshots).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(document.querySelector('#dialog')!.className).toBe('dialog')
    expect(document.activeElement).toBe(document.querySelector('#destination'))
    expect(visibility.value).toBe('link')
    const error = document.querySelector<HTMLElement>('#shareError')!
    const guidance = error.textContent
    expect(guidance).not.toBe('')
    expect(error.style.display).toBe('block')
    share.focus()
    refresh()
    share.blur()
    expect(error.textContent).toBe(guidance)
    expect(error.style.display).toBe('block')
    finishSnapshot(Response.json({}, { status: 500 }))
    const retry = document.querySelector<HTMLButtonElement>('#snapshotRetry')!
    await vi.waitFor(() => expect(retry.hidden).toBe(false))
    expect(share.disabled).toBe(true)
    expect(document.activeElement).toBe(retry)
    retry.focus()
    retry.click()
    // Model engines that move focus to body when a focused button is disabled.
    retry.blur()
    finishSnapshot(Response.json({}, { status: 500 }))
    await vi.waitFor(() => expect(retry.disabled).toBe(false))
    expect(document.activeElement).toBe(retry)
    retry.click()
    visibility.focus()
    finishSnapshot(Response.json({}, { status: 500 }))
    await vi.waitFor(() => expect(retry.disabled).toBe(false))
    expect(document.activeElement).toBe(visibility)
    retry.focus()
    retry.click()
    finishSnapshot(
      Response.json({
        snapshot_id: 'third',
        taken_at: new Date().toISOString(),
      }),
    )
    await vi.waitFor(() => expect(share.disabled).toBe(false))
    expect(retry.hidden).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('#destination'))
    share.focus()
    share.click()
    finishShare(Response.json({ error: 'upload_failed' }, { status: 500 }))
    await vi.waitFor(() => expect(share.disabled).toBe(false))
    expect(document.activeElement).toBe(share)
    const failure = error.textContent
    expect(failure).not.toBe(guidance)
    refresh()
    // Model native engines that drop focus when Share is disabled.
    document.body.tabIndex = -1
    document.body.focus()
    expect(document.activeElement).toBe(document.body)
    expect(error.textContent).toBe(failure)
    expect(error.style.display).toBe('block')
    finishSnapshot(
      Response.json({
        snapshot_id: 'fourth',
        taken_at: new Date().toISOString(),
      }),
    )
    await vi.waitFor(() => expect(share.disabled).toBe(false))
    expect(error.style.display).toBe('block')
    expect(document.activeElement).toBe(share)
    share.click()
    refresh()
    expect(uploads).toHaveLength(3)
    expect(uploads[2]).toMatchObject({ snapshot_id: 'fourth' })
    finishShare(
      Response.json({
        url: 'https://example.com/shared',
        visibility: 'private',
        warnings: [{ message: 'Saved note' }],
      }),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('#dialog')!.className).toBe(
        'dialog shared',
      ),
    )
    refresh()
    expect(document.activeElement).toBe(document.querySelector('#shareUrl'))
    expect(document.querySelector<HTMLInputElement>('#shareUrl')!.value).toBe(
      'https://example.com/shared',
    )
    expect(document.querySelector('#shareNotes')!.textContent).toContain(
      'Saved note',
    )
    expect(snapshots).toHaveLength(7)
    expect(uploads).toHaveLength(3)
  } finally {
    for (const [type, listener] of listeners.mock.calls)
      window.removeEventListener(type, listener)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.removeAttribute('tabindex')
    document.body.innerHTML = ''
  }
})
