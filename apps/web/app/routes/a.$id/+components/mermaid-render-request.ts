import type { MermaidRenderRequestMessage } from '~/lib/csp-reporter'
import { renderMermaidSvg } from '~/lib/mermaid-render.client'

export async function renderMermaidRequest(
  message: MermaidRenderRequestMessage,
) {
  return await message.diagrams.reduce<
    Promise<Array<{ id: string; svg: string }>>
  >(async (pending, diagram) => {
    // Mermaid diagram renderers share temporary DOM state, so keep the batch sequential.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await pending
    try {
      results.push({
        id: diagram.id,
        svg: await renderMermaidSvg(diagram.source),
      })
    } catch {
      results.push({ id: diagram.id, svg: '' })
    }
    return results
  }, Promise.resolve([]))
}
