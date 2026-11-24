import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const themeCss = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

// The body of the first rule whose selector is `selector`, as declared.
function declarations(selector: string) {
  const start = themeCss.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`theme.css has no ${selector} rule`)
  const body = themeCss.slice(start, themeCss.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
  )
}

const root = declarations(':root')
// Light, explicit dark and system dark all apply to the html element, so a
// dark rule overrides root declarations and root aliases resolve in its scope.
const themes = {
  light: root,
  dark: { ...root, ...declarations("html[data-theme='dark']") },
  'system dark': { ...root, ...declarations("html[data-theme='system']") },
}

function resolve(vars: Record<string, string>, name: string): string {
  const value = vars[name]
  if (value === undefined) throw new Error(`${name} is not declared`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value.trim())
  return alias ? resolve(vars, alias[1]) : value.trim()
}

type Rgba = [number, number, number, number]

function parseColor(value: string): Rgba {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  if (hex) return [...hex.slice(1).map((h) => parseInt(h, 16)), 1] as Rgba
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!rgba) throw new Error(`unsupported colour ${value}`)
  // Legacy `r, g, b, a` and modern `r g b / a` syntax, alpha as a number or %.
  const [r, g, b, alpha = '1'] = rgba[1].trim().split(/\s*[,/]\s*|\s+/)
  const a = alpha.endsWith('%') ? parseFloat(alpha) / 100 : Number(alpha)
  const channels: Rgba = [Number(r), Number(g), Number(b), a]
  // CSS would clamp out-of-range values, so measuring them as written would
  // report a contrast the browser never paints.
  const inRange = channels.every(
    (c, i) => Number.isFinite(c) && c >= 0 && c <= (i === 3 ? 1 : 255),
  )
  if (!inRange) throw new Error(`unmeasurable colour ${value}`)
  return channels
}

function luminance([r, g, b]: Rgba) {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// A translucent border paints over the field's own fill (the background
// extends under the border) and is seen against the surface around the field.
function contrast(boundary: Rgba, fieldFill: Rgba, adjacent: Rgba) {
  const a = boundary[3]
  const painted = boundary.map((c, i) =>
    i === 3 ? 1 : c * a + fieldFill[i] * (1 - a),
  ) as Rgba
  const [hi, lo] = [luminance(painted), luminance(adjacent)].sort(
    (x, y) => y - x,
  )
  return (hi + 0.05) / (lo + 0.05)
}

const surfaces = ['--background', '--card', '--popover', '--muted']

test('the declared --input boundary keeps 3:1 against every field surface', () => {
  const failures: string[] = []
  for (const [theme, vars] of Object.entries(themes)) {
    const boundary = parseColor(resolve(vars, '--input'))
    const colours = surfaces.map((surface) => {
      const colour = parseColor(resolve(vars, surface))
      expect(colour[3], `${theme} ${surface} is opaque`).toBe(1)
      return [surface, colour] as const
    })
    // Fields are transparent or filled with one of the same surfaces.
    for (const [fill, fillColour] of colours) {
      for (const [adjacent, adjacentColour] of colours) {
        const ratio = contrast(boundary, fillColour, adjacentColour)
        if (ratio < 3) {
          failures.push(
            `${theme} ${fill} field on ${adjacent}: ${ratio.toFixed(2)}`,
          )
        }
      }
    }
  }
  expect(failures).toEqual([])
})

describe('the input token stays a field-boundary colour', () => {
  // Assembled at runtime so this file is not itself a utility candidate.
  const fillUtility = new RegExp(
    `(?<![\\w-])${['bg', 'input'].join('-')}(?![\\w-])`,
  )

  const authoredSource = /\.(?:tsx?|jsx?|mjs|css)$/

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? files(path) : [path]
    })
  }

  test('no app or viewer source uses the input colour as a fill', () => {
    // Utilities are authored in these source types under the app and the
    // viewers; every such file is read whole, whatever bytes it contains.
    const offenders = files(appDir)
      .filter((file) => authoredSource.test(file))
      .filter((file) => fillUtility.test(readFileSync(file, 'utf8')))
      .map((file) => relative(appDir, file))
    expect(offenders).toEqual([])
  })
})
