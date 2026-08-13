import {
  evaluateFlagshipFlag,
  type FlagshipSource,
} from './flagship-fallback.server'
import type { MarkdownRenderer } from './markdown-renderer.server'

const TANSTACK_MARKDOWN_FLAG = 'tanstack-markdown'

export async function selectMarkdownRenderer(
  source: FlagshipSource,
  workspaceId: string,
): Promise<MarkdownRenderer> {
  const result = await evaluateFlagshipFlag(source, {
    flagKey: TANSTACK_MARKDOWN_FLAG,
    context: { targetingKey: workspaceId, workspaceId },
  })
  const renderer =
    result.kind !== 'evaluation-error' && result.enabled ? 'tanstack' : 'marked'
  console.info('markdown_renderer_selected', {
    renderer,
    flagResult: result.kind,
  })
  return renderer
}
