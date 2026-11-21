import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'

const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
import { ArtifactFilters } from './+components/artifact-filters'

test.each(['en', 'ja'] as const)(
  'server-rendered artifact filters show field labels and selections in %s',
  (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    for (const filtered of [false, true]) {
      const router = createMemoryRouter([
        {
          path: '/',
          element: (
            <ArtifactFilters
              filters={{
                visibility: filtered ? 'private' : 'all',
                sort: filtered ? 'size' : 'updated',
              }}
            />
          ),
        },
      ])
      const doc = new Window().document
      doc.body.innerHTML = renderToStaticMarkup(
        <RouterProvider router={router} />,
      )
      router.dispose()
      const pairs = [
        [
          'inventory-visibility-filter',
          t('team.inventory.filter'),
          t(filtered ? 'table.visibilityPrivate' : 'team.inventory.filter.all'),
        ],
        [
          'inventory-sort-filter',
          t('team.inventory.sort'),
          t(
            filtered
              ? 'team.inventory.sort.size'
              : 'team.inventory.sort.updated',
          ),
        ],
      ]

      for (const [id, label, value] of pairs) {
        const field = doc.querySelector(`label[for="${id}"]`)!
        expect(field.textContent).toBe(label)
        expect(
          field.closest('.sr-only, .hidden, [hidden], [aria-hidden="true"]'),
        ).toBeNull()
        expect(
          doc.querySelector(`button[role="combobox"]#${id}`)?.textContent,
        ).toBe(value)
      }
    }
  },
)
