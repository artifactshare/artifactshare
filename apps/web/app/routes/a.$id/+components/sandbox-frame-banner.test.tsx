import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CspBanner } from './csp-banner'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(state.locale) }
})
const report = {
  id: '1',
  source: 'artifactshare',
  kind: 'csp-violation',
  directive: 'script-src',
  blockedURI: 'eval',
  sourceFile: null,
  lineNumber: null,
  sample: '<script>alert(1)</script>',
  disposition: 'report',
} as const
describe.each(['en', 'ja'] as const)('CSP groups in %s', (locale) => {
  test('environment-only copy never implies the file is broken and samples are escaped', () => {
    state.locale = locale
    const messages = locale === 'en' ? en : ja
    const html = renderToStaticMarkup(
      <CspBanner violations={[{ ...report, classification: 'environment' }]} />,
    )
    expect(html).toContain(messages['csp.banner.environmentSummaryOne'])
    expect(html).toContain(messages['csp.banner.environmentNote'])
    expect(html).not.toContain(messages['csp.banner.summaryOne'])
    expect(html).not.toContain(messages['csp.banner.fileGroup'] + '</summary>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
  test('mixed streams have separate counts and artifact-only reports keep their summary', () => {
    state.locale = locale
    const messages = locale === 'en' ? en : ja
    const artifact = { ...report, classification: 'artifact' as const }
    const html = renderToStaticMarkup(
      <CspBanner
        violations={[
          artifact,
          { ...report, id: '2', classification: 'environment' },
        ]}
      />,
    )
    expect(html).toContain(messages['csp.banner.summaryOne'])
    expect(html).toContain(messages['csp.banner.environmentSummaryOne'])
    const ownOnly = renderToStaticMarkup(<CspBanner violations={[artifact]} />)
    expect(ownOnly).not.toContain(messages['csp.banner.environmentNote'])
    expect(ownOnly).toContain(messages['csp.banner.summaryOne'])
  })
})
test('English/Japanese diagnostic keys and placeholders match', () => {
  const keys = (messages: Record<string, string>) =>
    Object.keys(messages)
      .filter((key) => key.startsWith('csp.banner.'))
      .sort()
  expect(keys(en)).toEqual(keys(ja))
  for (const key of keys(en) as Array<keyof typeof en>)
    expect(ja[key].match(/\{\w+\}/g)).toEqual(en[key].match(/\{\w+\}/g))
})
