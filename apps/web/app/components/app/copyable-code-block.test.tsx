import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { CopyableCodeBlock } from './copyable-code-block'

const labels = {
  copy: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
}

const block = (props: { wrap?: boolean; copyTabIndex?: number }) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CopyableCodeBlock
        code="artifactshare init"
        name="Terminal"
        labels={labels}
        {...props}
      />
    </TooltipProvider>,
  )

const pre = (html: string) => html.match(/<pre[^>]*>/)![0]
const preStyling = (html: string) => pre(html).match(/class="([^"]*)"/)![1]

describe('CopyableCodeBlock', () => {
  test.each([false, true])(
    'removes both controls from the tab order when wrap=%s',
    (wrap) => {
      const html = block({ wrap, copyTabIndex: -1 })

      expect(html).toContain('<button')
      expect(pre(html).includes('tabindex="-1"')).toBe(!wrap)
      expect(html.match(/tabindex="-1"/g) ?? []).toHaveLength(wrap ? 1 : 2)
    },
  )

  // A block that does not wrap is scrolled instead, which is why only that one
  // is a focus stop. Which utilities do it is checked by the visual suite; what
  // is asserted here is that the choice reaches the element that scrolls, so a
  // focusable block cannot end up with nothing to scroll.
  test('a wrapping block and a scrolling block are laid out differently', () => {
    expect(preStyling(block({ wrap: true }))).not.toBe(
      preStyling(block({ wrap: false })),
    )
  })
})

test.each([undefined, false, true])(
  'preserves text and whitespace policy with wrap=%s',
  (wrap) => {
    const code =
      'artifactshare update <target>  --expected-version <version-id>\n  --json'
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CopyableCodeBlock
          code={code}
          name="Terminal"
          labels={labels}
          wrap={wrap}
        />
      </TooltipProvider>,
    )
    const rendered = html.match(/<code class="([^"]*)">([\s\S]*?)<\/code>/)!
    expect(rendered[2].replace(/<[^>]+>/g, '')).toBe(
      renderToStaticMarkup(<>{code}</>),
    )
    expect(html.match(/<pre[^>]*>/)![0].includes('tabindex=')).toBe(!wrap)
    // Wrapping keeps a long flag in one piece by giving it its own span.
    if (wrap)
      expect(rendered[2]).toMatch(/<span[^>]*>--expected-version<\/span>/)
  },
)
