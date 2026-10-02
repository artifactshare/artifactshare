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

function render(positionState: 'attached' | 'needs-check' | 'unchecked') {
  const thread: CommentThreadView = {
    id: 'thread-1',
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
      quotedText: 'Original words',
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  }
  return renderToStaticMarkup(
    <CommentPanel
      shareableId="artifact"
      viewerUserId="viewer"
      threads={[thread]}
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
