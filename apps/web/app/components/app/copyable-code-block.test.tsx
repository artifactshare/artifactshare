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
  test('removes both controls from the tab order when requested', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CopyableCodeBlock
          code="artifactshare init"
          name="Terminal"
          labels={labels}
          copyTabIndex={-1}
        />
      </TooltipProvider>,
    )

    expect(html).toContain('<button')
    expect(html).toContain(
      '<pre data-gap-audit-allow-touch="true" tabindex="-1"',
    )
    expect(html.match(/tabindex="-1"/g) ?? []).toHaveLength(2)
  })
})
