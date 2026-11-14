import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('local preview isolates scripts and accepts only current bounded display observations', async () => {
  expect(await server.commands.previewSecurity()).toBe(true)
}, 60000)

test('preview primary buttons and document canvases remain readable in both themes', async () => {
  const measurements = await server.commands.previewSecurity('theme')
  for (const contrast of measurements.textContrast)
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  expect(measurements.tokens).toHaveLength(4)
  for (const { colorScheme, value } of measurements.tokens)
    expect(value).toBe(colorScheme === 'dark' ? '#111315' : '#ffffff')
  expect(measurements.buttons).toHaveLength(32)
  for (const button of measurements.buttons) {
    if (button.state === 'disabled-hover') {
      const defaultButton = measurements.buttons.find(
        (candidate) =>
          candidate.colorScheme === button.colorScheme &&
          candidate.surface === button.surface &&
          candidate.selector === button.selector &&
          candidate.state === 'default',
      )
      expect(button.background, JSON.stringify(button)).toBe(
        defaultButton?.background,
      )
    }
    expect(button.contrast, JSON.stringify(button)).toBeGreaterThanOrEqual(4.5)
    if (button.colorScheme === 'light') {
      expect(button.foreground).toBe('rgb(255, 255, 255)')
    }
  }
  expect(measurements.frameSchemes).toEqual(['light', 'light'])
  expect(measurements.canvases).toEqual([
    'rgb(255, 255, 255)',
    'rgb(255, 255, 255)',
  ])
  expect(measurements.transparent).toBe('rgba(0, 0, 0, 0)')
  expect(
    measurements.recoveryContrast,
    JSON.stringify({ darkMedia: measurements.darkMedia }),
  ).toBeGreaterThanOrEqual(4.5)
  expect(measurements.authored).toBe('rgb(240, 230, 220)')
}, 60000)

test('preview keeps the filename extension and accessible watch status at phone widths', async () => {
  const measurements = await server.commands.previewSecurity('header')
  expect(measurements.map(({ width }) => width)).toEqual([390, 860, 861])
  for (const geometry of measurements) {
    expect(geometry.header).toBe(46)
    expect(geometry.suffixWidth).toBeGreaterThan(0)
    expect(geometry.suffixRight).toBeLessThanOrEqual(geometry.buttonLeft)
    expect(geometry.watch === 'none').toBe(geometry.width <= 860)
    expect(geometry.accessible).toBe('Local preview · Watching for changes')
  }
}, 60000)

test('oversized reporter captures survive shell save, store reopen and preview next', async () => {
  const text = '😀'.repeat(8000) + 'x'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const result = await server.commands.previewSecurity('oversized')
  expect(result.status).toBe(200)
  for (const anchor of [result.stored, result.next]) {
    expect(anchor).not.toHaveProperty('ownText')
    expect(anchor).toMatchObject({
      kind: 'element',
      ownTextHash: hash,
      ownTextExcerpt: text.slice(0, 16000),
    })
  }
  expect(result.next).toEqual(result.stored)
  expect(result.ambiguous).toHaveLength(4)
  for (const anchor of result.ambiguous) {
    expect(anchor.next).toEqual(anchor.stored)
    expect(anchor.stored.ownTextHash).toMatch(/^[a-f0-9]{64}$/)
  }
}, 60000)

test('resized failed drafts keep reachable actions and remain copyable after shutdown', async () => {
  const measurements = await server.commands.previewSecurity('popover')
  expect(measurements).toHaveLength(12)
  for (const result of measurements)
    expect(result.hit, JSON.stringify(result)).toBe(true)
}, 60000)

test('Markdown preview keeps its existing frame color scheme and white background', async () => {
  expect(await server.commands.previewSecurity('markdown-frame')).toEqual([
    { scheme: 'normal', background: 'rgb(255, 255, 255)' },
    { scheme: 'normal', background: 'rgb(255, 255, 255)' },
  ])
}, 60000)

test('actual share popup and mobile keyboard paths retain readable fields, errors and meaningful focus', async () => {
  const measurements = await server.commands.previewSecurity('share')
  expect(measurements).toHaveLength(8)
  for (const result of measurements) {
    expect(result.states).toEqual([
      'form',
      'upload-error',
      'snapshot-failed',
      'auth',
      'done',
    ])
    for (const contrast of result.contrast)
      expect(contrast, JSON.stringify(result)).toBeGreaterThanOrEqual(4.5)
  }
}, 60000)

test('interactive documents can be operated and annotated per screen', async () => {
  const result = await server.commands.previewSecurity('screens')
  const routeCheck = result.checks[4]
  // Only WebKit forbids the History API in the opaque-origin sandbox.
  expect(routeCheck).toBe(
    server.browser === 'webkit'
      ? 'history-api-unavailable'
      : 'restore-history-route',
  )
  expect(result.checks).toEqual([
    'alt-click-operates',
    'same-selector-separate-screens',
    'restore-hash-screen',
    'in-page-fragment',
    routeCheck,
    'unrestorable-orphaned',
    'reload-keeps-screen',
    'highlights-per-screen',
    'restore-default-screen',
  ])
}, 90000)
