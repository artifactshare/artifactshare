// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true}}
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { renderPreviewShell } from './shell.js'
import { PREVIEW_MESSAGES } from './messages.generated.js'
import { createPreviewStore } from './store.js'
import { createTextAnchorEngine } from '@artifactshare/viewer-kit/reporter/anchor-engine'

test('an unchanged page keeps saved legacy annotations attached without offering to discard them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'preview-legacy-'))
  const path = join(directory, 'annotations.json')
  const seed = createPreviewStore(path)
  seed.createDraft(
    {
      kind: 'text',
      state: 'attached',
      quotedText: 'brown',
      prefixText: 'The quick',
      suffixText: 'fox',
      textStart: 10,
      textEnd: 15,
      cssPath: null,
    },
    'Check this wording',
  )
  writeFileSync(
    path,
    JSON.stringify({ schema_version: 1, annotations: seed.all() }),
  )
  const store = createPreviewStore(path)
  const listeners = vi.spyOn(window, 'addEventListener')
  vi.useFakeTimers()
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      close() {}
    },
  )
  const fetcher = vi.fn(async () => Response.json({ annotations: store.all() }))
  vi.stubGlobal('fetch', fetcher)
  try {
    const shell = new DOMParser().parseFromString(
      renderPreviewShell({
        fileName: 'index.html',
        resumeCommand: 'artifactshare preview index.html',
        shareOrigin: 'https://example.com',
        messages: PREVIEW_MESSAGES,
      }).replace('src="/artifact"', ''),
      'text/html',
    )
    const script = shell.querySelector('script')!.textContent!
    shell.querySelector('script')!.remove()
    shell.querySelector('iframe')!.removeAttribute('src')
    document.body.innerHTML = shell.body.innerHTML
    const frame = document.querySelector('iframe')!
    const post = vi
      .spyOn(frame.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    const executable = document.createElement('script')
    executable.textContent = script
    document.body.appendChild(executable)
    await vi.waitFor(() =>
      expect(
        post.mock.calls.some(([message]) => message.kind === 'verify-anchors'),
      ).toBe(true),
    )
    const request = post.mock.calls.find(
      ([message]) => message.kind === 'verify-anchors',
    )![0]
    expect(document.querySelector('.thread')!.textContent).toContain(
      PREVIEW_MESSAGES.en['preview.positionChecking'],
    )
    const content = document.createElement('main')
    content.innerHTML = '<p>The quick brown fox</p>'
    const engine = createTextAnchorEngine(content)
    const verdicts = request.anchors.map(
      (anchor: { thread: string; quotedText: string }) => ({
        thread: anchor.thread,
        attached: engine.resolve(anchor) !== null,
        position_state: engine.resolve(anchor) ? 'attached' : 'needs-check',
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: {
          source: 'artifactshare',
          kind: 'anchor-verdicts',
          verificationId: request.verificationId,
          generation: 1,
          verdicts,
        },
      }),
    )
    expect(document.querySelector('.thread')!.textContent).not.toContain(
      PREVIEW_MESSAGES.en['preview.positionChecking'],
    )
    expect(verdicts[0].attached).toBe(true)
    expect(
      document.querySelector('#orphanNotice')!.classList.contains('show'),
    ).toBe(false)
    expect(document.querySelectorAll('.thread.orphaned')).toHaveLength(0)
    const writes = fetcher.mock.calls as unknown as [
      string,
      { body?: string },
    ][]
    expect(
      writes.some(
        ([url, init]) =>
          url === '/api/annotations/anchor-state' &&
          init?.body?.includes('orphaned'),
      ),
    ).toBe(false)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: {
          source: 'artifactshare',
          kind: 'anchor-verdicts',
          verificationId: request.verificationId,
          generation: 2,
          verdicts: [
            {
              thread: request.anchors[0].thread,
              attached: false,
              position_state: 'needs-check',
            },
          ],
        },
      }),
    )
    expect(document.querySelectorAll('.thread.orphaned')).toHaveLength(1)
    expect(
      document.querySelector('#orphanNotice')!.classList.contains('show'),
    ).toBe(true)
    expect(document.querySelector('.thread')!.textContent).toContain(
      PREVIEW_MESSAGES.en['preview.positionNeedsCheck'],
    )
  } finally {
    for (const [type, listener] of listeners.mock.calls)
      window.removeEventListener(type, listener)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    rmSync(directory, { recursive: true, force: true })
  }
})
