import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('local preview isolates scripts and accepts only current bounded display observations', async () => {
  expect(await server.commands.previewSecurity()).toBe(true)
}, 60000)

test('preview primary buttons and document canvases remain readable in both themes', async () => {
  const measurements = await server.commands.previewSecurity('theme')
  expect(measurements.tokens).toHaveLength(4)
  for (const { colorScheme, value } of measurements.tokens)
    expect(value).toBe(colorScheme === 'dark' ? '#111315' : '#ffffff')
  expect(measurements.buttons).toHaveLength(24)
  for (const button of measurements.buttons) {
    if (button.colorScheme === 'dark')
      expect(button.contrast, JSON.stringify(button)).toBeGreaterThanOrEqual(
        4.5,
      )
    else {
      expect(button.foreground).toBe('rgb(255, 255, 255)')
      if (button.state === 'hover')
        expect(button.background).toBe('rgba(55, 53, 47, 0.04)')
    }
  }
  expect(measurements.canvases).toEqual([
    'rgb(255, 255, 255)',
    'rgb(255, 255, 255)',
  ])
  expect(measurements.transparent).toBe('rgba(0, 0, 0, 0)')
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
}, 60000)
