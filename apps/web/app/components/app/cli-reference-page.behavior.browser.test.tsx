import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { TooltipProvider } from '~/components/ui/tooltip'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceContent,
  cliReferenceUsage,
} from '~/lib/cli-reference-content'
import { writeClipboardText } from '~/lib/clipboard'
import surface from '~/lib/cli-reference-surface.generated.json'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { CliReferencePage } from './cli-reference-page'
import '~/app.css'

const context = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(context.locale),
}))

vi.mock('~/lib/clipboard', () => ({ writeClipboardText: vi.fn() }))

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  vi.mocked(writeClipboardText).mockReset()
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
    host.querySelector<HTMLParagraphElement>(
      '#introduction [data-cli-option-list]',
    )!,
    ...host.querySelectorAll<HTMLParagraphElement>(
      '#commands article > [data-cli-option-list]',
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

function usageNodes() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '#introduction code, #commands article > code',
    ),
  ]
}

function textRects(code: HTMLElement) {
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    // pre-wrap may hang trailing spaces outside the line; measure visible tokens.
    for (const match of node.textContent!.matchAll(/\S+/g)) {
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      rects.push(...range.getClientRects())
    }
    node = walker.nextNode()
  }
  expect(rects.length).toBeGreaterThan(0)
  return rects
}

function expectCodeFits(code: HTMLElement, container: HTMLElement) {
  // Examples scroll at the pre; Usage code is itself a block container.
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1)
  const bounds = container.getBoundingClientRect()
  const style = getComputedStyle(container)
  const left =
    bounds.left +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.paddingLeft)
  const right =
    bounds.right -
    parseFloat(style.borderRightWidth) -
    parseFloat(style.paddingRight)
  const top =
    bounds.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
  const bottom =
    bounds.bottom -
    parseFloat(style.borderBottomWidth) -
    parseFloat(style.paddingBottom)
  // Permit one CSS pixel for font metrics and subpixel rounding.
  for (const rect of textRects(code)) {
    expect(rect.left).toBeGreaterThanOrEqual(left - 1)
    expect(rect.right).toBeLessThanOrEqual(right + 1)
    expect(rect.top).toBeGreaterThanOrEqual(top - 1)
    expect(rect.bottom).toBeLessThanOrEqual(bottom + 1)
  }
}

describe.each(['en', 'ja'] as const)('CLI option layout (%s)', (locale) => {
  for (const theme of ['light', 'dark']) {
    test.each([390, 1440])(
      `wraps every Usage and Example and copies original text at %ipx in ${theme}`,
      async (width) => {
        await mount(locale, width, theme)
        vi.mocked(writeClipboardText).mockResolvedValue(true)
        const content = cliReferenceContent(locale)
        // Japanese inherits the app's phrase-aware breaks when supported.
        const expectedWordBreak =
          locale === 'ja' && CSS.supports('word-break', 'auto-phrase')
            ? 'auto-phrase'
            : 'normal'
        const usages = [
          cliReferenceUsage(
            CLI_REFERENCE_ENTRY_POINT.path,
            CLI_REFERENCE_ENTRY_POINT.usage,
          ),
          ...content.commands.map(({ path }) =>
            cliReferenceUsage(
              path,
              surface.commands.find((command) => command.path === path)!.usage,
            ),
          ),
        ]
        const nodes = usageNodes()
        expect(nodes).toHaveLength(content.commands.length + 1)
        const commandStyle = getComputedStyle(nodes[1])
        for (const side of [
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft',
        ] as const) {
          expect(parseFloat(commandStyle[side])).toBeGreaterThan(0)
          expect(getComputedStyle(nodes[0])[side], side).toBe(
            commandStyle[side],
          )
        }
        nodes.forEach((code, index) => {
          expect(code.textContent).toBe(usages[index])
          expect(getComputedStyle(code).whiteSpace).toBe('pre-wrap')
          expect(getComputedStyle(code).overflowWrap).toBe('anywhere')
          expect(getComputedStyle(code).wordBreak).toBe(expectedWordBreak)
          expectCodeFits(code, code)
          for (const flag of usages[index].match(/--[\w-]+/g) ?? []) {
            expect(optionRects(code, flag), flag).toHaveLength(1)
          }
        })
        const examples = content.commands.filter((command) => command.example)
        const blocks = [
          ...document.querySelectorAll<HTMLPreElement>('#commands article pre'),
        ]
        expect(blocks).toHaveLength(examples.length)
        for (const [index, pre] of blocks.entries()) {
          const code = pre.querySelector('code')!
          expect(code.textContent).toBe(examples[index].example)
          expect(getComputedStyle(code).whiteSpace).toBe('pre-wrap')
          expect(getComputedStyle(code).overflowWrap).toBe('anywhere')
          expect(getComputedStyle(code).wordBreak).toBe(expectedWordBreak)
          expectCodeFits(code, pre)
          expect(pre.hasAttribute('tabindex')).toBe(false)
          for (const flag of examples[index].example!.match(/--[\w-]+/g) ??
            []) {
            expect(optionRects(code, flag), flag).toHaveLength(1)
          }
          const wrapper = pre.parentElement!
          const button = wrapper.querySelector('button')!
          button.click()
          await vi.waitFor(() => {
            expect(writeClipboardText).toHaveBeenNthCalledWith(
              index + 1,
              examples[index].example,
            )
            expect(button.getAttribute('aria-label')).toBe(
              content.copyLabels.copied,
            )
            expect(wrapper.querySelector('[role="status"]')?.textContent).toBe(
              content.copyLabels.copied,
            )
          })
        }
        expect(writeClipboardText).toHaveBeenCalledTimes(examples.length)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          window.innerWidth + 1,
        )
        if (width === 390) {
          for (const path of ['append', 'update']) {
            const index =
              content.commands.findIndex((command) => command.path === path) + 1
            expect(
              new Set(
                textRects(nodes[index]).map((rect) => Math.round(rect.top)),
              ).size,
            ).toBeGreaterThan(1)
            // Ordinary tokens stay intact when they fit the available line.
            expect(optionRects(nodes[index], '<OPTIONS>')).toHaveLength(1)
          }
        }
      },
    )

    test.each([390, 1440])(
      `keeps section headings stronger than command headings at %ipx in ${theme}`,
      async (width) => {
        await mount(locale, width, theme)
        const introduction = getComputedStyle(
          document.querySelector('#introduction-heading')!,
        )
        for (const id of CLI_REFERENCE_SECTION_IDS) {
          const heading = document.querySelector(`#${id}-heading`)!
          const style = getComputedStyle(heading)
          expect(style.fontSize, id).toBe(introduction.fontSize)
          expect(style.fontWeight, id).toBe(introduction.fontWeight)
        }
        const commands = getComputedStyle(
          document.querySelector('#commands-heading')!,
        )
        for (const heading of document.querySelectorAll('#commands h3')) {
          const style = getComputedStyle(heading)
          expect(parseFloat(commands.fontSize)).toBeGreaterThan(
            parseFloat(style.fontSize),
          )
          expect(Number(commands.fontWeight)).toBeGreaterThanOrEqual(
            Number(style.fontWeight),
          )
        }
      },
    )

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

  test('wraps an oversized existing token in narrow Usage and Example containers', async () => {
    await mount(locale, 390, 'light')
    const usage = usageNodes()[0]
    const pre = document.querySelector<HTMLPreElement>('#commands article pre')!
    const example = pre.querySelector('code')!
    const token = 'artifactshare'
    for (const [code, container] of [
      [usage, usage],
      [example, pre],
    ]) {
      const span = [...code.children].find(
        (child) => child.textContent === token,
      )!
      expect(span).toBeDefined()
      code.replaceChildren(span.cloneNode(true))
      container.style.width = '12ch'
    }
    await waitForBrowserLayout()
    for (const [code, container] of [
      [usage, usage],
      [example, pre],
    ]) {
      expect(code.textContent).toBe(token)
      expectCodeFits(code, container)
      expect(textRects(code).length).toBeGreaterThan(1)
    }
  })

  test('negative control detects original non-wrapping Usage and Example overflow', async () => {
    await mount(locale, 390, 'light')
    const usage = usageNodes()[0]
    const pre = document.querySelector<HTMLPreElement>('#commands article pre')!
    const example = pre.querySelector('code')!
    for (const [code, container] of [
      [usage, usage],
      [example, pre],
    ]) {
      expectCodeFits(code, container)
      const originalText = code.textContent
      code.textContent = originalText
      code.style.whiteSpace = 'pre'
      code.style.overflowWrap = 'normal'
      container.style.overflowX = 'auto'
    }
    await waitForBrowserLayout()
    for (const [code, container] of [
      [usage, usage],
      [example, pre],
    ]) {
      expect(container.scrollWidth).toBeGreaterThan(container.clientWidth + 1)
      expect(() => expectCodeFits(code, container)).toThrow()
    }
  })

  test('negative control detects hyphenated flag splits in plain wrapped code', async () => {
    await mount(locale, 390, 'light')
    const usage = usageNodes()[0]
    const pre = document.querySelector<HTMLPreElement>('#commands article pre')!
    const example = pre.querySelector('code')!
    for (const [code, container] of [
      [usage, usage],
      [example, pre],
    ]) {
      // At this width the full flag fits, but only its prefix fits after "npm ".
      code.textContent = 'npm --expected-version --visibility'
      container.style.boxSizing = 'content-box'
      container.style.width = '20ch'
    }
    await waitForBrowserLayout()
    for (const code of [usage, example]) {
      expectCodeFits(code, code === usage ? usage : pre)
      expect(optionRects(code, '--expected-version').length).toBeGreaterThan(1)
    }
  })

  test('keeps generated edit help separate from the option list', async () => {
    const lists = await mount(locale, 390, 'light')
    const edit = lists.find(
      ({ paragraph }) =>
        paragraph.parentElement?.querySelector('h3')?.textContent === 'edit',
    )
    expect(edit).toBeDefined()
    expect(edit!.paragraph.textContent).toBe(edit!.options.join(' · '))
    const help = edit!.paragraph.nextElementSibling
    expect(help?.textContent).toContain('private, workspace, project, or link')
    expect(help?.textContent).toContain(
      'project requires placement in a project',
    )
    expect(help?.hasAttribute('data-cli-option-list')).toBe(false)
  })

  test('negative control detects split flags in plain section body text', async () => {
    await mount(locale, 390, 'light')
    const paragraph = document.querySelector<HTMLElement>('#introduction p')!
    const flag = '--insecure-localhost'
    paragraph.textContent = flag
    // Force a split independently of translated copy and natural break opportunities.
    paragraph.style.width = '4ch'
    paragraph.style.wordBreak = 'break-all'
    paragraph.style.whiteSpace = 'normal'
    await waitForBrowserLayout()
    expect(optionRects(paragraph, flag).length).toBeGreaterThan(1)
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
