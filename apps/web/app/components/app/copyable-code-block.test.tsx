import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { CopyableCodeBlock } from './copyable-code-block'

const labels = {
  copy: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
}

describe('CopyableCodeBlock', () => {
  test.each([false, true])(
    'removes both controls from the tab order when wrap=%s',
    (wrap) => {
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <CopyableCodeBlock
            code="artifactshare init"
            name="Terminal"
            labels={labels}
            copyTabIndex={-1}
            wrap={wrap}
          />
        </TooltipProvider>,
      )

      expect(html).toContain('<button')
      expect(html).toContain(
        '<pre data-gap-audit-allow-touch="true" tabindex="-1"',
      )
      expect(html.match(/tabindex="-1"/g) ?? []).toHaveLength(2)
    },
  )
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
    const pre = html.match(/<pre[^>]*class="([^"]*)"/)![1].split(/\s+/)
    const rendered = html.match(/<code class="([^"]*)">([\s\S]*?)<\/code>/)!
    const classes = rendered[1].split(/\s+/)
    expect(rendered[2]).toBe(renderToStaticMarkup(<>{code}</>))
    expect(classes).toContain(wrap ? 'whitespace-pre-wrap' : 'whitespace-pre')
    expect(classes.includes('whitespace-pre')).toBe(!wrap)
    expect(classes.includes('[overflow-wrap:anywhere]')).toBe(Boolean(wrap))
    expect(pre.includes('overflow-x-auto')).toBe(!wrap)
    expect(html).toContain('tabindex="0"')
  },
)
