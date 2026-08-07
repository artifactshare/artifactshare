import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test } from 'vitest'
import { NavigationLinkDisabled } from '~/components/app/navigation-link'
import { TeamMuted, TeamMutedParagraph } from '~/components/form/team-muted'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { StorageMeter } from '~/components/form/storage-meter'
import { SettingsSubsection } from '~/components/form/settings-subsection'
import { UsageStat, UsageStats } from './+components/usage-stats'
import { TabNav, TabNavLink } from '~/components/app/tab-nav'
import { IconActivity } from '@tabler/icons-react'

describe('settings shared components', () => {
  test('table empty row preserves span and empty semantics', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <TableEmptyRow colSpan={3}>Empty</TableEmptyRow>
        </tbody>
      </table>,
    )
    expect(html).toContain('colSpan="3"')
    expect(html).toContain('data-slot="empty"')
    expect(html).toContain('Empty')
  })
  test.each([
    [50, 100, '50'],
    [10, 0, '0'],
    [200, 100, '100'],
  ])(
    'storage meter calculates %s/%s as %s%%',
    (usedBytes, quotaBytes, percent) => {
      const html = renderToStaticMarkup(
        <StorageMeter usedBytes={usedBytes} quotaBytes={quotaBytes} />,
      )
      expect(html).toContain(`translateX(-${100 - Number(percent)}%)`)
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('progress-indicator')
    },
  )
  test('settings subsection wires a unique labelled section', () => {
    const html = renderToStaticMarkup(
      <>
        <SettingsSubsection title="General">One</SettingsSubsection>
        <SettingsSubsection title="Billing">Two</SettingsSubsection>
      </>,
    )
    const ids = [
      ...html.matchAll(
        new RegExp('id="(settings-subsection-' + '[^"]+)"', 'g'),
      ),
    ].map(([, id]) => id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(html).toContain(`aria-labelledby="${id}"`)
  })
  test('muted metadata uses the extra-small settings size by default', () => {
    const html = renderToStaticMarkup(<TeamMuted>count</TeamMuted>)
    expect(html).toContain('text-xs')
  })
  test('muted paragraphs use the small settings body size by default', () => {
    const html = renderToStaticMarkup(
      <TeamMutedParagraph>note</TeamMutedParagraph>,
    )
    expect(html).toContain('text-sm')
    expect(html).toContain('text-muted-foreground')
  })

  test('muted paragraphs can be tightened further per call site', () => {
    const html = renderToStaticMarkup(
      <TeamMutedParagraph className="text-xs">note</TeamMutedParagraph>,
    )
    expect(html).toContain('text-xs')
    expect(html).not.toContain('text-sm')
  })

  test('usage stats drop columns on narrow widths and render label/value/extra', () => {
    const html = renderToStaticMarkup(
      <UsageStats columns={4}>
        <UsageStat label="Label" value="Value">
          <p>extra</p>
        </UsageStat>
      </UsageStats>,
    )
    expect(html).toContain('grid-cols-4')
    expect(html).toContain('max-wide:grid-cols-2')
    expect(html).toContain('max-stack:grid-cols-1')
    expect(html).toContain('-mr-px -mb-px')
    expect(html).toContain('border-divider')
    expect(html).toContain('border-r')
    expect(html).toContain('border-b')
    expect(html).toContain('Label')
    expect(html).toContain('Value')
    expect(html).toContain('extra')
  })

  test('disabled navigation entries expose their unavailable state and note', () => {
    const html = renderToStaticMarkup(
      <NavigationLinkDisabled
        icon={IconActivity}
        label="Activity"
        note="(coming soon)"
      />,
    )
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('(coming soon)')
  })

  test('responsive tab navigation keeps narrow links horizontal', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TabNav aria-label="Settings" orientation="responsive">
          <TabNavLink
            to="/settings/general"
            label="General settings"
            orientation="responsive"
          />
        </TabNav>
      </MemoryRouter>,
    )
    // 狭幅は基底 (横ストリップ)、stack 以上で縦タブへ上書きする一方向の構成。
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('after:inset-x-0')
    expect(html).toContain('stack:flex-col')
    expect(html).toContain('stack:after:w-0.5')
    expect(html).toContain('whitespace-nowrap')
  })

  test('active settings link exposes the page location', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/settings/general']}>
        <TabNav aria-label="Settings">
          <TabNavLink to="/settings/general" label="General settings" />
        </TabNav>
      </MemoryRouter>,
    )
    expect(html).toContain('aria-current="page"')
  })
})
