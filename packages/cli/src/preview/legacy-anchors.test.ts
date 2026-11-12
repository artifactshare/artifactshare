// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"enableIframePageLoading":true}}
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { isSandboxMessage } from '@artifactshare/viewer-kit/csp-reporter'
import { validPreviewObservation } from './reporter-protocol.js'
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
    frame.dispatchEvent(new Event('load'))
    await vi.waitFor(() =>
      expect(
        post.mock.calls.some(([message]) => message.kind === 'verify-anchors'),
      ).toBe(true),
    )
    const previewUrl = window.location.href
    const frameUrl = frame.src
    const snapshot = {
      source: 'artifactshare',
      kind: 'hash-changed',
      token: 'a'.repeat(64),
      hash: '#browser-only',
      path: '/index.html',
    }
    expect(isSandboxMessage(snapshot)).toBe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'null',
        data: snapshot,
      }),
    )
    expect(window.location.href).toBe(previewUrl)
    expect(frame.src).toBe(frameUrl)
    await vi.advanceTimersByTimeAsync(400)
    const request = post.mock.calls.findLast(
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
        origin: 'null',
        data: {
          source: 'artifactshare',
          previewCapability: request.previewCapability,
          documentGeneration: request.documentGeneration,
          sequence: 1,
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
        origin: 'null',
        data: {
          source: 'artifactshare',
          previewCapability: request.previewCapability,
          documentGeneration: request.documentGeneration,
          sequence: 2,
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
    expect(
      writes.some(([url]) => url === '/api/annotations/anchor-state'),
    ).toBe(false)
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

test.each(['http', 'network'])(
  'failed %s saves preserve input and anchor, allow one retry, and reuse the share popup',
  async (failure) => {
    const listeners = vi.spyOn(window, 'addEventListener')
    vi.useFakeTimers()
    vi.stubGlobal(
      'EventSource',
      class extends EventTarget {
        close() {}
      },
    )
    let finish: (value: Response) => void = () => {}
    let reject: (reason: Error) => void = () => {}
    const writes: { anchor: unknown; comment: string }[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/annotations' && init?.method === 'POST') {
        writes.push(JSON.parse(init.body as string))
        if (writes.length === 1)
          return new Promise<Response>((resolve, rejectPromise) => {
            finish = resolve
            reject = rejectPromise
          })
        return Promise.resolve(
          Response.json({ annotation: { thread: 'saved' } }),
        )
      }
      return Promise.resolve(Response.json({ annotations: [] }))
    })
    vi.stubGlobal('fetch', fetcher)
    const popup = {
      closed: false,
      focus: vi.fn(),
      postMessage: vi.fn(),
      close: vi.fn(),
    }
    const open = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as Window)
    try {
      const shell = new DOMParser().parseFromString(
        renderPreviewShell({
          fileName: 'sample.html',
          resumeCommand: '',
          shareOrigin: 'https://example.com',
          messages: PREVIEW_MESSAGES,
        }).replace('src="/artifact"', ''),
        'text/html',
      )
      const script = shell.querySelector('script')!.textContent!
      shell.querySelector('script')!.remove()
      document.body.innerHTML = shell.body.innerHTML
      const frame = document.querySelector('iframe')!
      const post = vi
        .spyOn(frame.contentWindow!, 'postMessage')
        .mockImplementation(() => {})
      const executable = document.createElement('script')
      executable.textContent = script
      document.body.appendChild(executable)
      frame.dispatchEvent(new Event('load'))
      await vi.waitFor(() => expect(post.mock.calls.length).toBeGreaterThan(0))
      const handshake = post.mock.calls[0]![0]
      const popover = document.querySelector<HTMLElement>('#popover')!
      vi.spyOn(popover, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            height: document.querySelector('#popError')!.textContent
              ? 240
              : 140,
          }) as DOMRect,
      )
      const anchor = {
        kind: 'element',
        state: 'attached',
        selector: 'p',
        label: 'p "Text"',
        contextText: 'Text',
        ownText: 'Text',
        tagName: 'P',
      }
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'null',
          data: {
            source: 'artifactshare',
            kind: 'element-annotate',
            previewCapability: handshake.previewCapability,
            documentGeneration: handshake.documentGeneration,
            sequence: 1,
            selector: anchor.selector,
            label: anchor.label,
            contextText: anchor.contextText,
            ownText: anchor.ownText,
            tagName: anchor.tagName,
            rect: {
              top: window.innerHeight - 80,
              left: 0,
              width: 10,
              height: 10,
            },
          },
        }),
      )
      const input = document.querySelector<HTMLTextAreaElement>('#popText')!
      const add = document.querySelector<HTMLButtonElement>('#popAdd')!
      input.value = '  keep this exact draft\nplease  '
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'null',
          data: {
            source: 'artifactshare',
            kind: 'element-annotate',
            previewCapability: handshake.previewCapability,
            documentGeneration: handshake.documentGeneration,
            sequence: 2,
            selector: 'h1',
            label: 'Other',
            contextText: 'Other',
            ownText: 'Other',
            tagName: 'H1',
            rect: { top: 0, left: 0, width: 10, height: 10 },
          },
        }),
      )
      expect(input.value).toBe('  keep this exact draft\nplease  ')
      expect(document.querySelector('#popTarget')!.textContent).toBe(
        anchor.label,
      )
      add.click()
      add.click()
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
      )
      expect(writes).toHaveLength(1)
      if (failure === 'http')
        finish(
          Response.json({ annotation: { thread: 'invalid' } }, { status: 500 }),
        )
      else reject(new Error('network unavailable'))
      await vi.waitFor(() => expect(add.disabled).toBe(false))
      expect(
        document.querySelector('#popover')!.classList.contains('show'),
      ).toBe(true)
      expect(input.value).toBe('  keep this exact draft\nplease  ')
      expect(document.querySelector('#popError')!.textContent).toBe(
        PREVIEW_MESSAGES.en['preview.annotationSaveFailed'],
      )
      expect(parseFloat(popover.style.top) + 240).toBeLessThanOrEqual(
        window.innerHeight - 8,
      )
      document.querySelector<HTMLButtonElement>('#modeToggle')!.click()
      expect(popover.classList.contains('show')).toBe(true)
      expect(input.value).toBe('  keep this exact draft\nplease  ')
      expect(document.querySelector('#popTarget')!.textContent).toBe(
        anchor.label,
      )
      for (const [index, pick] of [
        {
          kind: 'element-annotate',
          selector: 'h1',
          label: 'Other',
          contextText: 'Other',
          ownText: 'Other',
          tagName: 'H1',
        },
        {
          kind: 'text-selection',
          token: 'b'.repeat(64),
          versionId: null,
          quotedText: 'Other',
          prefixText: '',
          suffixText: '',
          textStart: 0,
          textEnd: 5,
          cssPath: 'h1',
          selectorFormat: 'normalized-v1',
          textHash: 'a'.repeat(64),
          ambiguousAtCreation: false,
        },
      ].entries()) {
        const data = {
          source: 'artifactshare',
          previewCapability: handshake.previewCapability,
          documentGeneration: handshake.documentGeneration,
          sequence: index + 3,
          ...pick,
          rect: { top: 0, left: 0, width: 10, height: 10 },
        }
        expect(validPreviewObservation(data)).toBe(true)
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            origin: 'null',
            data,
          }),
        )
        expect(input.value).toBe('  keep this exact draft\nplease  ')
        expect(document.querySelector('#popTarget')!.textContent).toBe(
          anchor.label,
        )
      }
      add.click()
      await vi.waitFor(() =>
        expect(
          document.querySelector('#popover')!.classList.contains('show'),
        ).toBe(false),
      )
      expect(writes).toEqual([
        { anchor, comment: 'keep this exact draft\nplease' },
        { anchor, comment: 'keep this exact draft\nplease' },
      ])
      expect(input.value).toBe('')
      document.querySelector<HTMLButtonElement>('#modeToggle')!.click()
      const currentHandshake = post.mock.calls
        .map(([message]) => message)
        .findLast((message) => message.kind === 'ready-check')
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'null',
          data: {
            source: 'artifactshare',
            kind: 'element-annotate',
            previewCapability: currentHandshake.previewCapability,
            documentGeneration: currentHandshake.documentGeneration,
            sequence: 5,
            selector: 'h1',
            label: 'Other',
            contextText: 'Other',
            ownText: 'Other',
            tagName: 'H1',
            rect: { top: 0, left: 0, width: 10, height: 10 },
          },
        }),
      )
      expect(popover.classList.contains('show')).toBe(true)
      expect(document.querySelector('#popTarget')!.textContent).toBe('Other')
      expect(input.value).toBe('')
      const share = document.querySelector<HTMLButtonElement>('#shareBtn')!
      share.click()
      share.click()
      expect(open).toHaveBeenCalledTimes(1)
      expect(popup.close).not.toHaveBeenCalled()
      expect(popup.postMessage).toHaveBeenCalledWith(
        { source: 'artifactshare-preview', kind: 'refresh-snapshot' },
        'https://example.com',
      )
      popup.closed = true
      share.click()
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      for (const [type, listener] of listeners.mock.calls)
        window.removeEventListener(type, listener)
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      document.body.innerHTML = ''
    }
  },
)
