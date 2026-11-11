import { acquireCommentRuntime } from './comment-runtime-browser'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { useCommentMutations } from './use-comment-mutations'
import { TextSelectionCommentPopover } from './text-selection-comment-popover'

const revalidate = vi.hoisted(() => vi.fn())
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test('a successful retry dismisses only the error of its producer and operation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let failing = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      failing
        ? Response.json({ error: {} }, { status: 503 })
        : Response.json({ threads: [] }),
    ),
  )
  let writers: ReturnType<typeof useCommentMutations>[] = []
  function Harness() {
    const options = {
      shareableId: 'retry-artifact',
      isCurrentShareableId: () => true,
      onThreadsChange: vi.fn(),
    }
    writers = [useCommentMutations(options), useCommentMutations(options)]
    return null
  }
  const root = createRoot(document.createElement('div'))
  async function post(writer: number, threadId: string) {
    let success = false
    await act(async () => {
      success = await writers[writer].mutate({
        intent: 'reply',
        threadId,
        body: 'Review',
      })
    })
    return success
  }
  try {
    await act(async () => root.render(<Harness />))
    expect(await post(0, 'a')).toBe(false)
    const firstError = vi.mocked(toast.error).mock.calls.at(-1)![1]!.id
    expect(toast.dismiss).not.toHaveBeenCalled()
    expect(await post(0, 'b')).toBe(false)
    const otherOperation = vi.mocked(toast.error).mock.calls.at(-1)![1]!.id
    expect(otherOperation).not.toBe(firstError)
    expect(await post(1, 'a')).toBe(false)
    const otherProducer = vi.mocked(toast.error).mock.calls.at(-1)![1]!.id
    expect(otherProducer).not.toBe(firstError)
    failing = false
    expect(await post(0, 'a')).toBe(true)
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(firstError)
    expect(await post(1, 'a')).toBe(true)
    expect(toast.dismiss).toHaveBeenLastCalledWith(otherProducer)
    expect(toast.dismiss).not.toHaveBeenCalledWith(otherOperation)
  } finally {
    await act(async () => root.unmount())
  }
})

test.each([
  ['version_conflict', 409, 'comments.versionConflict'],
  ['thread-capacity', 409, 'comments.threadCapacity'],
  ['rate-limited', 429, 'comments.rateLimited'],
  ['html', 503, 'comments.errorSave'],
] as const)(
  'actual %s response retains a quoted draft and shows specific guidance',
  async (code, status, guidance) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const reload = vi.spyOn(window.location, 'reload')
    const onThreadsChange = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const fetch = vi.fn(async () =>
      code === 'html'
        ? new Response('<html>Unavailable</html>', { status })
        : Response.json(
            { error: { code, details: { retry_after_seconds: 12 } } },
            { status },
          ),
    )
    vi.stubGlobal('fetch', fetch)
    try {
      await act(async () =>
        root.render(
          <TextSelectionCommentPopover
            shareableId="synthetic-artifact"
            anchor={{
              quotedText: 'quote',
              prefixText: '',
              suffixText: '',
              textStart: 0,
              textEnd: 5,
              cssPath: null,
              versionId: 'v1',
              rect: { top: 0, left: 0, width: 20, height: 10 },
            }}
            isCurrentShareableId={() => true}
            onThreadsChange={onThreadsChange}
            onClose={() => {}}
          />,
        ),
      )
      await act(async () => {
        const textarea = host.querySelector('textarea')!
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(textarea, 'Check')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        ;[...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'comments.comment')!
          .click()
      })
      await act(async () =>
        waitForRealTaskCondition(
          () => vi.mocked(toast.error).mock.calls.length > 0,
          'comment refusal body consumed',
        ),
      )
      expect(fetch).toHaveBeenCalledOnce()
      expect(onThreadsChange).not.toHaveBeenCalled()
      expect(host.querySelector('textarea')!.value).toBe('Check')
      expect(host.textContent).toContain('quote')
      if (code === 'version_conflict') {
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(guidance, {
          id: expect.any(String),
          action: { label: 'home.reload', onClick: expect.any(Function) },
        })
        const action = vi.mocked(toast.error).mock.calls[0]![1]!
          .action as unknown as { onClick: () => void }
        expect(revalidate).not.toHaveBeenCalled()
        await act(async () => action.onClick())
        expect(revalidate).toHaveBeenCalledOnce()
      } else {
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(guidance, {
          id: expect.any(String),
        })
        expect(revalidate).not.toHaveBeenCalled()
      }
      expect(reload).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)

function CapacityReply({
  showNewThreadComposer,
}: {
  showNewThreadComposer: boolean
}) {
  const { mutate } = useCommentMutations({
    shareableId: 'synthetic-artifact',
    isCurrentShareableId: () => true,
    onThreadsChange: () => {},
    showNewThreadComposer,
  })
  return (
    <button
      onClick={() =>
        void mutate({
          intent: 'reply',
          threadId: 'thread',
          body: 'Draft reply',
        })
      }
    >
      Reply
    </button>
  )
}

test.each([
  [false, 'comments.threadCapacity'],
  [true, 'comments.threadCapacityArtifact'],
] as const)(
  'capacity guidance uses the available composer (%s)',
  async (showNewThreadComposer, guidance) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'thread-capacity' } },
            { status: 409 },
          ),
        ),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <CapacityReply showNewThreadComposer={showNewThreadComposer} />,
        ),
      )
      await act(async () => host.querySelector('button')!.click())
      await act(async () =>
        waitForRealTaskCondition(
          () => vi.mocked(toast.error).mock.calls.length > 0,
          'capacity refusal consumed',
        ),
      )
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(guidance, {
        id: expect.any(String),
      })
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)

test.each(['reply', 'update-message', 'delete-message', 'resolve'] as const)(
  'a refused %s settlement retains the targeted thread identity',
  async (intent) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code: 'rate-limited' } }, { status: 429 }),
      ),
    )
    let mutate!: ReturnType<typeof useCommentMutations>['mutate']
    function Harness() {
      mutate = useCommentMutations({
        shareableId: 'synthetic-artifact',
        isCurrentShareableId: () => true,
        onThreadsChange: vi.fn(),
      }).mutate
      return null
    }
    const settled = vi.fn()
    const runtime = acquireCommentRuntime('synthetic-artifact')
    runtime.subscribe(settled)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      let done = false
      await act(async () => {
        void mutate({
          intent,
          threadId: 'thread-a',
          messageId: 'message',
          body: 'Draft',
        }).then(() => {
          done = true
        })
        await waitForRealTaskCondition(() => done, 'refusal settled')
      })
      expect(settled).toHaveBeenCalledOnce()
      expect(settled.mock.calls[0][0].threadId).toBe('thread-a')
    } finally {
      runtime.release()
      await act(async () => root.unmount())
    }
  },
)
