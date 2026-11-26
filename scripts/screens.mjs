#!/usr/bin/env node
// Captures the development fixture screens (billing states and regression
// scenarios) from a running dev server, so a UI change can be looked at in
// states the local stack cannot reach on its own.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { newAppBrowserContext } from './lib/browser-analytics.mjs'
import { appFetch, closeAppFetch } from './lib/dev-sign-in.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
}
const THEMES = ['light', 'dark']
const LANGS = ['ja', 'en']

const USAGE = `Usage: pnpm screens [options] [filter...]

Captures fixture screens from a running dev server (start it with pnpm dev).
A filter keeps the screens whose id contains it, for example
"pnpm screens billing" or "pnpm screens past-due near-limit".

Options:
  --base <url>       App origin (default APP_BASE_URL or https://localhost:5173)
  --out <dir>        Output folder (default .screens/<timestamp>)
  --theme <list>     light, dark (default light)
  --viewport <list>  desktop, mobile (default desktop)
  --lang <list>      ja, en (default ja)
  --list             Print the screens and exit
  -h, --help         Show this help`

function list(value, allowed, name) {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  for (const item of items)
    if (!allowed.includes(item))
      throw new Error(`Unknown ${name} "${item}"; use ${allowed.join(', ')}`)
  return items
}

export function parseOptions(argv, env = process.env, now = new Date()) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      out: { type: 'string' },
      theme: { type: 'string', default: 'light' },
      viewport: { type: 'string', default: 'desktop' },
      lang: { type: 'string', default: 'ja' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return {
    help: values.help,
    list: values.list,
    base: values.base ?? env.APP_BASE_URL ?? 'https://localhost:5173',
    out: resolve(values.out ?? join(ROOT, '.screens', stamp)),
    themes: list(values.theme, THEMES, 'theme'),
    viewports: list(values.viewport, Object.keys(VIEWPORTS), 'viewport'),
    langs: list(values.lang, LANGS, 'lang'),
    filters: positionals,
  }
}

export function selectScreens(screens, filters) {
  if (filters.length === 0) return screens
  return screens.filter((screen) =>
    filters.some((filter) => screen.id.includes(filter)),
  )
}

/** One capture per screen and theme, viewport and language. */
export function planCaptures(screens, { themes, viewports, langs }) {
  return screens.flatMap((screen) =>
    langs.flatMap((lang) =>
      viewports.flatMap((viewport) =>
        themes.map((theme) => ({
          lang,
          viewport,
          theme,
          path: screen.themeParameter
            ? `${screen.path}?theme=${theme}`
            : screen.path,
          file: `${screen.id}-${viewport}-${theme}-${lang}.png`,
        })),
      ),
    ),
  )
}

async function readScreens(base) {
  try {
    const response = await appFetch(base, '/dev/screens').catch((error) => {
      throw new Error(
        `No dev server answered at ${base}. Start it with pnpm dev, or pass --base.`,
        { cause: error },
      )
    })
    if (!response.ok)
      throw new Error(
        `${base}/dev/screens answered ${response.status}; is this a dev server?`,
      )
    return (await response.json()).screens
  } finally {
    await closeAppFetch()
  }
}

/** Captures every item and returns the ones that failed. */
async function capture({ base, out }, captures) {
  const require = createRequire(join(ROOT, 'apps/web/package.json'))
  const { chromium } = require('playwright')
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : undefined,
  )
  const failures = []
  try {
    // Locale, viewport and color scheme are context options, so each
    // combination gets its own context.
    const groups = Map.groupBy(
      captures,
      ({ lang, viewport, theme }) => `${lang}|${viewport}|${theme}`,
    )
    for (const items of groups.values()) {
      const { lang, viewport, theme } = items[0]
      const context = await newAppBrowserContext(browser, {
        ignoreHTTPSErrors: true,
        locale: lang,
        colorScheme: theme,
        reducedMotion: 'reduce',
        viewport: VIEWPORTS[viewport],
        deviceScaleFactor: 2,
      })
      try {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        for (const item of items) {
          errors.length = 0
          const response = await page.goto(new URL(item.path, base).href, {
            waitUntil: 'networkidle',
          })
          await page.evaluate(() => document.fonts.ready)
          // A full-page shot leaves fixed bars, such as the mobile tab bar,
          // over the middle of the page; a viewport as tall as the page puts
          // them at its end, where a reader scrolling down meets them.
          await page.setViewportSize({
            width: VIEWPORTS[viewport].width,
            height: await page.evaluate(
              () => document.documentElement.scrollHeight,
            ),
          })
          await page.screenshot({ path: join(out, item.file) })
          await page.setViewportSize(VIEWPORTS[viewport])
          const status = response?.status() ?? 0
          if (status === 200 && errors.length === 0) {
            console.log(`ok   ${item.file}`)
            continue
          }
          failures.push(item)
          console.log(`FAIL ${item.file} (HTTP ${status}) ${errors.join('; ')}`)
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return failures
}

async function main(argv) {
  const options = parseOptions(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const screens = selectScreens(
    await readScreens(options.base),
    options.filters,
  )
  if (screens.length === 0) {
    console.error(`No screen id contains ${options.filters.join(' or ')}.`)
    return 1
  }
  if (options.list) {
    for (const screen of screens)
      console.log(`${screen.id}\t${screen.path}\t${screen.description}`)
    return 0
  }
  const captures = planCaptures(screens, options)
  mkdirSync(options.out, { recursive: true })
  console.log(`Capturing ${captures.length} screens into ${options.out}`)
  const failures = await capture(options, captures)
  console.log(
    failures.length === 0
      ? `Done: ${captures.length} screens in ${options.out}`
      : `${failures.length} of ${captures.length} screens failed`,
  )
  return failures.length === 0 ? 0 : 1
}

if (import.meta.main)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message)
      process.exit(1)
    },
  )
