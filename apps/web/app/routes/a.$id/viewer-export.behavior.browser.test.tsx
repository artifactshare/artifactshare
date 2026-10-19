import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { ViewerShell } from './+components/viewer-shell'
import {
  artifactSupportsExport,
  downloadText,
  fetchExportSource,
  htmlDownloadFileName,
  markdownDownloadFileName,
  resolveExportHtml,
  resolveExportMarkdown,
  type ExportSourceData,
} from './+components/export-actions'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/components/app/avatar-menu', () => ({ AvatarMenu: () => null }))

let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  router?.dispose()
  router = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const artifact = {
  id: 'artifact-1',
  storageKey: 'artifact-1/index.html',
  name: 'demo.html',
  derivedTitle: 'Demo',
  titleOverride: null,
  ownerId: 'owner',
  ownerName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: '2026-01-03T00:00:00.000Z',
  canReplaceFile: false,
  canViewHistory: false,
  canChangeVisibility: false,
  visibility: 'link' as const,
  workspaceHd: null,
  availableVisibilities: ['link'] as const,
  grants: [],
  viewCount: 1,
}

for (const width of [390, 1280]) {
  test.each(
    (['html', 'md', 'static_site'] as const).flatMap((renderType) =>
      (['owner', 'recipient', 'anonymous'] as const).map((role) => ({
        renderType,
        role,
      })),
    ),
  )(
    `viewer shell exports at ${width}px: $renderType / $role`,
    async ({ renderType, role }) => {
      await page.viewport(width, 800)
      const popup = vi.spyOn(window, 'open').mockReturnValue(null)
      const copy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue()
      const downloads: string[] = []
      const blobs: Blob[] = []
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        blobs.push(blob as Blob)
        return 'blob:export'
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          downloads.push(this.download)
        },
      )
      const path = renderType === 'md' ? '/index.md' : '/docs/page.html'
      const source: ExportSourceData = {
        kind: renderType === 'md' ? 'markdown' : 'html',
        artifactKind:
          renderType === 'static_site'
            ? 'static_site'
            : renderType === 'md'
              ? 'markdown_page'
              : 'html_page',
        path,
        versionId: 'version-1',
        fileName: renderType === 'md' ? 'notes.md' : 'page.html',
        source:
          renderType === 'md'
            ? '# Notes'
            : '<html><body><article><h1>Notes</h1><p>Keep this text.</p></article></body></html>',
        renderedHtml: '<h1>Notes</h1>',
      }
      const exportPaths: string[] = []
      vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input), window.location.origin)
        if (url.pathname === '/api/shareables/artifact-1/export-source') {
          exportPaths.push(url.searchParams.get('path')!)
          return Response.json(source)
        }
        if (url.pathname === '/api/shareables/artifact-1/current-version') {
          return Response.json({ currentVersionId: 'version-1' })
        }
        throw new Error(`Unexpected viewer request: ${url.pathname}`)
      })
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      router = createMemoryRouter([
        {
          path: '/',
          element: (
            <TooltipProvider>
              <ViewerShell
                artifact={{
                  ...artifact,
                  currentVersionId: 'version-1',
                  entrypointPath: path,
                  canReplaceFile: role === 'owner',
                  canChangeVisibility: role === 'owner',
                }}
                user={
                  role === 'anonymous'
                    ? null
                    : {
                        id: role,
                        email: 'viewer@example.com',
                        name: 'Viewer',
                        image: null,
                        initial: 'V',
                      }
                }
                renderType={renderType}
                sandboxUrl={null}
                bundlePaths={[]}
              />
            </TooltipProvider>
          ),
        },
      ])
      root.render(<RouterProvider router={router} />)
      await waitForBrowserLayout()
      if (role === 'anonymous') {
        expect(
          host.querySelector('button[data-viewer-more-menu-trigger]'),
        ).toBeNull()
        expect(exportPaths).toEqual([])
      } else {
        for (const label of [
          'Copy Markdown',
          'Download HTML',
          'Download Markdown',
        ]) {
          const trigger = await vi.waitFor(() => {
            const button = host.querySelector<HTMLButtonElement>(
              'button[data-viewer-more-menu-trigger]',
            )
            expect(button).not.toBeNull()
            return button!
          })
          trigger.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              button: 0,
              pointerType: 'mouse',
            }),
          )
          const menu = await vi.waitFor(() => {
            const element = document.querySelector<HTMLElement>('[role="menu"]')
            expect(element).not.toBeNull()
            return element!
          })
          const items = [
            ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ]
          expect(
            items.slice(0, 3).map((item) => item.textContent?.trim()),
          ).toEqual(['Copy Markdown', 'Download HTML', 'Download Markdown'])
          // The real shell supplies the export callbacks; the base also supplies PDF here.
          expect(menu.textContent).not.toMatch(/pdf|print/i)
          const item = items.find(
            (candidate) => candidate.textContent?.trim() === label,
          )!
          item.click()
          await vi.waitFor(() =>
            expect(document.querySelector('[role="menu"]')).toBeNull(),
          )
          await vi.waitFor(() => {
            if (label === 'Copy Markdown') expect(copy).toHaveBeenCalledOnce()
            else
              expect(downloads).toHaveLength(label === 'Download HTML' ? 1 : 2)
          })
        }
        expect(copy.mock.calls[0][0]).toContain('# Notes')
        expect(downloads).toEqual(
          renderType === 'md'
            ? ['notes.html', 'notes.md']
            : ['page.html', 'page.md'],
        )
        expect(blobs.map((blob) => blob.type)).toEqual([
          'text/html;charset=utf-8',
          'text/markdown;charset=utf-8',
        ])
        expect(await blobs[0].text()).toContain('<h1>Notes</h1>')
        expect(await blobs[1].text()).toBe(copy.mock.calls[0][0])
        expect(exportPaths).toEqual([path, path, path])
      }
      expect(popup).not.toHaveBeenCalled()
    },
  )
}

test('surviving exports preserve Markdown, HTML extraction and nested assets', async () => {
  const markdown: ExportSourceData = {
    kind: 'markdown',
    artifactKind: 'markdown_page',
    path: '/index.md',
    versionId: 'version-1',
    source: '# Notes\n\nKeep this text.',
    fileName: 'notes.md',
    renderedHtml: '<h1>Notes</h1><p>Keep this text.</p>',
  }
  const fetchMock = vi
    .spyOn(window, 'fetch')
    .mockResolvedValue(Response.json(markdown))
  const fetched = await fetchExportSource('artifact-1', '/index.md')
  expect(fetched).toEqual({ ok: true, data: markdown })
  expect(
    new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('path'),
  ).toBe('/index.md')
  expect(await resolveExportMarkdown(markdown)).toBe(markdown.source)
  expect(await resolveExportHtml('artifact-1', markdown)).toContain(
    '<h1>Notes</h1>',
  )
  const nested: ExportSourceData = {
    ...markdown,
    kind: 'html',
    artifactKind: 'static_site',
    path: '/docs/page.html',
    fileName: 'page.html',
    source:
      '<html><body><article><h1>Guide</h1><p>Read the guide and follow the steps described here.</p><a href="next.html">Next page</a><img src="../assets/logo.png"><link rel="stylesheet" href="style.css"></article></body></html>',
  }
  fetchMock.mockImplementation(
    async () =>
      new Response('asset', { headers: { 'Content-Type': 'image/png' } }),
  )
  const extracted = await resolveExportMarkdown(nested)
  expect(extracted).toContain('# Guide')
  expect(extracted).toContain('[Next page](next.html)')
  const html = await resolveExportHtml('artifact-1', nested)
  expect(html).toContain('data:image/png;base64,YXNzZXQ=')
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shareables/artifact-1/export-asset/assets/logo.png',
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shareables/artifact-1/export-asset/docs/style.css',
  )
  const blobs: Blob[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:export'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const downloads: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    },
  )
  downloadText(
    markdownDownloadFileName(nested.fileName),
    extracted!,
    'text/markdown;charset=utf-8',
  )
  downloadText(
    htmlDownloadFileName(markdown.fileName),
    html!,
    'text/html;charset=utf-8',
  )
  expect(downloads).toEqual(['page.md', 'notes.html'])
  expect(blobs.map((blob) => blob.type)).toEqual([
    'text/markdown;charset=utf-8',
    'text/html;charset=utf-8',
  ])
  expect(await blobs[0].text()).toBe(extracted)
  expect(await blobs[1].text()).toBe(html)
  expect(artifactSupportsExport(null)).toBe(false)
})
