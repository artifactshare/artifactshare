import { injectReadyReporter } from '@artifactshare/viewer-kit/inject'
import { CSP_DIAGNOSTIC_BODIES } from '../services/dev-csp-diagnostic-fixtures'
import { classifyCspViolation } from './csp-violation-classification'
import { isSandboxMessage } from './csp-reporter'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page, server, userEvent } from 'vitest/browser'
import {
  VIOLATION_REPORTER_SCRIPT_BODY,
  VIOLATION_REPORTER_SHA256,
  canUseOsHandler,
} from './csp-reporter'
import { renderMermaidSvg, sanitizeMermaidSvg } from './mermaid-render.client'
import {
  buildPrintDocument,
  resolveExportHtml,
} from '../routes/a.$id/+components/export-actions'

type ReporterMessage = { kind?: string; [key: string]: unknown }

let frame: HTMLIFrameElement | undefined
let messages: ReporterMessage[] = []
let readyEvents: MessageEvent<ReporterMessage>[] = []
let probeSequence = 0

async function waitForMessage(
  kind: string,
  predicate: (message: ReporterMessage) => boolean = () => true,
  fromIndex = 0,
) {
  return vi.waitFor(() => {
    const message = messages
      .slice(fromIndex)
      .find((candidate) => candidate.kind === kind && predicate(candidate))
    expect(message).toBeDefined()
    return message!
  })
}

async function probeReporter(challenge?: string) {
  const probe = challenge ?? `browser-test-probe-${probeSequence++}`
  const firstResponseIndex = messages.length
  for (let attempt = 0; attempt < 3; attempt += 1) {
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'ready-check',
        challenge: probe,
        textAnchorsEnabled: true,
      },
      '*',
    )
    try {
      // Poll only for the reply. Retry only after this attempt times out,
      // never on every assertion poll while a reply is still in flight.
      await vi.waitFor(
        () => {
          expect(
            messages
              .slice(firstResponseIndex)
              .some(
                (message) =>
                  message.kind === 'ready' &&
                  message.challenge === probe &&
                  typeof message.token === 'string',
              ),
          ).toBe(true)
        },
        { timeout: 1000 },
      )
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

async function fixture(
  body = '<a id="normal" href="?artifact-link=1">Normal link</a><a id="target" href="?artifact-link=1">Highlighted text</a>',
  handshake = true,
  documentNavigation = false,
) {
  messages = []
  readyEvents = []
  window.addEventListener('message', onMessage)
  frame?.remove()
  frame = document.createElement('iframe')
  frame.style.cssText = 'width:800px;height:600px;border:0'
  const html = `<!doctype html><body style="margin:40px;background:white"><div id="content">${body}</div><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`
  const objectUrl = documentNavigation
    ? URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    : null
  if (objectUrl) frame.src = objectUrl
  else frame.srcdoc = html
  const loaded = new Promise<void>((resolve) =>
    frame?.addEventListener('load', () => resolve(), { once: true }),
  )
  document.body.appendChild(frame)
  await loaded
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  if (handshake) await probeReporter()
  return frame.contentDocument!
}

function onMessage(event: MessageEvent<ReporterMessage>) {
  if (event.data?.source === 'artifactshare' && event.data.kind === 'ready')
    readyEvents.push(event)
  if (event.source === frame?.contentWindow) messages.push(event.data)
}

async function applyHighlights(highlights: unknown[]) {
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights: highlights.map((h) => ({
        quotedText: 'Highlighted text',
        prefixText: '',
        suffixText: '',
        ...(h as object),
      })),
    },
    '*',
  )
  await probeReporter()
  await vi.waitFor(() =>
    expect(
      frame!.contentDocument!.querySelectorAll('.ash-comment-highlight-badge'),
    ).toHaveLength(highlights.length),
  )
}

function selected() {
  return messages.find((message) => message.kind === 'comment-thread-selected')
}

afterEach(() => {
  window.removeEventListener('message', onMessage)
  frame?.remove()
  frame = undefined
})

// Only the frame clock is scripted; parent polling and browser timers stay real.
function frameClock() {
  const date = (frame!.contentWindow as Window & typeof globalThis).Date
  const original = date.now
  let read = () => 10000
  date.now = () => read()
  return {
    set(next: () => number) {
      read = next
    },
    restore() {
      date.now = original
    },
  }
}

function positionState(message: ReporterMessage, thread: string) {
  if (message.kind === 'anchor-verdicts')
    return (
      message.verdicts as { thread: string; position_state: string }[]
    ).find((entry) => entry.thread === thread)?.position_state
  if (message.kind === 'anchor-resolutions')
    return (message.results as { threadId: string; state: string }[]).find(
      (entry) => entry.threadId === thread,
    )?.state
}

function postMissing(stream: 'highlight' | 'verification', versionId = 'v1') {
  frame!.contentWindow!.postMessage(
    stream === 'highlight'
      ? {
          source: 'artifactshare-parent',
          kind: 'comment-highlights',
          versionId,
          highlights: [{ threadId: 'hosted', quotedText: 'Missing quote' }],
        }
      : {
          source: 'artifactshare-parent',
          kind: 'verify-anchors',
          anchors: [
            { kind: 'text', thread: 'preview', quotedText: 'Missing quote' },
          ],
        },
    '*',
  )
}

test.each([
  ['highlight', true],
  ['verification', true],
  ['highlight', false],
  ['verification', false],
] as const)(
  '%s checking survives a clock crossing inside a report pass (crossing: %s)',
  async (stream, crossing) => {
    await fixture('<p>Present quote</p>')
    const clock = frameClock()
    const kind =
      stream === 'highlight' ? 'anchor-resolutions' : 'anchor-verdicts'
    const thread = stream === 'highlight' ? 'hosted' : 'preview'
    try {
      postMissing(stream)
      await waitForMessage(kind, (m) => positionState(m, thread) === 'checking')
      const from = messages.length
      const reads: number[] = []
      clock.set(() => {
        const value = crossing && reads.length ? 13000 : 12999
        reads.push(value)
        return value
      })
      // A changed version also makes the highlight report observable despite
      // signature suppression of identical checking results.
      postMissing(stream, 'v2')
      await waitForMessage(kind, (m) => !!positionState(m, thread), from)
      expect(reads[0]).toBe(12999)
      if (crossing) expect(reads).toContain(13000)
      else {
        expect(reads.every((value) => value === 12999)).toBe(true)
        expect(
          messages
            .slice(from)
            .some((m) => positionState(m, thread) === 'needs-check'),
        ).toBe(false)
      }
      clock.set(() => 18000)
      await waitForMessage(
        kind,
        (m) => positionState(m, thread) === 'needs-check',
        from,
      )
    } finally {
      clock.restore()
    }
  },
)

test('both streams finish when the clock crosses in the shared checking callback', async () => {
  await fixture('<p>Present quote</p>')
  const clock = frameClock()
  try {
    postMissing('highlight')
    postMissing('verification')
    await waitForMessage(
      'anchor-resolutions',
      (m) => positionState(m, 'hosted') === 'checking',
    )
    await waitForMessage(
      'anchor-verdicts',
      (m) => positionState(m, 'preview') === 'checking',
    )
    const from = messages.length
    const reads: number[] = []
    clock.set(() => {
      const value = reads.length ? 13000 : 12999
      reads.push(value)
      return value
    })
    // No parent message or DOM mutation: the original 3000 ms timer runs
    // highlights first (unchanged checking signature), then verification.
    await vi.waitFor(
      () => {
        for (const thread of ['hosted', 'preview'])
          expect(
            messages
              .slice(from)
              .some((m) => positionState(m, thread) === 'needs-check'),
          ).toBe(true)
      },
      { timeout: 4500 },
    )
    expect(reads[0]).toBe(12999)
    expect(reads).toContain(13000)
  } finally {
    clock.restore()
  }
})

describe('CSP reporter runtime behavior', () => {
  test('buffers violations before ready-check and delivers them exactly once after it', async () => {
    const doc = await fixture('<p>Early violation</p>', false)
    doc.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'script-src',
        blockedURI: 'eval',
        sourceFile: 'https://sandbox.example.com/artifact.html',
        lineNumber: 7,
        sample: 'early diagnostic',
        disposition: 'enforce',
      }),
    )
    // A message from the same frame drains any report already posted by the
    // synchronous listener without sending the ready-check that flushes it.
    const marker = doc.createElement('script')
    marker.textContent = `parent.postMessage({ kind: 'violation-dispatched' }, '*')`
    doc.body.appendChild(marker)
    await waitForMessage('violation-dispatched')
    expect(
      messages.filter((message) => message.kind === 'csp-violation'),
    ).toEqual([])

    await probeReporter('first-ready-check')
    expect(await waitForMessage('csp-violation')).toMatchObject({
      directive: 'script-src',
      blockedURI: 'eval',
      sourceFile: 'https://sandbox.example.com/artifact.html',
      lineNumber: 7,
      sample: 'early diagnostic',
      disposition: 'enforce',
    })
    await probeReporter('second-ready-check')
    expect(
      messages.filter((message) => message.kind === 'csp-violation'),
    ).toHaveLength(1)
  })

  test('readiness replies identify the artifact frame as their sender', async () => {
    await fixture('<p>Frame identity</p>')
    const challenge = 'frame-identity-probe'
    await probeReporter(challenge)
    const reply = readyEvents.find(
      (event) => event.data.challenge === challenge,
    )!
    expect(reply).toBeDefined()
    expect(reply.source).toBe(frame!.contentWindow)
    expect(reply.data.token).toMatch(/^[a-f0-9]{64}$/)
  })

  test('captured primordials survive authored replacements without accepting forged clicks or polluting messages', async () => {
    const doc = await fixture(
      '<a href="https://example.com/report" id="safe">Protected link</a>',
    )
    const before = messages.find((message) => message.kind === 'ready')!
    const authored = doc.createElement('script')
    authored.textContent = `
      const define = Object.defineProperty;
      window.reporterAttack = { payloadReads: 0, redirected: 0 };
      const attacked = window.reporterAttack;
      define(Object.prototype, 'token', { configurable: true, set() { attacked.payloadReads++; } });
      define(Object.prototype, 'source', { configurable: true, set() { attacked.payloadReads++; } });
      define(window, 'parent', { configurable: true, value: { postMessage() { attacked.redirected++; } } });
      const unavailable = () => { throw new Error('authored replacement'); };
      Array.prototype.map = unavailable;
      WeakMap.prototype.get = unavailable;
      WeakMap.prototype.set = unavailable;
      WeakMap.prototype.delete = unavailable;
      Element.prototype.closest = () => null;
      Element.prototype.getAttribute = () => null;
      Element.prototype.hasAttribute = () => false;
      define(Event.prototype, 'target', { configurable: true, get() { return document.body; } });
      define(Event.prototype, 'defaultPrevented', { configurable: true, get() { return true; } });
      for (const key of ['button', 'metaKey', 'ctrlKey', 'shiftKey', 'altKey'])
        define(MouseEvent.prototype, key, { configurable: true, get() { return key === 'button' ? 2 : true; } });
      Object.create = unavailable;
      Object.keys = unavailable;
      Object.defineProperty = unavailable;
    `
    doc.body.appendChild(authored)
    await probeReporter('after-authored-replacement')
    const reply = messages.find(
      (message) => message.challenge === 'after-authored-replacement',
    )!
    expect(reply.token).toBe(before.token)
    expect(reply.source).toBe('artifactshare')
    const from = messages.length
    const link = doc.querySelector<HTMLAnchorElement>('#safe')!
    const forged = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      button: 0,
    })
    // Cancel the synthetic event in authored code to keep its native default
    // action from navigating away; it still traverses the reporter capture listener.
    link.addEventListener('click', (event) => {
      if (!event.isTrusted) event.preventDefault()
    })
    link.dispatchEvent(forged)
    await probeReporter('after-forged-click')
    expect(
      messages.slice(from).some((message) => message.kind === 'link-clicked'),
    ).toBe(false)
    const box = link.getBoundingClientRect()
    await page.elementLocator(frame!).click({
      position: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    })
    const clicked = await waitForMessage('link-clicked', () => true, from)
    expect(clicked.href).toBe('https://example.com/report')
    expect(clicked.token).toBe(before.token)
    expect(
      (
        doc.defaultView as unknown as Window & {
          reporterAttack: { payloadReads: number; redirected: number }
        }
      ).reporterAttack,
    ).toEqual({ payloadReads: 0, redirected: 0 })
  })

  test('highlight serialization and mutation retries never disclose the document token', async () => {
    const doc = await fixture()
    const before = messages.find((message) => message.kind === 'ready')!
    const authored = doc.createElement('script')
    authored.textContent = `
      const stringify = JSON.stringify;
      const toString = String;
      window.serializationAttack = { seen: [], jsonCalls: 0, stringCalls: 0 };
      const attack = window.serializationAttack;
      JSON.stringify = function(value, ...args) {
        attack.jsonCalls++;
        const serialized = stringify(value, ...args);
        attack.seen.push(serialized);
        return serialized;
      };
      for (const name of ['charAt', 'slice', 'substring', 'replace', 'trim', 'startsWith', 'padStart']) {
        const original = String.prototype[name];
        String.prototype[name] = function(...args) {
          attack.stringCalls++;
          attack.seen.push(toString(this));
          return original.apply(this, args);
        };
      }
    `
    doc.body.appendChild(authored)
    await applyHighlights([{ threadId: 'serialization-thread', colorIndex: 0 }])
    const first = await waitForMessage('anchor-resolutions')
    const attack = (
      doc.defaultView as unknown as {
        serializationAttack: {
          seen: string[]
          jsonCalls: number
          stringCalls: number
        }
      }
    ).serializationAttack
    const calls = attack.jsonCalls
    // Change normalized text so the observer's debounce must resolve again.
    const content = doc.querySelector('#content')!
    content.insertBefore(
      doc.createTextNode('Added prefix. '),
      content.firstChild,
    )
    const updated = await waitForMessage(
      'anchor-resolutions',
      (message) =>
        (message.generation as number) > (first.generation as number),
    )
    expect(updated.token).toBe(before.token)
    expect(attack.jsonCalls).toBeGreaterThan(calls)
    expect(attack.stringCalls).toBeGreaterThan(0)
    expect(
      attack.seen.some((value) => value?.includes(before.token as string)),
    ).toBe(false)

    const forge = doc.createElement('script')
    forge.textContent = `
      const candidates = window.serializationAttack.seen.join(' ').match(/[a-f0-9]{64}/g) || [''];
      for (const token of candidates) parent.postMessage({
        source: 'artifactshare', kind: 'link-clicked',
        href: 'https://example.com/forged', token
      }, '*');
    `
    const from = messages.length
    doc.body.appendChild(forge)
    await waitForMessage(
      'link-clicked',
      (message) => message.href === 'https://example.com/forged',
      from,
    )
    await probeReporter('after-serialization-attack')
    const forged = messages
      .slice(from)
      .filter((message) => message.kind === 'link-clicked')
    expect(forged.length).toBeGreaterThan(0)
    for (const message of forged)
      expect(canUseOsHandler(before.token as string, message.token, true)).toBe(
        false,
      )

    const box = doc.querySelector('#normal')!.getBoundingClientRect()
    const clickFrom = messages.length
    await page.elementLocator(frame!).click({
      position: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    })
    const clicked = await waitForMessage('link-clicked', () => true, clickFrom)
    expect(canUseOsHandler(before.token as string, clicked.token, true)).toBe(
      true,
    )
  })

  test('strict reporter callers never expose state to authored classic functions', async () => {
    const doc = await fixture(
      '<a href="https://example.com/report" id="safe">Protected link</a><p id="words">Select these words</p>',
    )
    const before = messages.find((message) => message.kind === 'ready')!
    const authored = doc.createElement('script')
    authored.textContent = `
      window.callerAttack = { linkCalls: 0, selectionCalls: 0, callers: 0, token: null, challenge: null };
      const attack = window.callerAttack;
      const originalCharAt = String.prototype.charAt;
      const originalRect = Range.prototype.getBoundingClientRect;
      function inspectCaller(caller) {
        if (!caller) return;
        attack.callers++;
        const args = caller.arguments;
        const ctx = args && args[0];
        if (ctx) {
          attack.token = ctx.documentToken || null;
          attack.challenge = ctx.readyChallenge || null;
        }
      }
      String.prototype.charAt = function charAt(index) {
        attack.linkCalls++;
        inspectCaller(charAt.caller);
        return originalCharAt.call(this, index);
      };
      Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
        attack.selectionCalls++;
        inspectCaller(getBoundingClientRect.caller);
        return originalRect.call(this);
      };
    `
    doc.body.appendChild(authored)
    const from = messages.length
    const box = doc.querySelector('#safe')!.getBoundingClientRect()
    await page.elementLocator(frame!).click({
      position: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    })
    expect(
      await waitForMessage('link-clicked', () => true, from),
    ).toMatchObject({
      href: 'https://example.com/report',
      token: before.token,
    })
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('#words')!)
    const selection = doc.defaultView!.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    doc.dispatchEvent(new Event('keyup', { bubbles: true }))
    expect(
      await waitForMessage('text-selection', () => true, from),
    ).toMatchObject({
      quotedText: 'Select these words',
      token: before.token,
    })
    const attack = (
      doc.defaultView as unknown as {
        callerAttack: {
          linkCalls: number
          selectionCalls: number
          callers: number
          token: unknown
          challenge: unknown
        }
      }
    ).callerAttack
    expect(attack.linkCalls).toBeGreaterThan(0)
    expect(attack.selectionCalls).toBeGreaterThan(0)
    expect(attack.callers).toBe(0)
    expect(attack.token).toBeNull()
    expect(attack.challenge).toBeNull()
  })

  test('authored array iterators cannot read private messages or change their fields', async () => {
    const doc = await fixture(
      '<a href="https://example.com/report" id="safe">Protected link</a><p id="words">Select these words</p>',
    )
    const before = messages.find((message) => message.kind === 'ready')!
    const authored = doc.createElement('script')
    authored.textContent = `
      const originalIterator = Array.prototype[Symbol.iterator];
      const owns = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
      window.iteratorAttack = { messageReads: 0, token: null, challenge: null };
      Object.defineProperty(Object.prototype, '__reporter_probe__', {
        configurable: true,
        get() {
          if (owns(this, 'kind')) {
            window.iteratorAttack.messageReads++;
            window.iteratorAttack.token = this.token;
            window.iteratorAttack.challenge = this.challenge;
          }
          return 'polluted';
        }
      });
      Array.prototype[Symbol.iterator] = function* () {
        // Only key arrays are changed; ordinary anchor/layout arrays still work.
        for (let index = 0; index < this.length; index++) {
          if (this[index] === 'kind') { yield '__reporter_probe__'; break; }
        }
        const iterator = originalIterator.call(this);
        let step;
        while (!(step = iterator.next()).done) yield step.value;
      };
    `
    doc.body.appendChild(authored)
    await probeReporter('iterator-attack-probe')
    const reply = await waitForMessage(
      'ready',
      (message) => message.challenge === 'iterator-attack-probe',
    )
    expect(reply).toEqual({
      source: 'artifactshare',
      kind: 'ready',
      challenge: 'iterator-attack-probe',
      token: before.token,
    })

    const from = messages.length
    const link = doc.querySelector<HTMLAnchorElement>('#safe')!
    link.addEventListener('click', (event) => {
      if (!event.isTrusted) event.preventDefault()
    })
    link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await probeReporter('iterator-forged-click')
    expect(
      messages.slice(from).some((message) => message.kind === 'link-clicked'),
    ).toBe(false)
    const box = link.getBoundingClientRect()
    await page.elementLocator(frame!).click({
      position: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    })
    expect(await waitForMessage('link-clicked', () => true, from)).toEqual({
      source: 'artifactshare',
      kind: 'link-clicked',
      href: 'https://example.com/report',
      token: before.token,
    })

    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('#words')!)
    const selection = doc.defaultView!.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const selectionFrom = messages.length
    doc.dispatchEvent(new Event('keyup', { bubbles: true }))
    const selectionMessage = await waitForMessage(
      'text-selection',
      () => true,
      selectionFrom,
    )
    expect(Object.keys(selectionMessage).sort()).toEqual(
      [
        'source',
        'kind',
        'token',
        'quotedText',
        'prefixText',
        'suffixText',
        'textStart',
        'textEnd',
        'selectorFormat',
        'textHash',
        'ambiguousAtCreation',
        'versionId',
        'cssPath',
        'rect',
      ].sort(),
    )
    expect(selectionMessage.token).toBe(before.token)
    expect(selectionMessage.quotedText).toBe('Select these words')
    expect(selectionMessage.rect).toEqual({
      top: expect.any(Number),
      left: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })

    const violation = new Event('securitypolicyviolation')
    Object.assign(violation, {
      violatedDirective: 'img-src',
      blockedURI: 'https://example.org/image.png',
    })
    doc.dispatchEvent(violation)
    expect(await waitForMessage('csp-violation')).toEqual({
      source: 'artifactshare',
      kind: 'csp-violation',
      directive: 'img-src',
      blockedURI: 'https://example.org/image.png',
      sourceFile: null,
      lineNumber: null,
    })
    expect(
      (
        doc.defaultView as unknown as {
          iteratorAttack: {
            messageReads: number
            token: unknown
            challenge: unknown
          }
        }
      ).iteratorAttack,
    ).toEqual({ messageReads: 0, token: null, challenge: null })
  })

  test('waits for an in-flight probe reply without sending duplicate checks', async () => {
    const doc = await fixture(`<script>
      let delayed = false;
      let checks = 0;
      window.addEventListener('message', function delayProbe(event) {
        if (event.data?.kind !== 'ready-check') return;
        if (delayed) { delayed = false; return; }
        document.body.dataset.probeCount = String(++checks);
        event.stopImmediatePropagation();
        setTimeout(() => {
          delayed = true;
          window.dispatchEvent(new MessageEvent('message', {
            data: event.data, source: event.source, origin: event.origin
          }));
        }, 150);
      }, true);
    </script><p>Delayed reply</p>`)
    expect(doc.body.dataset.probeCount).toBe('1')
  })

  test('copies a rendered code block without selecting it for comments', async () => {
    const doc = await fixture(
      '<figure class="md-code-block"><button data-code-copy>Copy</button><pre><code>const answer = 42</code></pre></figure>',
    )
    await applyHighlights([])
    let copied = ''
    Object.defineProperty(doc.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied = value
          return Promise.resolve()
        },
      },
    })
    const button = doc.querySelector<HTMLButtonElement>('[data-code-copy]')!
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    button.click()
    await vi.waitFor(() => expect(copied).toBe('const answer = 42'))
    await probeReporter()

    expect(copied).toBe('const answer = 42')
    expect(button.textContent).toBe('Copied')
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)
  })

  test('marks matching desktop and mobile table-of-contents links as current', async () => {
    const doc = await fixture(
      '<nav class="md-toc"><a href="#intro">Intro</a></nav><details><nav class="md-toc"><a href="#intro">Intro</a></nav></details><h2 id="intro">Intro</h2>',
    )
    doc.defaultView!.dispatchEvent(new Event('scroll'))

    expect(
      doc.querySelectorAll('.md-toc a[aria-current="location"]'),
    ).toHaveLength(2)
  })

  test('sanitizes Mermaid SVG before it reaches the artifact frame', () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>Safe</text><script>alert(1)</script></svg>',
    )

    expect(sanitized).toContain('<svg')
    expect(sanitized).toContain('<text>Safe</text>')
    expect(sanitized).not.toContain('onload')
    expect(sanitized).not.toContain('<script')
  })

  test('renders Mermaid only after the parent ready check and preserves source text', async () => {
    const source = 'flowchart LR\nA --> B'
    const doc = await fixture(
      `<pre><code class="language-mermaid">${source}</code></pre>`,
    )
    doc.body.setAttribute('data-artifact-markdown', '')
    messages = []

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'ready-check',
        challenge: 'browser-test',
      },
      '*',
    )
    const request = (await waitForMessage('mermaid-render-request')) as
      | {
          renderToken?: string
          diagrams?: Array<{ id: string; source: string }>
        }
      | undefined
    expect(request?.renderToken).toBe('browser-test')
    expect(request?.diagrams).toEqual([
      { id: 'artifactshare-mermaid-0', source },
    ])

    const svg = await renderMermaidSvg(source)
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'mermaid-rendered',
        renderToken: 'previous-document',
        results: [{ id: request!.diagrams![0].id, svg }],
      },
      '*',
    )
    await probeReporter(request!.renderToken)
    expect(doc.querySelector('.mermaid-diagram')).toBeNull()

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'mermaid-rendered',
        renderToken: request!.renderToken,
        results: [{ id: request!.diagrams![0].id, svg }],
      },
      '*',
    )
    await vi.waitFor(() =>
      expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull(),
    )

    expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(doc.querySelector('pre')?.hidden).toBe(true)
    expect(doc.querySelector('pre')?.textContent).toBe(source)

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'comment-highlights',
        highlights: [
          {
            threadId: 'mermaid-source',
            quotedText: source,
            prefixText: '',
            suffixText: '',
          },
        ],
      },
      '*',
    )
    const resolution = await waitForMessage('anchor-resolutions')
    expect(resolution.results).toEqual([
      expect.objectContaining({
        threadId: 'mermaid-source',
        state: 'attached',
      }),
    ])
    expect(doc.querySelector('mark')).toBeNull()
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    expect(badge).not.toBeNull()
    expect(badge.style.display).toBe('none')
    const registry = (
      doc.defaultView as unknown as {
        CSS: { highlights: Map<string, Set<Range>> }
      }
    ).CSS.highlights
    const ranges = [...registry.values()].flatMap((highlight) => [...highlight])
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer).toBe(
      doc.querySelector('pre code')!.firstChild,
    )
    expect(ranges[0].endContainer).toBe(ranges[0].startContainer)
    expect(ranges[0].startOffset).toBe(0)
    expect(ranges[0].endOffset).toBe(source.length)
    expect([...ranges[0].getClientRects()].some((rect) => rect.width > 0)).toBe(
      false,
    )
  })

  test('uses the same Mermaid rendering for HTML and print exports', async () => {
    const source = 'flowchart LR\nA --> B'
    const data = {
      kind: 'markdown' as const,
      artifactKind: 'markdown_page',
      path: '/index.md',
      versionId: 'version-1',
      source: `\`\`\`mermaid\n${source}\n\`\`\``,
      fileName: 'diagram.md',
      renderedHtml: `<html><body data-artifact-markdown><article data-comment-content><pre><code class="language-mermaid">${source}</code></pre></article></body></html>`,
    }

    const html = await resolveExportHtml('artifact-1', data)
    expect(html).toContain('class="mermaid-diagram"')
    expect(html).toContain('<svg')
    expect(html).toContain('data-mermaid-rendered="true" hidden')

    const print = await buildPrintDocument('artifact-1', data, {
      savePdf: 'Save PDF',
      backgroundHint: 'Print backgrounds',
      preparing: 'Preparing',
      heightLimited: 'Height limited',
    })
    expect(print.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(print.querySelector('pre')?.hidden).toBe(true)
  })

  test('keyboard link activation and script clicks ignore highlight geometry at the origin', async () => {
    const doc = await fixture(
      '<p style="position:fixed;left:0;top:0;margin:0">Highlighted text</p><a id="link" href="https://example.com/keyboard-target">Go</a><form><button id="submit">Submit</button></form>',
    )
    await applyHighlights([{ threadId: 'thread-1' }])
    // Make the source range cover (0,0), including browsers with font ascenders.
    const rangePrototype = Object.getPrototypeOf(doc.createRange())
    const getRects = rangePrototype.getClientRects
    rangePrototype.getClientRects = () => [
      { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 },
    ]
    try {
      let submitted = false
      doc.querySelector('form')!.addEventListener('submit', (event) => {
        event.preventDefault()
        submitted = true
      })
      // Establish browser focus inside the iframe before sending real keys.
      // Programmatic element focus alone can leave Firefox's keyboard input
      // directed at the enclosing tester frame.
      const reporter = page.frameLocator(page.elementLocator(frame!))
      await reporter.getByRole('button', { name: 'Submit' }).click()
      submitted = false
      doc.querySelector<HTMLButtonElement>('#submit')!.click()
      expect(submitted).toBe(true)
      const link = doc.querySelector<HTMLAnchorElement>('#link')!
      link.focus()
      expect(doc.activeElement).toBe(link)
      expect(document.activeElement).toBe(frame)
      await userEvent.keyboard('{Enter}')
      // A srcdoc fragment link inherits the runner URL and would load a second
      // Vitest tester. Exercise the normal parent-link gate without navigation.
      await waitForMessage(
        'link-clicked',
        (message) => message.href === 'https://example.com/keyboard-target',
      )
      expect(frame!.contentDocument).toBe(doc)
      await probeReporter()
      expect(selected()).toBeUndefined()
    } finally {
      rangePrototype.getClientRects = getRects
    }
  })

  test('same-offset updates move paint and jump targets after exclusions change', async () => {
    const doc = await fixture(
      '<main data-comment-content><p id="a">quote</p><p id="b" data-anchor-ignore>quote</p></main>',
    )
    const highlight = { threadId: 'quote', quotedText: 'quote', count: 1 }
    await applyHighlights([highlight])
    const registry = (
      doc.defaultView as unknown as {
        CSS: { highlights: Map<string, Set<Range>> }
      }
    ).CSS.highlights
    const ranges = () => [...registry.values()].flatMap((paint) => [...paint])
    const a = doc.querySelector<HTMLElement>('#a')!
    const b = doc.querySelector<HTMLElement>('#b')!
    expect(ranges()[0].startContainer).toBe(a.firstChild)
    a.setAttribute('data-anchor-ignore', '')
    b.removeAttribute('data-anchor-ignore')
    await applyHighlights([{ ...highlight, count: 2 }])
    expect(ranges()).toHaveLength(1)
    expect(ranges()[0].startContainer).toBe(b.firstChild)
    expect(ranges()[0].endContainer).toBe(b.firstChild)
    expect(ranges().some((range) => a.contains(range.startContainer))).toBe(
      false,
    )
    const jumpA = vi.spyOn(a, 'scrollIntoView')
    const jumpB = vi.spyOn(b, 'scrollIntoView')
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'scroll-to-comment',
        threadId: 'quote',
      },
      '*',
    )
    await probeReporter()
    expect(jumpB).toHaveBeenCalledOnce()
    expect(jumpA).not.toHaveBeenCalled()
  })

  test.each(['badge', 'overlay'])(
    'unchanged updates restore a removed %s',
    async (removed) => {
      const doc = await fixture(
        '<svg width="400" height="100"><text x="10" y="40">Highlighted text</text></svg>',
      )
      const highlights = [{ threadId: 'svg' }]
      await applyHighlights(highlights)
      const selector =
        removed === 'badge'
          ? '.ash-comment-highlight-badge'
          : '.ash-comment-highlight-svg'
      const original = doc.querySelector(selector)!
      expect(original).not.toBeNull()
      original.remove()
      await applyHighlights(highlights)
      const restored = doc.querySelector(selector)
      expect(restored).not.toBeNull()
      expect(restored!.isConnected).toBe(true)
      expect(
        doc.querySelector('.ash-comment-highlight-svg')!.getBoundingClientRect()
          .width,
      ).toBeGreaterThan(0)
    },
  )

  test('a focused badge survives live counter changes and equal-value node replacement', async () => {
    const doc = await fixture(
      '<p id="target">Highlighted text</p><p id="counter">0</p>',
    )
    await applyHighlights([{ threadId: 'thread-1' }])
    const badge = doc.querySelector<HTMLButtonElement>(
      '.ash-comment-highlight-badge',
    )!
    badge.focus()
    doc.querySelector('#counter')!.textContent = '1'
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(doc.activeElement).toBe(badge)
    doc.querySelector('#target')!.textContent = 'Highlighted text'
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(doc.activeElement).toBe(badge)
  })

  test('reattachment renews the checking grace for hosted and preview anchors', async () => {
    const doc = await fixture('<p id="target">Missing</p>')
    const post = (kind: string, data: object) =>
      frame!.contentWindow!.postMessage(
        { source: 'artifactshare-parent', kind, ...data },
        '*',
      )
    post('comment-highlights', {
      textAnchorsEnabled: true,
      highlights: [
        {
          threadId: 'hosted',
          quotedText: 'Highlighted text',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    post('verify-anchors', {
      anchors: [
        {
          kind: 'text',
          thread: 'preview',
          quotedText: 'Highlighted text',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    const hasState = (kind: string, state: string, from = 0) =>
      vi.waitFor(
        () => {
          expect(
            messages
              .slice(from)
              .some(
                (message) =>
                  message.kind === kind &&
                  JSON.stringify(message).includes('"' + state + '"'),
              ),
          ).toBe(true)
        },
        { timeout: 4200 },
      )
    await hasState('anchor-resolutions', 'needs-check')
    await hasState('anchor-verdicts', 'needs-check')
    let from = messages.length
    doc.querySelector('#target')!.textContent = 'Highlighted text'
    await hasState('anchor-resolutions', 'attached', from)
    await hasState('anchor-verdicts', 'attached', from)
    from = messages.length
    doc.querySelector('#target')!.textContent = 'Missing again'
    await hasState('anchor-resolutions', 'checking', from)
    await hasState('anchor-verdicts', 'checking', from)
    await hasState('anchor-resolutions', 'needs-check', from)
    await hasState('anchor-verdicts', 'needs-check', from)
  }, 12000)

  test('keyboard operation on a comment badge sends selection to the parent', async () => {
    const doc = await fixture(
      '<button id=before>Before comments</button><p>Highlighted text</p>',
    )
    await applyHighlights([
      { threadId: 'thread-1', textStart: 0, textEnd: 16, count: 1 },
    ])
    const badge = doc.querySelector<HTMLButtonElement>(
      '.ash-comment-highlight-badge',
    )!
    // Start before the badge in the frame's sequential focus order.
    // WebKit on macOS does not focus buttons on mouse click.
    const before = doc.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    expect(doc.activeElement).toBe(before)
    // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
    if (server.browser === 'webkit' && server.platform === 'darwin') {
      await userEvent.keyboard('{Alt>}{Tab}{/Alt}')
    } else {
      await userEvent.tab()
    }
    expect(doc.activeElement).toBe(badge)
    messages = []
    await userEvent.keyboard('{Enter}')
    await waitForMessage(
      'comment-thread-selected',
      (message) => message.threadId === 'thread-1',
    )
    expect(selected()?.threadId).toBe('thread-1')
  })

  test('highlight and badge clicks are excluded while a normal link click is reported', async () => {
    const doc = await fixture()
    await applyHighlights([
      { threadId: 'thread-2', textStart: 11, textEnd: 27, count: 1 },
    ])
    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('Highlighted text', { exact: true }).click()
    await reporter.getByLabelText('Open 1 unresolved comment on').click()
    expect(
      messages.filter((message) => message.kind === 'link-clicked'),
    ).toHaveLength(0)
    await reporter.getByText('Normal link', { exact: true }).click()
    await waitForMessage('link-clicked')
    expect(
      messages.filter((message) => message.kind === 'link-clicked'),
    ).toHaveLength(1)
  })

  test('routes external links through the parent until direct mode arrives', async () => {
    const doc = await fixture(
      '<a id="first" href="https://first.example/">First external</a><a id="second" href="https://second.example/">Second external</a><a id="third" href="https://third.example/">Third external</a><iframe id="attacker"></iframe>',
    )
    const opened: string[] = []
    Object.defineProperty(doc.defaultView!, 'open', {
      configurable: true,
      value: (href: string) => {
        opened.push(href)
        return null
      },
    })

    const attacker = doc.querySelector<HTMLIFrameElement>('#attacker')!
    const attackerScript = attacker.contentDocument!.createElement('script')
    attackerScript.textContent = `parent.postMessage(${JSON.stringify({
      source: 'artifactshare-parent',
      kind: 'external-link-policy',
      mode: 'direct',
    })}, '*')`
    attacker.contentDocument!.body.appendChild(attackerScript)
    await probeReporter()

    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('First external', { exact: true }).click()
    const first = await waitForMessage('link-clicked')
    expect(first.href).toBe('https://first.example/')
    expect(opened).toEqual([])

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'external-link-policy',
        mode: 'direct',
      },
      '*',
    )
    await probeReporter()
    await reporter.getByText('Second external', { exact: true }).click()
    expect(opened).toEqual(['https://second.example/'])

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'external-link-policy',
        mode: 'parent',
      },
      '*',
    )
    await probeReporter()
    await reporter.getByText('Third external', { exact: true }).click()
    await expect
      .poll(() => messages.filter((message) => message.kind === 'link-clicked'))
      .toHaveLength(2)
    expect(opened).toEqual(['https://second.example/'])
  })

  test('highlight and badge pointerdown are excluded while outside pointerdown is reported', async () => {
    await fixture()
    await applyHighlights([
      { threadId: 'thread-3', textStart: 11, textEnd: 27, count: 1 },
    ])
    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('Highlighted text', { exact: true }).click()
    await reporter.getByLabelText('Open 1 unresolved comment on').click()
    await probeReporter()
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)

    await reporter.getByText('Normal link', { exact: true }).click()
    await waitForMessage('comment-outside-pointer-down')
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(1)
  })

  test('highlight palette follows a light or dark background', async () => {
    const light = await fixture('<p id="text">Highlighted text</p>')
    await applyHighlights([
      { threadId: 'light', textStart: 0, textEnd: 16, count: 1 },
    ])
    const lightStyle = light.querySelector(
      '#ash-comment-highlight-style',
    )!.textContent!
    const dark = await fixture(
      '<p id="text" style="background:rgb(0,0,0)">Highlighted text</p>',
    )
    await applyHighlights([
      { threadId: 'dark', textStart: 0, textEnd: 16, count: 1 },
    ])
    const darkStyle = dark.querySelector(
      '#ash-comment-highlight-style',
    )!.textContent!
    expect(lightStyle).not.toBe(darkStyle)
    expect(lightStyle.replaceAll(' ', '')).toContain(
      'background-color:rgba(37,99,235,.16)',
    )
    expect(darkStyle.replaceAll(' ', '')).toContain(
      'background-color:rgba(96,165,250,.16)',
    )
  })

  test('badge position is updated from the highlight client rect', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'position', textStart: 0, textEnd: 16, count: 1 },
    ])
    const mark = doc.createRange()
    mark.selectNodeContents(doc.querySelector('p')!)
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    expect(badge.style.left).not.toBe('0px')
    expect(badge.style.top).not.toBe('0px')
    const markRect = mark.getBoundingClientRect()
    const badgeRect = badge.getBoundingClientRect()
    expect(Math.abs(badgeRect.left - (markRect.right - 6))).toBeLessThan(2)
    expect(badgeRect.bottom).toBeLessThan(markRect.top + 4)
  })

  test.each([
    { visibility: 'hidden', display: 'inline' },
    { visibility: 'collapse', display: 'inline' },
    { visibility: 'hidden', display: 'contents' },
    { visibility: 'collapse', display: 'contents' },
  ])(
    'badge follows ancestor visibility:$visibility with display:$display without rebuilding anchors',
    async ({ visibility, display }) => {
      const doc = await fixture(
        `<style>.concealed { visibility: ${visibility}; }</style><section><p><span style="display:${display}"><span style="display:${display}">Highlighted text</span></span></p></section>`,
      )
      await applyHighlights([{ threadId: 'visibility', count: 1 }])
      const ancestor = doc.querySelector('section')!
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const registry = (
        doc.defaultView as unknown as {
          CSS: { highlights: Map<string, Set<Range>> }
        }
      ).CSS.highlights
      const originalHighlights = [...registry.values()]
      expect(originalHighlights).toHaveLength(1)
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      const messageCount = messages.filter(
        (message) => message.kind === 'anchor-resolutions',
      ).length

      ancestor.classList.add('concealed')
      await vi.waitFor(() => expect(badge.style.display).toBe('none'))
      expect([...registry.values()][0]).toBe(originalHighlights[0])

      // Re-resolution must reuse the badge and still refresh its geometry.
      await applyHighlights([{ threadId: 'visibility', count: 1 }])
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect(badge.style.display).toBe('none')
      const refreshedHighlight = [...registry.values()][0]

      ancestor.classList.remove('concealed')
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect([...registry.values()][0]).toBe(refreshedHighlight)
      expect(
        messages.filter((message) => message.kind === 'anchor-resolutions'),
      ).toHaveLength(messageCount)

      const range = [...refreshedHighlight][0]
      const rect = range.getBoundingClientRect()
      expect(rect.width).toBeGreaterThan(0)
      range.startContainer.parentElement!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
      await probeReporter()
      expect(selected()).toBeUndefined()
      // Only trusted pointer input may select text highlights. Keep the
      // synthetic click above as a negative control even with detail > 0.
      const reporter = page.frameLocator(page.elementLocator(frame!))
      // display:contents spans have no actionable box. The paragraph owns
      // the text's layout box; clicking it still exercises range hit testing.
      const paragraphRect = doc.querySelector('p')!.getBoundingClientRect()
      await reporter.getByRole('paragraph').click({
        position: {
          x: rect.left + rect.width / 2 - paragraphRect.left,
          y: rect.top + rect.height / 2 - paragraphRect.top,
        },
      })
      await waitForMessage(
        'comment-thread-selected',
        (message) => message.threadId === 'visibility',
      )
      messages = []
      await reporter.getByRole('button').click()
      await waitForMessage(
        'comment-thread-selected',
        (message) => message.threadId === 'visibility',
      )
    },
  )

  test.each(['html', 'svg'])(
    '%s badge follows the last range visibility and reappears without rebuilding anchors',
    async (kind) => {
      const content =
        kind === 'svg'
          ? '<svg width="400" height="100"><text x="10" y="40"><tspan id="first">Highlighted </tspan><tspan id="last">text</tspan></text></svg>'
          : '<p><span id="first">Highlighted </span><span id="last">text</span></p>'
      const doc = await fixture(content)
      await applyHighlights([{ threadId: 'last-range', count: 1 }])
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const first = doc.getElementById('first')!
      const last = doc.getElementById('last')!
      const overlays = Array.from(
        doc.querySelectorAll<SVGElement>('.ash-comment-highlight-svg'),
      )
      if (kind === 'svg') expect(overlays).toHaveLength(2)
      const expectOverlayVisibility = (
        firstVisible: boolean,
        lastVisible: boolean,
      ) => {
        if (kind !== 'svg') return
        expect(doc.defaultView!.getComputedStyle(overlays[0]).display).toBe(
          firstVisible ? 'inline' : 'none',
        )
        expect(doc.defaultView!.getComputedStyle(overlays[1]).display).toBe(
          lastVisible ? 'inline' : 'none',
        )
      }
      expectOverlayVisibility(true, true)
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      const messageCount = messages.filter(
        (message) => message.kind === 'anchor-resolutions',
      ).length

      // The badge stays on the visible end even if the beginning is hidden.
      first.style.visibility = 'hidden'
      await new Promise<void>((resolve) =>
        frame!.contentWindow!.requestAnimationFrame(() =>
          frame!.contentWindow!.requestAnimationFrame(() => resolve()),
        ),
      )
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('inline-flex')
        const endRect = last.getBoundingClientRect()
        expect(
          Math.abs(badge.getBoundingClientRect().left - (endRect.right - 6)),
        ).toBeLessThan(2)
      })
      expectOverlayVisibility(false, true)
      first.style.visibility = 'visible'
      last.style.visibility = 'hidden'
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('none')
        expectOverlayVisibility(true, false)
      })

      last.style.visibility = 'visible'
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('inline-flex')
        expectOverlayVisibility(true, true)
      })
      expect(
        Array.from(doc.querySelectorAll('.ash-comment-highlight-svg')),
      ).toEqual(overlays)
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect(
        messages.filter((message) => message.kind === 'anchor-resolutions'),
      ).toHaveLength(messageCount)
    },
  )

  test('pointer dragging a badge updates its position without selecting the thread', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'drag', textStart: 0, textEnd: 16, count: 1 },
    ])
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    const before = badge.style.left
    const rect = badge.getBoundingClientRect()
    const pointer = (type: string, x: number, y: number) =>
      badge.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 1,
        }),
      )
    pointer('pointerdown', rect.left + 4, rect.top + 4)
    pointer('pointermove', rect.left + 84, rect.top + 44)
    pointer('pointerup', rect.left + 84, rect.top + 44)
    await vi.waitFor(() => expect(badge.style.left).not.toBe(before))
    await probeReporter()
    expect(badge.style.left).not.toBe(before)
    expect(selected()).toBeUndefined()
  })
})

test('a covered resolved comment retains verified ranges for jump without painting', async () => {
  const doc = await fixture(
    '<div style="height:1800px"></div><p id="covered">Highlighted text</p>',
  )
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights: ['open', 'resolved'].map((status) => ({
        threadId: status,
        status,
        quotedText: 'Highlighted text',
        prefixText: '',
        suffixText: '',
      })),
    },
    '*',
  )
  const result = await waitForMessage('anchor-resolutions')
  expect(result.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ threadId: 'resolved', state: 'attached' }),
    ]),
  )
  expect(doc.querySelectorAll('.ash-comment-highlight-badge')).toHaveLength(1)
  expect(doc.querySelector('[data-thread-id="resolved"]')).toBeNull()
  expect(
    doc.getElementById('covered')!.getBoundingClientRect().top,
  ).toBeGreaterThan(600)
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'scroll-to-comment',
      threadId: 'resolved',
    },
    '*',
  )
  await vi.waitFor(() => {
    const rect = doc.getElementById('covered')!.getBoundingClientRect()
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(600)
  })
  expect(doc.querySelector('[data-thread-id="resolved"]')).toBeNull()
})

test.each([
  { name: 'absent reporter', reporter: '' },
  {
    name: 'mismatched ready reply',
    reporter: `addEventListener('message', event => {
      if (event.data?.kind === 'ready-check') {
        parent.postMessage({ kind: 'ready', challenge: 'wrong-challenge' }, '*');
      }
    });`,
  },
])('static-site harness diagnoses $name', async ({ reporter }) => {
  const result = await server.commands.staticSiteWasm(reporter)
  expect(result.error).toBe('Error: reporter ready-check unanswered')
  expect(result.local).toBeUndefined()
  expect(result.blob).toBeUndefined()
  expect(result.blockedRequests).toBe(0)
})

test('static sites run WASM and workers without notices while blocked JavaScript is reported', async () => {
  const result = await server.commands.staticSiteWasm(
    VIOLATION_REPORTER_SCRIPT_BODY,
  )
  expect(result.error).toBeUndefined()
  expect(result.serviceWorker).toEqual({
    supported: true,
    rejected: true,
    registrations: 0,
    controlled: false,
  })
  expect(result.serviceWorkerRequests).toEqual([
    { header: 'script', status: 403 },
  ])
  expect(result.svgImage).toBe(true)
  expect(result.xmlResults).toEqual([
    { marker: 'executed', evalBlocked: true, networkBlocked: true },
    { marker: 'executed', evalBlocked: true, networkBlocked: true },
  ])
  expect(result.local).toEqual({
    wasm: 'worker-wasm',
    evalBlocked: true,
    functionBlocked: true,
    networkBlocked: true,
  })
  expect(result.blob).toEqual({
    wasm: 'worker-wasm',
    evalBlocked: true,
    functionBlocked: true,
    networkBlocked: true,
  })
  expect(result.allowedReports).toEqual([])
  expect(result.blocked).toEqual([true, true, true, true])
  expect(result.blockedRequests).toBe(0)
  if (server.browser !== 'webkit') {
    expect(result.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'csp-violation',
          directive: 'script-src',
          blockedURI: 'eval',
        }),
      ]),
    )
  }
  // Browsers may redact the path of a cross-origin violation report.
  expect(
    result.reports
      .filter((report) => report.directive === 'connect-src')
      .map((report) => new URL(report.blockedURI).origin),
  ).toContain(result.blockedOrigin)
})

test.skipIf(server.browser !== 'chromium')(
  'static-site workers fetch DuckDB extensions but reject unlisted origins',
  async () => {
    const result = await server.commands.staticSiteExtensions()
    expect(result.error).toBeUndefined()
    for (const worker of [result.local, result.blob]) {
      expect(worker).toEqual({ bytes: [68, 85, 67, 75], networkBlocked: true })
    }
    expect(result.fulfilledRequests).toBe(2)
    expect(result.blockedRequests).toBe(0)
  },
)

test('XML object embedding allows the asset ancestor and retains eval and network limits', async () => {
  expect(await server.commands.staticSiteXmlEmbedding()).toEqual({
    marker: 'executed',
    rendered: true,
    evalBlocked: true,
    networkBlocked: true,
    blockedRequests: 0,
    controlRequests: 1,
  })
})

test.each([undefined, '', 'diagnostic sample'])(
  'generated reporter omits absent or empty samples (%j)',
  async (sample) => {
    const doc = await fixture()
    doc.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'script-src',
        blockedURI: 'eval',
        ...(sample === undefined ? {} : { sample }),
      }),
    )
    const report = await waitForMessage('csp-violation')
    if (sample) expect(report).toHaveProperty('sample', sample)
    else expect(report).not.toHaveProperty('sample')
  },
)

test.each(['enforce', 'report'])(
  'generated reporter bounds samples and retains %s disposition',
  async (disposition) => {
    const doc = await fixture()
    doc.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'script-src',
        blockedURI: 'eval',
        sample: 'x'.repeat(90),
        disposition,
      }),
    )
    expect(await waitForMessage('csp-violation')).toMatchObject({
      sample: 'x'.repeat(80),
      disposition,
    })
  },
)

test.each([
  { index: 0, classification: 'artifact', directive: 'connect-src' },
  { index: 1, classification: 'environment', directive: 'script-src' },
] as const)(
  'viewer capture seed preserves a parse-time $classification report until the parent hydrates',
  async ({ index, classification, directive }) => {
    const result = await server.commands.cspDiagnostic(
      injectReadyReporter(CSP_DIAGNOSTIC_BODIES[index]),
      VIOLATION_REPORTER_SHA256,
    )
    expect(result.errors).toEqual([])
    expect(result.unexpectedRequests).toEqual([])
    expect(result.reports.length).toBeGreaterThan(0)
    for (const report of result.reports) {
      expect(isSandboxMessage(report)).toBe(true)
      expect(report.directive).toBe(directive)
      expect(
        classifyCspViolation(report.sourceFile, result.sandboxOrigin, 'html'),
      ).toBe(classification)
    }
    if (classification === 'environment') {
      expect(result.reports[0]).toMatchObject({
        blockedURI: 'eval',
        sourceFile: null,
        sample: 'environment diagnostic example',
        disposition: 'enforce',
      })
    } else {
      expect(new URL(result.reports[0].blockedURI).origin).toBe(
        'https://example.com',
      )
    }
  },
  10000,
)

test('reports fragments only after ready, then tracks anchors and both history methods', async () => {
  const doc = await fixture(
    '<a href="#heading">Contents</a><h2 id="heading">Heading</h2>',
    false,
    true,
  )
  const win = frame!.contentWindow!
  win.location.hash = '#before-ready'
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(messages.filter((m) => m.kind === 'hash-changed')).toHaveLength(0)
  await probeReporter()
  const initial = await waitForMessage('hash-changed')
  expect(initial.hash).toBe('#before-ready')
  expect(initial.path).toBe(win.location.pathname)
  expect(initial.token).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(initial).sort()).toEqual([
    'hash',
    'kind',
    'path',
    'source',
    'token',
  ])
  expect(messages.findIndex((m) => m.kind === 'ready')).toBeLessThan(
    messages.indexOf(initial),
  )
  doc.querySelector('a')!.click()
  await waitForMessage('hash-changed', (m) => m.hash === '#heading')
  expect(win.history.pushState({ filter: 1 }, '', '#pushed')).toBeUndefined()
  await waitForMessage('hash-changed', (m) => m.hash === '#pushed')
  expect(
    win.history.replaceState({ filter: 2 }, '', '#replaced'),
  ).toBeUndefined()
  await waitForMessage('hash-changed', (m) => m.hash === '#replaced')
  expect(win.history.state).toEqual({ filter: 2 })
  const unchangedStart = messages.length
  for (let i = 0; i < 10; i++) {
    win.history.replaceState({ scroll: i }, '')
    win.history.pushState({ scroll: i }, '', '#replaced')
  }
  // The readiness retry timer also sends snapshots. Use an explicit probe as
  // a delivery fence for the preceding history calls instead of counting all
  // snapshots after an arbitrary delay.
  const challenge = 'unchanged-history-snapshot'
  await probeReporter(challenge)
  const ready = await waitForMessage(
    'ready',
    (message) => message.challenge === challenge,
    unchangedStart,
  )
  const snapshot = await waitForMessage(
    'hash-changed',
    () => true,
    messages.indexOf(ready) + 1,
  )
  expect(snapshot.hash).toBe('#replaced')
  expect(snapshot.path).toBe(win.location.pathname)
  expect(snapshot.token).toBe(initial.token)
  for (
    let index = unchangedStart;
    index <= messages.indexOf(snapshot);
    index++
  ) {
    if (messages[index].kind !== 'hash-changed') continue
    // Only a ready response may resend an unchanged snapshot. An extra report
    // from either history wrapper would have no preceding ready response.
    expect(messages[index - 1].kind).toBe('ready')
    expect(messages[index].hash).toBe('#replaced')
    expect(messages[index].token).toBe(messages[index - 1].token)
  }
  expect(() =>
    win.history.replaceState.call({} as History, null, '', '#invalid'),
  ).toThrow()
  expect(() =>
    win.history.pushState(null, '', 'https://example.com/'),
  ).toThrow()
  expect(win.location.hash).toBe('#replaced')
})

test('Markdown CSP executes the regenerated reporter while blocking authored scripts', async () => {
  const result = await server.commands.cspDiagnostic(
    injectReadyReporter(
      '<!doctype html><html><head></head><body><h1>Heading</h1><script>window.untrusted = true</script></body></html>',
    ),
    VIOLATION_REPORTER_SHA256,
    'md',
  )
  expect(
    result.reports.some(
      (report) =>
        report.directive === 'script-src-elem' &&
        report.blockedURI === 'inline',
    ),
  ).toBe(true)
})
