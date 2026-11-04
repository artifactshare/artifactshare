// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { FileRowData } from './file-data'
import { FileRow } from './file-row'

const file: FileRowData = {
  id: 'private-file',
  fileName: 'report.html',
  derivedTitle: null,
  titleOverride: null,
  renderType: 'html',
  ownerId: 'owner',
  ownerEmail: 'owner@example.com',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  isOwner: true,
  visibility: 'private',
  viewCount: 0,
  commentCount: 0,
  modifiedTime: null,
}

test.each([
  ['en', 'Private', 'Specific'],
  ['ja', '非公開', '個別共有'],
] as const)(
  '%s list rows render grant-aware labels and titles in both responsive chips',
  (locale, privateLabel, specificLabel) => {
    for (const hasDirectGrants of [false, true, undefined]) {
      const router = createMemoryRouter(
        [
          {
            id: 'root',
            path: '/',
            element: (
              <TooltipProvider>
                <FileRow data={{ ...file, hasDirectGrants }} />
              </TooltipProvider>
            ),
          },
        ],
        { hydrationData: { loaderData: { root: { locale } } } },
      )
      try {
        const doc = new DOMParser().parseFromString(
          renderToStaticMarkup(<RouterProvider router={router} />),
          'text/html',
        )
        const label = hasDirectGrants === false ? privateLabel : specificLabel
        const mobile = doc.querySelector(
          '[data-regression-responsive="mobile-only"] [data-slot="badge"]',
        )
        const desktop = doc.querySelector(
          '[data-regression-responsive="desktop-only"][data-slot="badge"]',
        )
        for (const chip of [mobile, desktop]) {
          expect(chip).not.toBeNull()
          expect(chip?.textContent).toBe(label)
          expect(chip?.getAttribute('title')).toBe(label)
        }
      } finally {
        router.dispose()
      }
    }
  },
)
