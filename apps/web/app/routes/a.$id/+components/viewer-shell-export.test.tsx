// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { bindI18n } from '~/lib/i18n'
import { ViewerShell, type ViewerShellArtifact } from './viewer-shell'

const locale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: {
    pathname: '/a/abc123def4',
    search: '',
    hash: '#stale',
    state: null,
  },
}))
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useLocation: () => navigation.location,
  useNavigate: () => navigation.navigate,
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const i18n = await import('~/lib/i18n')
  return { useT: () => i18n.bindI18n(locale.value) }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./viewer-chrome', () => ({
  ViewerChrome: ({
    onDownloadPdf,
    onDownloadHtml,
    onCopyMarkdown,
  }: {
    onDownloadPdf: () => void
    onDownloadHtml: () => void
    onCopyMarkdown: () => void
  }) => (
    <>
      <button onClick={onDownloadPdf}>PDF</button>
      <button onClick={onDownloadHtml}>HTML</button>
      <button onClick={onCopyMarkdown}>Copy</button>
    </>
  ),
}))
const artifact: ViewerShellArtifact = {
  id: 'abc123def4',
  storageKey: 'abc123def4/index.html',
  name: 'Example',
  derivedTitle: null,
  titleOverride: null,
  ownerId: 'u1',
  ownerName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: '2026-01-01T00:00:00.000Z',
  viewCount: 0,
  visibility: 'private',
  workspaceHd: null,
  availableVisibilities: ['private'],
  grants: [],
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(toast.error).mockClear()
})

test.each(
  (['en', 'ja'] as const).flatMap((language) =>
    ['source', 'preparation', 'unsupported', 'html', 'copy'].map((failure) => ({
      language,
      failure,
    })),
  ),
)(
  'Viewer export reports the correct operation for $failure failure in $language',
  async ({ language, failure }) => {
    locale.value = language
    vi.stubGlobal(
      'WebSocket',
      class extends EventTarget {
        static OPEN = 1
        readyState = 0
        close() {}
        send() {}
      },
    )
    vi.stubEnv('SSR', false)
    const { t } = bindI18n(language)
    const popup = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      opener: null,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window
    // happy-dom inserts before removing the old document element, unlike browsers.
    vi.spyOn(popup.document, 'replaceChild').mockImplementation(
      (node, child) => {
        popup.document.removeChild(child)
        popup.document.appendChild(node)
        return child
      },
    )
    vi.spyOn(window, 'open').mockReturnValue(popup)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes('/export-source'))
          return new Response('', { status: 404 })
        if (failure === 'unsupported')
          return Response.json(
            { error: { code: 'unsupported-kind' } },
            { status: 400 },
          )
        if (failure !== 'preparation') return new Response('', { status: 500 })
        return Response.json({
          kind: 'html',
          artifactKind: 'html',
          source: '<img src="missing.png">',
          path: '/index.html',
          versionId: 'version-1',
          fileName: 'report.html',
        })
      }),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <ViewerShell
            artifact={artifact}
            user={{
              id: 'u1',
              name: 'Owner',
              email: 'owner@example.com',
              image: null,
              initial: 'O',
            }}
            renderType="html"
            sandboxUrl={null}
            bundlePaths={[]}
          />,
        ),
      )
      const label =
        failure === 'html' ? 'HTML' : failure === 'copy' ? 'Copy' : 'PDF'
      const button = Array.from(host.querySelectorAll('button')).find(
        (el) => el.textContent === label,
      )!
      await act(async () => button.click())
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          t(
            failure === 'unsupported'
              ? 'toast.exportUnsupported'
              : failure === 'html' || failure === 'copy'
                ? 'toast.exportExtractFailed'
                : 'toast.exportPdfFailed',
          ),
        ),
      )
      if (failure === 'preparation') {
        expect(popup.document.body.dataset.exportState).toBe('failed')
        expect(
          popup.document.getElementById('artifactshare-print-status')
            ?.textContent,
        ).toBe(t('toast.exportPdfFailed'))
      }
    } finally {
      await act(async () => root.unmount())
      host.remove()

      vi.unstubAllEnvs()
    }
  },
)
