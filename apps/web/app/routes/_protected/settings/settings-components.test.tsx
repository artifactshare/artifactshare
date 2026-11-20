import {
  SettingsBanner,
  StatusBanner,
  settingsNotice,
} from './+components/settings-banner'
vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
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
    [0, 100, '0', '0%', false],
    [50, 100, '50', '50%', false],
    [90, 100, '90', '90%', true],
    [100, 100, '100', '100%', true],
    [200, 100, '100', '200%', true],
    [10, 0, '0', 'storage.unavailable', false],
    [10, -1, '0', 'storage.unavailable', false],
    [10, Number.NaN, '0', 'storage.unavailable', false],
    [10, Number.POSITIVE_INFINITY, '0', 'storage.unavailable', false],
  ] as const)(
    'meter %s/%s has bounded fill and an honest visible value',
    (usedBytes, quotaBytes, fill, text, warning) => {
      const html = renderToStaticMarkup(
        <StorageMeter usedBytes={usedBytes} quotaBytes={quotaBytes} />,
      )
      expect(html).toContain(`width:${fill}%`)
      expect(html).toContain('role="progressbar"')
      expect(html).toContain('aria-label="team.usage.storageUsed"')
      expect(html).toContain(`aria-valuetext="${text}"`)
      expect(html).toContain(`>${text}</span>`)
      expect(html).toContain('bg-muted')
      expect(html.includes('bg-warning')).toBe(warning)
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

describe('settings notice outcomes', () => {
  test.each([
    ['ok', 'success'],
    ['removed', 'success'],
    ['checkout-success', 'success'],
    ['plan-change-requested', 'success'],
    ['slack-disconnected', 'success'],
    ['removed-transfer-failed', 'warning'],
    ['checkout-cancelled', 'warning'],
    ['already-subscribed', 'warning'],
    ...[
      'forbidden',
      'self-forbidden',
      'not-team',
      'not-found',
      'invalid',
      'external-failed',
      'restore-unavailable',
      'no-subscription',
      'plan-required',
      'invalid-policy',
      'invalid-patch',
      'billing-unavailable',
      'bot-revoke-not-supported',
      'slack-team-in-use',
      'slack-team-mismatch',
      'unknown',
    ].map((status) => [status, 'error']),
  ])('%s has %s semantics and an icon', (status, kind) => {
    const notice = settingsNotice(status)
    expect(notice.kind).toBe(kind)
    const html = renderToStaticMarkup(<StatusBanner status={status} />)
    expect(html).toContain(kind === 'error' ? 'role="alert"' : 'role="status"')
    expect(html).toContain(
      kind === 'error'
        ? 'tabler-icon-alert-circle'
        : kind === 'warning'
          ? 'tabler-icon-alert-triangle'
          : 'tabler-icon-check',
    )
  })
  test.each([false, true])(
    'warning urgency %s preserves grouped content',
    (urgent) => {
      const html = renderToStaticMarkup(
        <SettingsBanner kind="warning" urgent={urgent}>
          <p>Payment past due</p>
          <p>Update payment</p>
        </SettingsBanner>,
      )
      expect(html).toContain(urgent ? 'role="alert"' : 'role="status"')
      expect(html).toContain('tabler-icon-alert-triangle')
      expect(html).toContain('<p>Payment past due</p><p>Update payment</p>')
    },
  )
})
