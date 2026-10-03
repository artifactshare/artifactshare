import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
const locale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: locale.value,
    t: (key: keyof typeof en) => (locale.value === 'en' ? en : ja)[key],
    tPlural: () => 'comments',
  }),
}))
vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({ setCommentPanelOpen: vi.fn() }),
}))
vi.mock('~/components/app/app-side-panel', async () => {
  const { Dialog } = await import('~/components/ui/dialog')
  return {
    AppSidePanel: ({ children }: { children: ReactNode }) => (
      <Dialog open>
        <div>{children}</div>
      </Dialog>
    ),
  }
})
import { CommentPanel } from './comment-panel'

type PositionState = 'attached' | 'needs-check' | 'unchecked'

function textThread(
  positionState: PositionState,
  id = 'thread-1',
  quotedText = 'Original words',
): CommentThreadView {
  return {
    id,
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    canResolve: false,
    messages: [],
    subject: {
      kind: 'text',
      state: positionState === 'attached' ? 'attached' : 'orphaned',
      positionState,
      quotedText,
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  }
}

function render(positionState: PositionState) {
  return renderThreads([textThread(positionState)])
}

function renderThreads(threads: CommentThreadView[]) {
  return renderToStaticMarkup(
    <CommentPanel
      shareableId="artifact"
      viewerUserId="viewer"
      threads={threads}
      onThreadsChange={() => {}}
      isCurrentShareableId={() => true}
      open
      onOpenChange={() => {}}
      targetThreadId={null}
      targetThreadScroll="center"
      onThreadNavigate={() => {}}
    />,
  )
}
test.each(['en', 'ja'] as const)(
  'needs-check retains the quote, shows localized guidance and disables jump (%s)',
  (language) => {
    locale.value = language
    const html = render('needs-check')
    expect(html).toContain('Original words')
    expect(html).toContain(
      renderToStaticMarkup(
        <strong className="">
          {(language === 'en' ? en : ja)['comments.subjectOrphaned']}
        </strong>,
      ),
    )
    expect(html).not.toContain(' data-comment-thread-hitarea=""')
    // Negative control: attached threads still provide navigation.
    expect(render('attached')).toContain(' data-comment-thread-hitarea=""')
    expect(render('unchecked')).toContain(
      (language === 'en' ? en : ja)['comments.positionChecking'],
    )
  },
)

test('a text comment keeps its list position while its check finishes', () => {
  const artifactThread: CommentThreadView = {
    ...textThread('attached', 'thread-artifact'),
    subject: { kind: 'artifact' },
  } as CommentThreadView
  locale.value = 'en'
  const order = (state: PositionState) => {
    const html = renderThreads([
      artifactThread,
      textThread(state, 'thread-text', 'Checked words'),
    ])
    const artifactAt = html.indexOf(en['comments.subjectArtifact'])
    expect(artifactAt).toBeGreaterThan(-1)
    return html.indexOf('Checked words') < artifactAt
  }
  expect(order('unchecked')).toBe(order('attached'))
  expect(order('attached')).toBe(true)
  expect(order('needs-check')).toBe(false)
})

test('checking is neutral; only a missing quote uses warning colors', () => {
  locale.value = 'en'
  expect(render('unchecked')).not.toContain('text-warning')
  expect(render('unchecked')).toContain(en['comments.positionChecking'])
  expect(render('needs-check')).toContain('text-warning')
  const thread = textThread('unchecked')
  if (thread.subject.kind === 'text') thread.subject.checking = false
  const html = renderThreads([thread])
  expect(html).toContain('Original words')
  expect(html).not.toContain('text-warning')
  expect(html).not.toContain(en['comments.positionChecking'])
  expect(html).not.toContain(' data-comment-thread-hitarea=""')
})
