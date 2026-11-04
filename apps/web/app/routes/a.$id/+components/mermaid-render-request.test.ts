import { beforeEach, expect, test, vi } from 'vitest'
import { renderMermaidSvg } from '~/lib/mermaid-render.client'
import { renderMermaidRequest } from './mermaid-render-request'

vi.mock('~/lib/mermaid-render.client', () => ({ renderMermaidSvg: vi.fn() }))
beforeEach(() => {
  vi.mocked(renderMermaidSvg).mockReset()
})

test.each([1, 2])('retains all %i rejected results', async (count) => {
  vi.mocked(renderMermaidSvg).mockRejectedValue(new Error('Invalid syntax'))
  const diagrams = Array.from({ length: count }, (_, index) => ({
    id: `A${index}`,
    source: 'invalid',
  }))
  expect(
    await renderMermaidRequest({
      source: 'artifactshare',
      kind: 'mermaid-render-request',
      renderToken: 'token',
      diagrams,
    }),
  ).toEqual(diagrams.map(({ id }) => ({ id, svg: '' })))
})

test('renders mixed results sequentially in request order', async () => {
  let finish!: (svg: string) => void
  vi.mocked(renderMermaidSvg)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockRejectedValueOnce(new Error('Invalid syntax'))
    .mockResolvedValueOnce('<svg/>')
  const pending = renderMermaidRequest({
    source: 'artifactshare',
    kind: 'mermaid-render-request',
    renderToken: 'token',
    diagrams: ['A', 'B', 'C'].map((id) => ({ id, source: id })),
  })
  await vi.waitFor(() => expect(renderMermaidSvg).toHaveBeenCalledTimes(1))
  finish('<svg/>')
  expect(await pending).toEqual([
    { id: 'A', svg: '<svg/>' },
    { id: 'B', svg: '' },
    { id: 'C', svg: '<svg/>' },
  ])
  expect(
    vi.mocked(renderMermaidSvg).mock.calls.map(([source]) => source),
  ).toEqual(['A', 'B', 'C'])
})
