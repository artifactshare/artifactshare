import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { TooltipProvider } from '~/components/ui/tooltip'
import {
  CLI_REFERENCE_ENTRY_POINT,
  cliReferenceContent,
} from '~/lib/cli-reference-content'
import surface from '~/lib/cli-reference-surface.generated.json'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { CliReferencePage } from './cli-reference-page'
import '~/app.css'

const context = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(context.locale),
}))

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
  document.documentElement.classList.remove('dark')
})

async function mount(locale: 'en' | 'ja', width: number, theme: string) {
  context.locale = locale
  document.documentElement.lang = locale
  document.documentElement.classList.toggle('dark', theme === 'dark')
  await page.viewport(width, 900)
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root = createRoot(host)
  root.render(
    <MemoryRouter
      initialEntries={[locale === 'ja' ? '/ja/guides/cli' : '/guides/cli']}
    >
      <TooltipProvider delayDuration={300} disableHoverableContent>
        <CliReferencePage locale={locale} />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await vi.waitFor(() =>
    expect(host.querySelector('#commands article')).not.toBeNull(),
  )
  await waitForBrowserLayout()
  const paragraphs = [
    host.querySelector<HTMLParagraphElement>('#introduction p:last-child')!,
    ...host.querySelectorAll<HTMLParagraphElement>(
      '#commands article > p:last-child',
    ),
  ]
  const options = [
    CLI_REFERENCE_ENTRY_POINT.options,
    ...cliReferenceContent(locale).commands.map(
      ({ path }) =>
        surface.commands.find((command) => command.path === path)!.options,
    ),
  ]
  expect(paragraphs).toHaveLength(options.length)
  return paragraphs.map((paragraph, index) => ({
    paragraph,
    options: options[index],
  }))
}

// Measure text itself, so the same check also detects splits in the old joined text node.
function optionRects(paragraph: HTMLElement, option: string) {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const start = node.textContent!.indexOf(option)
    if (start >= 0) {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + option.length)
      return [...range.getClientRects()]
    }
    node = walker.nextNode()
  }
  throw new Error('Missing option: ' + option)
}

describe.each(['en', 'ja'] as const)('CLI option layout (%s)', (locale) => {
  for (const theme of ['light', 'dark']) {
    test.each([390, 1440])(
      `keeps flags intact at %ipx in ${theme}`,
      async (width) => {
        const lists = await mount(locale, width, theme)
        for (const [id, section] of Object.entries(
          cliReferenceContent(locale).sections,
        )) {
          const paragraph = document.querySelector<HTMLElement>(`#${id} p`)!
          expect(paragraph.textContent).toBe(section.body)
          for (const flag of section.body.match(/--[\w-]+/g) ?? []) {
            expect(optionRects(paragraph, flag), `${id}: ${flag}`).toHaveLength(
              1,
            )
            const span = [...paragraph.children].find(
              (child) => child.textContent === flag,
            )!
            expect(span, `${id}: ${flag}`).toBeDefined()
            expect(getComputedStyle(span).whiteSpace).toBe('nowrap')
          }
        }
        const seen = new Set<string>()
        let wrapsBetweenOptions = false
        for (const { paragraph, options } of lists) {
          expect(paragraph.textContent).toBe(options.join(' · '))
          expect(paragraph.children).toHaveLength(options.length)
          const bounds = paragraph.getBoundingClientRect()
          const tops = new Set<number>()
          for (const option of options) {
            seen.add(option)
            const rects = optionRects(paragraph, option)
            expect(rects, option).toHaveLength(1)
            const rect = rects[0]
            expect(rect.left, option).toBeGreaterThanOrEqual(bounds.left - 1)
            expect(rect.right, option).toBeLessThanOrEqual(bounds.right + 1)
            tops.add(Math.round(rect.top))
          }
          wrapsBetweenOptions ||= tops.size > 1
          for (const span of paragraph.children) {
            expect(getComputedStyle(span).display).toBe('inline')
            expect(getComputedStyle(span).whiteSpace).toBe('nowrap')
            const style = getComputedStyle(span)
            const parentStyle = getComputedStyle(paragraph)
            for (const property of [
              'fontFamily',
              'fontSize',
              'fontWeight',
              'color',
              'lineHeight',
            ] as const) {
              expect(style[property]).toBe(parentStyle[property])
            }
          }
        }
        expect(seen.has('--profile')).toBe(true)
        expect(seen.has('--insecure-localhost')).toBe(true)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          window.innerWidth,
        )
        if (width === 390) expect(wrapsBetweenOptions).toBe(true)
      },
    )
  }

  test('negative control detects split flags in plain section body text', async () => {
    await mount(locale, 390, 'light')
    const paragraphs = Object.entries(cliReferenceContent(locale).sections).map(
      ([id, section]) => {
        const paragraph = document.querySelector<HTMLElement>(`#${id} p`)!
        paragraph.textContent = section.body
        return { paragraph, flags: section.body.match(/--[\w-]+/g) ?? [] }
      },
    )
    await waitForBrowserLayout()
    expect(
      paragraphs.some(({ paragraph, flags }) =>
        flags.some((flag) => optionRects(paragraph, flag).length > 1),
      ),
    ).toBe(true)
  })

  test('negative control detects split flags in the original joined-string rendering', async () => {
    const lists = await mount(locale, 390, 'light')
    for (const { paragraph, options } of lists) {
      paragraph.textContent = options.join(' · ')
    }
    await waitForBrowserLayout()
    const split = lists.flatMap(({ paragraph, options }) =>
      options.filter((option) => optionRects(paragraph, option).length > 1),
    )
    expect(split.length).toBeGreaterThan(0)
    expect(
      split.some(
        (option) => option === '--profile' || option === '--insecure-localhost',
      ),
    ).toBe(true)
  })
})
