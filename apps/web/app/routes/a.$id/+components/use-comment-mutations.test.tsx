// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { fetchJsonWithViewerTimeout } from '~/lib/viewer-network'
import { TextSelectionCommentPopover } from './text-selection-comment-popover'

const revalidate = vi.hoisted(() => vi.fn())
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('~/lib/viewer-network', () => ({
  fetchJsonWithViewerTimeout: vi.fn(),
  logViewerNetworkEvent: vi.fn(),
  cfRayFrom: vi.fn(),
  viewerFetchFailureReason: vi.fn(),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test('creation conflict shows the accurate toast and revalidates instead of reloading', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reload = vi.spyOn(window.location, 'reload')
  const onThreadsChange = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  vi.mocked(fetchJsonWithViewerTimeout).mockResolvedValue({
    response: new Response(null, { status: 409 }),
    body: { error: { code: 'version_conflict' } },
  })
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
    expect(fetchJsonWithViewerTimeout).toHaveBeenCalledOnce()
    expect(onThreadsChange).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'comments.versionConflict',
      { action: { label: 'home.reload', onClick: expect.any(Function) } },
    )
    const action = vi.mocked(toast.error).mock.calls[0]![1]!
      .action as unknown as { onClick: () => void }
    expect(revalidate).not.toHaveBeenCalled()
    await act(async () => action.onClick())
    expect(revalidate).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
