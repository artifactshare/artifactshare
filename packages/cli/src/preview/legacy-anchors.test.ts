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

test.each([false, true])(
  'startup reports a quarantined store even when initial SSE arrives first (%s)',
  async (incomingFirst) => {
    const listeners = vi.spyOn(window, 'addEventListener')
    const events = Object.assign(new EventTarget(), { close() {} })
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', function () {
      return events
    })
    let finishBoot: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishBoot = resolve
          }),
      ),
    )
    try {
      const shell = new DOMParser().parseFromString(
        renderPreviewShell({
          fileName: 'sample.html',
          resumeCommand: 'artifactshare preview sample.html',
          shareOrigin: 'https://example.com',
          messages: PREVIEW_MESSAGES,
        }).replace('src="/artifact"', ''),
        'text/html',
      )
      const script = shell.querySelector('script')!.textContent!
      shell.querySelector('script')!.remove()
      document.body.innerHTML = shell.body.innerHTML
      const executable = document.createElement('script')
      executable.textContent = script
      document.body.appendChild(executable)
      if (incomingFirst) {
        events.dispatchEvent(
          new MessageEvent('annotations', {
            data: JSON.stringify({
              annotations: [
                {
                  thread: 'synthetic-thread',
                  anchor: { kind: 'artifact' },
                  comment: 'Newer saved comment',
                  messages: [{ author: 'human', body: 'Newer saved comment' }],
                  status: 'resolved',
                },
              ],
              agent: { state: 'completed' },
            }),
          }),
        )
        expect(document.querySelector('.thread.resolved')).not.toBeNull()
      }
      finishBoot(
        Response.json({
          annotations: [],
          agent: { state: 'manual_required' },
          revision: 'initial-revision',
          quarantined: true,
        }),
      )
      await vi.waitFor(() =>
        expect(document.querySelector('#orphanText')!.textContent).toBe(
          PREVIEW_MESSAGES.en['preview.corruptNotice'],
        ),
      )
      expect(
        document.querySelector('#orphanNotice')!.classList.contains('show'),
      ).toBe(true)
      expect(
        document.querySelector<HTMLElement>('#orphanDiscard')!.style.display,
      ).toBe('none')
      if (incomingFirst) {
        expect(
          document.querySelector('.thread.resolved')!.textContent,
        ).toContain('Newer saved comment')
      } else {
        expect(document.querySelectorAll('.thread')).toHaveLength(0)
      }
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
  let discardFailed = true
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/orphan-discard'))
      return discardFailed
        ? Response.json({}, { status: 500 })
        : Response.json({ results: [] })
    return Response.json({ annotations: store.all() })
  })
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
    document.querySelector<HTMLButtonElement>('#orphanDiscard')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('#operationError')!.textContent).toBe(
        PREVIEW_MESSAGES.en['preview.operationFailed'],
      ),
    )
    expect(document.querySelectorAll('.thread.orphaned')).toHaveLength(1)
    expect(
      document.querySelector('#orphanNotice')!.classList.contains('show'),
    ).toBe(true)
    discardFailed = false
    document.querySelector<HTMLButtonElement>('#orphanDiscard')!.click()
    await vi.waitFor(() =>
      expect(
        document.querySelector('#orphanNotice')!.classList.contains('show'),
      ).toBe(false),
    )
    expect(document.querySelectorAll('.thread.orphaned')).toHaveLength(0)
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

test.each([
  { failure: 'success', locale: 'en', recovery: 'absent' },
  { failure: 'http', locale: 'en', recovery: 'absent' },
  { failure: 'network', locale: 'en', recovery: 'absent' },
  { failure: 'http', locale: 'en', recovery: 'absent', moveFocus: 'canvas' },
  { failure: 'http', locale: 'en', recovery: 'absent', moveFocus: 'window' },
  { failure: 'http', locale: 'en', recovery: 'absent', moveFocus: 'frame' },
  {
    failure: 'http',
    locale: 'en',
    recovery: 'absent',
    moveFocus: 'editor-blur',
  },
  { failure: 'http', locale: 'ja', recovery: 'absent' },
  { failure: 'network', locale: 'ja', recovery: 'absent' },
  { failure: 'network', locale: 'en', recovery: 'saved' },
  { failure: 'unreadable', locale: 'ja', recovery: 'saved' },
  { failure: 'network', locale: 'en', recovery: 'unavailable' },
  { failure: 'network', locale: 'en', recovery: 'superseded' },
] as const)(
  '$failure ($recovery) saves in $locale protect pending input and preserve recovery',
  async (scenario) => {
    const { failure, locale, recovery } = scenario
    const moveFocus = 'moveFocus' in scenario && scenario.moveFocus
    const focusWindow = vi.spyOn(window, 'focus').mockImplementation(() => {})
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale)
    const events = Object.assign(new EventTarget(), { close() {} })
    const listeners = vi.spyOn(window, 'addEventListener')
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', function () {
      return events
    })
    let finish: (value: Response) => void = () => {}
    let reject: (reason: Error) => void = () => {}
    let readUnavailable = false
    let deferRead = false
    let finishRead: ((value: Response) => void) | undefined
    const recovered: Record<string, unknown>[] = []
    const writes: { anchor: unknown; comment: string }[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/annotations' && init?.method === 'POST') {
        writes.push(JSON.parse(init.body as string))
        return new Promise<Response>((resolve, rejectPromise) => {
          finish = resolve
          reject = rejectPromise
        })
      }
      if (deferRead)
        return new Promise<Response>((resolve) => {
          finishRead = resolve
        })
      return readUnavailable
        ? Promise.reject(new Error('read unavailable'))
        : Promise.resolve(Response.json({ annotations: recovered }))
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
          resumeCommand: 'artifactshare preview sample.html',
          shareOrigin: 'https://example.com',
          messages: PREVIEW_MESSAGES,
        }).replace('src="/artifact"', ''),
        'text/html',
      )
      const script = shell.querySelector('script')!.textContent!
      shell.querySelector('script')!.remove()
      document.body.innerHTML = shell.body.innerHTML
      const frame = document.querySelector('iframe')!
      let frameSource = frame.src
      vi.spyOn(frame, 'src', 'get').mockImplementation(() => frameSource)
      vi.spyOn(frame, 'src', 'set').mockImplementation((value) => {
        frameSource = value
      })
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
      expect(document.querySelector('label[for=popText]')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.editorLabel'],
      )
      expect(input.getAttribute('aria-describedby')).toContain('popTarget')
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
      expect(document.querySelector('#popStatus')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.entryBlocked'],
      )
      frame.focus()
      focusWindow.mockClear()
      add.click()
      add.click()
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
      )
      expect(writes).toHaveLength(1)
      expect(input.readOnly).toBe(true)
      expect(add.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.savePending'],
      )
      expect(document.activeElement).toBe(input)
      expect(input.getAttribute('aria-busy')).toBe('true')
      expect(
        document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
      ).toBe(true)
      expect(document.querySelector('#popStatus')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.savePending'],
      )
      events.dispatchEvent(
        new MessageEvent('reload', {
          data: JSON.stringify({ revision: 'old-revision' }),
        }),
      )
      events.dispatchEvent(
        new MessageEvent('reload', {
          data: JSON.stringify({ revision: 'latest-revision' }),
        }),
      )
      expect(document.querySelector('#popStatus')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.updateQueued'],
      )
      expect(frame.src).not.toContain('latest-revision')
      focusWindow.mockClear()
      if (failure === 'success') {
        finish(Response.json({ annotation: { thread: 'saved' } }))
        await vi.waitFor(() =>
          expect(popover.classList.contains('show')).toBe(false),
        )
        expect(input.readOnly).toBe(false)
        expect(input.hasAttribute('aria-busy')).toBe(false)
        expect(
          document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
        ).toBe(false)
        expect(input.value).toBe('')
        expect(writes).toEqual([
          { anchor, comment: 'keep this exact draft\nplease' },
        ])
        expect(frame.src).toContain('latest-revision')
        return
      }
      const saved = {
        thread: 'saved',
        status: 'draft',
        ...writes[0],
        messages: [{ author: 'human', body: writes[0]!.comment }],
      }
      const canvas =
        document.querySelector<HTMLSelectElement>('#canvasBackground')!
      if (moveFocus === 'canvas') canvas.focus()
      if (moveFocus === 'window') window.dispatchEvent(new Event('blur'))
      if (moveFocus === 'editor-blur') input.blur()
      if (moveFocus === 'frame') {
        // A reporter pick independently cancels restoration; no parent
        // focusin event is required for this authenticated frame message.
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            origin: 'null',
            data: {
              source: 'artifactshare',
              kind: 'element-annotate',
              previewCapability: handshake.previewCapability,
              documentGeneration: handshake.documentGeneration,
              sequence: 3,
              selector: 'h1',
              label: 'Other',
              contextText: 'Other',
              ownText: 'Other',
              tagName: 'H1',
              rect: { top: 0, left: 0, width: 10, height: 10 },
            },
          }),
        )
      }
      if (recovery === 'saved') recovered.push(saved)
      if (recovery === 'unavailable') readUnavailable = true
      if (recovery === 'superseded') deferRead = true
      if (failure === 'unreadable')
        finish(new Response('unreadable acknowledgement'))
      else if (failure === 'http')
        finish(
          Response.json({ annotation: { thread: 'invalid' } }, { status: 500 }),
        )
      else reject(new Error('network unavailable'))
      if (recovery === 'superseded') {
        await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
        events.dispatchEvent(
          new MessageEvent('annotations', {
            data: JSON.stringify({
              annotations: [],
              agent: { state: 'completed' },
            }),
          }),
        )
        finishRead!(Response.json({ annotations: [] }))
        deferRead = false
        readUnavailable = true
      }
      if (recovery !== 'absent') {
        await vi.waitFor(() =>
          expect(document.querySelector('#popError')!.textContent).toBe(
            PREVIEW_MESSAGES[locale][
              recovery === 'saved'
                ? 'preview.annotationAlreadySaved'
                : 'preview.annotationSaveUnknown'
            ],
          ),
        )
        expect(input.readOnly).toBe(false)
        expect(input.hasAttribute('aria-busy')).toBe(false)
        expect(
          document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
        ).toBe(false)
        expect(document.querySelector('#operationError')!.textContent).toBe('')
        expect(input.value).toBe('  keep this exact draft\nplease  ')
        if (recovery === 'unavailable' || recovery === 'superseded') {
          expect(add.textContent).toBe(
            PREVIEW_MESSAGES[locale]['preview.checkSave'],
          )
          add.click()
          expect(input.readOnly).toBe(true)
          await vi.waitFor(() => expect(add.disabled).toBe(false))
          expect(input.readOnly).toBe(false)
          expect(input.hasAttribute('aria-busy')).toBe(false)
          expect(
            document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
          ).toBe(false)
          expect(writes).toHaveLength(1)
          readUnavailable = false
          recovered.push(saved)
          add.click()
          await vi.waitFor(() =>
            expect(document.querySelector('#popError')!.textContent).toBe(
              PREVIEW_MESSAGES[locale]['preview.annotationAlreadySaved'],
            ),
          )
        }
        expect(add.disabled).toBe(true)
        expect(document.querySelector('.thread')!.textContent).toContain(
          writes[0]!.comment,
        )
        add.click()
        expect(add.disabled).toBe(true)
        expect(writes).toHaveLength(1)
        expect(input.value).toBe('  keep this exact draft\nplease  ')
        return
      }
      await vi.waitFor(() => expect(add.disabled).toBe(false))
      expect(input.readOnly).toBe(false)
      expect(input.hasAttribute('aria-busy')).toBe(false)
      expect(
        document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
      ).toBe(false)
      expect(document.querySelector('#operationError')!.textContent).toBe('')
      expect(
        document.querySelector('#popover')!.classList.contains('show'),
      ).toBe(true)
      expect(input.value).toBe('  keep this exact draft\nplease  ')
      expect(document.querySelector('#popError')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.annotationSaveFailed'],
      )
      expect(document.activeElement).toBe(
        moveFocus === 'canvas'
          ? canvas
          : moveFocus === 'editor-blur'
            ? document.body
            : input,
      )
      expect(focusWindow).toHaveBeenCalledTimes(moveFocus ? 0 : 1)
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
          sequence: index + 4,
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
      expect(input.readOnly).toBe(true)
      expect(input.value).toBe('  keep this exact draft\nplease  ')
      expect(frame.src).not.toContain('latest-revision')
      finish(Response.json({ annotation: { thread: 'saved' } }))
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
      expect(input.readOnly).toBe(false)
      expect(input.hasAttribute('aria-busy')).toBe(false)
      expect(
        document.querySelector<HTMLButtonElement>('#popCancel')!.disabled,
      ).toBe(false)
      expect(frame.src).toContain('latest-revision')
      frame.dispatchEvent(new Event('load'))
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
      events.dispatchEvent(
        new MessageEvent('reload', {
          data: JSON.stringify({ revision: 'cancel-revision' }),
        }),
      )
      document.querySelector<HTMLButtonElement>('#modeToggle')!.click()
      expect(popover.classList.contains('show')).toBe(true)
      document.querySelector<HTMLButtonElement>('#popCancel')!.click()
      expect(frame.src).toContain('cancel-revision')
      expect(popover.classList.contains('show')).toBe(false)
      frame.dispatchEvent(new Event('load'))
      const toggle = document.querySelector<HTMLButtonElement>('#modeToggle')!
      if (toggle.getAttribute('aria-checked') === 'false') toggle.click()
      const finalHandshake = post.mock.calls
        .map(([message]) => message)
        .findLast((message) => message.kind === 'ready-check')
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'null',
          data: {
            source: 'artifactshare',
            kind: 'element-annotate',
            previewCapability: finalHandshake.previewCapability,
            documentGeneration: finalHandshake.documentGeneration,
            sequence: 1,
            selector: 'p',
            label: 'Text',
            contextText: 'Text',
            ownText: 'Text',
            tagName: 'P',
            rect: { top: 0, left: 0, width: 10, height: 10 },
          },
        }),
      )
      // An acknowledgement arriving after shutdown must not erase the draft.
      input.value = 'Copy this exact unsaved text'
      add.click()
      if (failure === 'http' && locale === 'ja') {
        const finished = new MessageEvent('message', {
          source: popup as unknown as Window,
          origin: 'https://example.com',
          data: {
            source: 'artifactshare-preview-share',
            kind: 'share-finished',
          },
        })
        window.dispatchEvent(finished)
        window.dispatchEvent(finished)
        expect(
          fetcher.mock.calls.filter(([url]) => url === '/api/agent/stop'),
        ).toEqual([
          [
            '/api/agent/stop',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-artifactshare-preview': '1',
              },
              body: '{}',
            },
          ],
        ])
      } else {
        events.dispatchEvent(new Event('session-ended'))
      }
      const lateResponse = new Response()
      const acknowledged = vi
        .spyOn(lateResponse, 'json')
        .mockResolvedValue({ annotation: { thread: 'saved-after-end' } })
      finish(lateResponse)
      await vi.waitFor(() => expect(acknowledged).toHaveBeenCalled())
      expect(add.disabled).toBe(true)
      expect(input.value).toBe('Copy this exact unsaved text')
      expect(input.readOnly).toBe(true)
      events.dispatchEvent(
        new MessageEvent('annotations', {
          data: JSON.stringify({
            annotations: [
              {
                thread: 'late-thread',
                status: 'draft',
                anchor: { kind: 'artifact' },
                messages: [],
              },
            ],
          }),
        }),
      )
      expect(document.querySelectorAll('button:not(:disabled)')).toHaveLength(0)
      expect(document.querySelector('#endedScreen')!.contains(input)).toBe(true)
      expect(document.querySelector('#endedBody')!.textContent).toBe(
        PREVIEW_MESSAGES[locale]['preview.ended.unsaved'].replace(
          '{command}',
          'artifactshare preview sample.html',
        ),
      )
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

test.each(['requested', 'resolved', 'failed'] as const)(
  'failed handoff reconciles without reverting newer incoming state (%s)',
  async (outcome) => {
    const incoming = outcome === 'resolved'
    let posted = false
    const listeners = vi.spyOn(window, 'addEventListener')
    vi.useFakeTimers()
    const events = Object.assign(new EventTarget(), { close() {} })
    vi.stubGlobal('EventSource', function () {
      return events
    })
    let finishRead: (value: Response) => void = () => {}
    let reconciling = false
    const annotation = {
      thread: 'synthetic-thread',
      anchor: { kind: 'artifact' },
      comment: 'Keep this request',
      messages: [{ author: 'human', body: 'Keep this request' }],
      status: 'draft',
    }
    const previous =
      outcome === 'failed'
        ? [{ ...annotation, thread: 'previous-thread', status: 'resolved' }]
        : []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted = true
          if (outcome !== 'failed') annotation.status = 'requested'
          return Response.json({}, { status: 500 })
        }
        if (posted) {
          reconciling = true
          return new Promise<Response>((resolve) => {
            finishRead = resolve
          })
        }
        return Response.json({
          annotations: [...previous, annotation],
          agent: { state: 'manual_required' },
        })
      }),
    )
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
      const executable = document.createElement('script')
      executable.textContent = script
      document.body.appendChild(executable)
      await vi.waitFor(() =>
        expect(document.querySelectorAll('.draft-del')).toHaveLength(1),
      )
      document.querySelector<HTMLButtonElement>('#submitBtn')!.click()
      await vi.waitFor(() => expect(reconciling).toBe(true))
      if (incoming)
        events.dispatchEvent(
          new MessageEvent('annotations', {
            data: JSON.stringify({
              annotations: [{ ...annotation, status: 'resolved' }],
              agent: { state: 'completed' },
            }),
          }),
        )
      finishRead(
        Response.json({
          annotations: [...previous, annotation],
          agent: { state: 'queued' },
        }),
      )
      await vi.waitFor(() =>
        expect(document.querySelector('#operationError')!.textContent).not.toBe(
          '',
        ),
      )
      expect(document.querySelectorAll('.draft-del')).toHaveLength(
        outcome === 'failed' ? 1 : 0,
      )
      if (incoming) {
        expect(
          document.querySelector('.thread')!.classList.contains('resolved'),
        ).toBe(true)
        expect(
          document.querySelector('#batchStatus')!.classList.contains('show'),
        ).toBe(false)
      } else if (outcome === 'requested') {
        expect(
          document.querySelector<HTMLButtonElement>('#submitBtn')!.disabled,
        ).toBe(true)
        expect(document.querySelector('#batchText')!.textContent).toBe(
          PREVIEW_MESSAGES.en['preview.batchQueuedOne'].replace('{n}', '1'),
        )
      }
      expect(document.querySelector('#operationError')!.textContent).toBe(
        PREVIEW_MESSAGES.en[
          outcome === 'failed'
            ? 'preview.operationFailed'
            : 'preview.submitUnconfirmed'
        ],
      )
      expect(document.querySelector('.thread')!.textContent).toContain(
        'Keep this request',
      )
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
