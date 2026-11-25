import { FormData, Window } from 'happy-dom'
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
      expect(doc.querySelector('button[type="submit"]')?.textContent).toBe(
        t('team.inventory.filter.apply'),
      )
      const entries = new FormData(doc.querySelector('form')!)
      expect(entries.getAll('visibility')).toEqual([
        filtered ? 'private' : 'all',
      ])
      expect(entries.getAll('sort')).toEqual([filtered ? 'size' : 'updated'])
      const pairs = [
        [
          t('team.inventory.filter'),
          t(filtered ? 'table.visibilityPrivate' : 'team.inventory.filter.all'),
        ],
        [
          t('team.inventory.sort'),
          t(
            filtered
              ? 'team.inventory.sort.size'
              : 'team.inventory.sort.updated',
          ),
        ],
      ]

      // Each field is reached the way a reader reaches it: by its visible
      // label, which must name the control that carries the selection.
      for (const [label, value] of pairs) {
        const field = Array.from(doc.querySelectorAll('label')).find(
          (candidate) => candidate.textContent === label,
        )!
        expect(field).toBeDefined()
        expect(
          field.closest('.sr-only, .hidden, [hidden], [aria-hidden="true"]'),
        ).toBeNull()
        const control = doc.getElementById(field.getAttribute('for') ?? '')
        expect(control?.getAttribute('role')).toBe('combobox')
        expect(control?.textContent).toBe(value)
      }
    }
  },
)
