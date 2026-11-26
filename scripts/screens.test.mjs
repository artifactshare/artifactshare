import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { parseOptions, planCaptures, selectScreens } from './screens.mjs'

const screens = [
  { id: 'billing-team-past-due', path: '/dev/settings/team-past-due/billing' },
  {
    id: 'billing-free-near-limit',
    path: '/dev/settings/free-near-limit/billing',
  },
  {
    id: 'scenario-landing-default',
    path: '/dev/scenarios/landing-default',
    themeParameter: true,
  },
]

test('defaults to one light desktop Japanese capture per screen', () => {
  const options = parseOptions([], {}, new Date('2026-11-26T01:02:03.456Z'))
  assert.equal(options.base, 'https://localhost:5173')
  assert.deepEqual(options.themes, ['light'])
  assert.deepEqual(options.viewports, ['desktop'])
  assert.deepEqual(options.langs, ['ja'])
  assert.equal(
    options.out,
    resolve(import.meta.dirname, '..', '.screens', '2026-11-26T01-02-03'),
  )
})

test('reads the origin from APP_BASE_URL unless --base names one', () => {
  const env = { APP_BASE_URL: 'https://localhost:35819' }
  assert.equal(parseOptions([], env).base, 'https://localhost:35819')
  assert.equal(
    parseOptions(['--base', 'https://localhost:4000'], env).base,
    'https://localhost:4000',
  )
})

test('refuses a theme, viewport or language it cannot capture', () => {
  assert.throws(() => parseOptions(['--theme', 'sepia']), /Unknown theme/)
  assert.throws(() => parseOptions(['--viewport', 'tv']), /Unknown viewport/)
  assert.throws(() => parseOptions(['--lang', 'fr']), /Unknown lang/)
})

test('keeps the screens whose id contains any filter', () => {
  assert.deepEqual(
    selectScreens(screens, ['past-due', 'near-limit']).map(({ id }) => id),
    ['billing-team-past-due', 'billing-free-near-limit'],
  )
  assert.equal(selectScreens(screens, []).length, 3)
})

test('plans one capture per screen and combination', () => {
  const captures = planCaptures(
    screens,
    parseOptions([
      '--theme',
      'light,dark',
      '--viewport',
      'desktop,mobile',
      '--lang',
      'ja,en',
    ]),
  )
  assert.equal(captures.length, 3 * 2 * 2 * 2)
  assert.equal(new Set(captures.map(({ file }) => file)).size, captures.length)
  const path = (file) => captures.find((item) => item.file === file)?.path
  // Scenarios take the theme from the URL; other screens from the browser.
  assert.equal(
    path('scenario-landing-default-mobile-dark-en.png'),
    '/dev/scenarios/landing-default?theme=dark',
  )
  assert.equal(
    path('billing-team-past-due-mobile-dark-en.png'),
    '/dev/settings/team-past-due/billing',
  )
})
