import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SandboxFrame } from './a.$id/+components/sandbox-frame'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))

// A deck whose own key handler moves between slides.
const DECK = `<!doctype html><title>Deck</title><h1 id="slide">Slide 1</h1>
<script>
  let slide = 1
  addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') slide++
    if (event.key === 'ArrowLeft') slide = Math.max(1, slide - 1)
    document.getElementById('slide').textContent = 'Slide ' + slide
  })
</script>`

let root: Root | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function renderDeck(options: { targetThreadId?: string } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  const host = document.createElement('div')
  const input = document.createElement('input')
  input.setAttribute('aria-label', 'Viewer comment')
  document.body.appendChild(input)
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SandboxFrame
        renderType="html"
        canViewEnvironmentDiagnostics={false}
        shareableId="abc123def4"
        versionId="v1"
        url={`${window.location.origin}/sandbox-frame-initial-focus`}
        name="Deck"
        mermaidEnabled={false}
        textAnchorsEnabled={false}
        linkNavigationMode="document"
        bundlePaths={[]}
        fallbackToIndex={false}
        commentThreads={[]}
        targetThreadId={options.targetThreadId ?? null}
        highlightThreadId={null}
        followsAppTheme={false}
        onTextSelection={() => {}}
        onTextSelectionClear={() => {}}
        onThreadSelect={() => {}}
        onOutsidePointerDown={() => {}}
        sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />,
    )
  })
  const frame = host.querySelector('iframe')!
  await act(async () => {
    await new Promise<void>((resolve) => {
      const onLoad = () => {
        if (frame.contentDocument?.title !== 'Deck') return
        frame.removeEventListener('load', onLoad)
        resolve()
      }
      frame.addEventListener('load', onLoad)
      frame.srcdoc = DECK
    })
  })
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => frame.dispatchEvent(new Event('load')))
  const answer = async () => {
    const check = post.mock.calls.findLast(
      ([message]) => message.kind === 'ready-check',
    )![0] as { challenge: string }
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: 'artifactshare',
            kind: 'ready',
            challenge: check.challenge,
            token: 'a'.repeat(64),
          },
        }),
      )
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
  }
  const slide = () =>
    frame.contentDocument!.getElementById('slide')!.textContent
  return { frame, input, answer, slide }
}

test('arrow keys move the document after it answers, without a click', async () => {
  const { answer, slide } = await renderDeck()
  expect(slide()).toBe('Slide 1')
  await answer()
  await userEvent.keyboard('{ArrowRight}')
  await userEvent.keyboard('{ArrowRight}')
  expect(slide()).toBe('Slide 3')
  await userEvent.keyboard('{ArrowLeft}')
  expect(slide()).toBe('Slide 2')
})

test('a control the reader already uses keeps focus and its text', async () => {
  const { input, answer, slide } = await renderDeck()
  await userEvent.click(input)
  await userEvent.keyboard('draft')
  await answer()
  expect(document.activeElement).toBe(input)
  await userEvent.keyboard('{ArrowRight}')
  expect(input.value).toBe('draft')
  expect(slide()).toBe('Slide 1')
})

test('a reader who acted and returned to the page body is not redirected', async () => {
  const { input, answer, slide } = await renderDeck()
  await userEvent.click(input)
  input.blur()
  expect(document.activeElement).toBe(document.body)
  await answer()
  expect(document.activeElement).toBe(document.body)
  await userEvent.keyboard('{ArrowRight}')
  expect(slide()).toBe('Slide 1')
})

test('later answers never take focus back', async () => {
  const { frame, input, answer } = await renderDeck()
  await answer()
  expect(document.activeElement).toBe(frame)
  await userEvent.click(input)
  await act(async () => frame.dispatchEvent(new Event('load')))
  await answer()
  await answer()
  expect(document.activeElement).toBe(input)
})

test('a comment link keeps its own destination', async () => {
  const { answer, slide } = await renderDeck({ targetThreadId: 'thread-1' })
  await answer()
  expect(document.activeElement).toBe(document.body)
  await userEvent.keyboard('{ArrowRight}')
  expect(slide()).toBe('Slide 1')
})

test('a background tab is focused once when it is first shown', async () => {
  let visibility: DocumentVisibilityState = 'hidden'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  )
  const { frame, answer } = await renderDeck()
  await answer()
  expect(document.activeElement).toBe(document.body)
  visibility = 'visible'
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  expect(document.activeElement).toBe(frame)
})
