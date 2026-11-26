import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import type { Locale } from '~/i18n/messages'
const language = vi.hoisted(() => ({ locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
import { SettingsNav } from './+components/settings-nav'

/** The menu as the Settings shell route at `shell` renders it at `path`. */
function renderShell(path: string, nav: ReactNode, shell = 'settings') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={shell} element={nav}>
          <Route path="*" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}
test.each(['en', 'ja'] as const)(
  'ordered purpose groups preserve role visibility in %s',
  (locale) => {
    language.locale = locale
    for (const [admin, kind] of [
      [true, 'upgrade'],
      [true, 'team'],
      [false, 'team'],
    ] as const) {
      const html = renderShell(
        '/settings/inventory/projects',
        <SettingsNav currentUserIsAdmin={admin} workspaceKind={kind}>
          Content
        </SettingsNav>,
      )
      expect(html).toMatch(
        /href="\/settings\/tokens"[^>]*><svg[^>]*tabler-icon-terminal-2/,
      )
      expect(html).toMatch(
        /href="\/settings\/integrations"[^>]*><svg[^>]*tabler-icon-plug/,
      )
      const paths = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
      expect(paths).toEqual([
        '/settings/tokens',
        '/settings/analytics',
        '/settings',
        ...(admin ? ['/settings/bots'] : []),
        '/settings/external-access',
        '/settings/integrations',
        ...(admin ? ['/settings/activity'] : []),
        ...(admin && kind === 'team' ? ['/settings/inventory'] : []),
        '/settings/billing',
        '/settings/general',
      ])
      expect(html.includes(bindI18n(locale).t('settings.group.review'))).toBe(
        admin,
      )
      if (admin && kind === 'team')
        expect(html).toMatch(
          /aria-current="page"[^>]*href="\/settings\/inventory"/,
        )
    }
  },
)

test.each([
  ['/settings/', '/settings', 'Members', 'Workspace'],
  [
    '/settings/general/details',
    '/settings/general',
    'General',
    'Workspace info',
  ],
  ['/settings/unknown', null, 'Settings', null],
])('marks only the matching item for %s', (path, activePath, label, group) => {
  language.locale = 'en'
  const html = renderShell(
    path,
    <SettingsNav currentUserIsAdmin workspaceKind="team">
      Content
    </SettingsNav>,
  )
  const active = [
    ...html.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g),
  ].map((match) => match[1])
  expect(active).toEqual(activePath ? [activePath] : [])
  const trigger = html.match(/<button[^>]*>(.*?)<\/button>/)?.[1]
  expect(trigger?.replace(/<[^>]+>/g, '')).toBe(label + (group ?? ''))
})

test('links and marks items under the route that mounts the shell', () => {
  language.locale = 'en'
  const html = renderShell(
    '/dev/settings/team-member/tokens',
    <SettingsNav currentUserIsAdmin={false} workspaceKind="team">
      Content
    </SettingsNav>,
    'dev/settings/:state',
  )
  const paths = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  expect(paths).toEqual([
    '/dev/settings/team-member/tokens',
    '/dev/settings/team-member/analytics',
    '/dev/settings/team-member',
    '/dev/settings/team-member/external-access',
    '/dev/settings/team-member/integrations',
    '/dev/settings/team-member/billing',
    '/dev/settings/team-member/general',
  ])
  const active = [
    ...html.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g),
  ].map((match) => match[1])
  expect(active).toEqual(['/dev/settings/team-member/tokens'])
})
