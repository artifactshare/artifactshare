import { describe, expect, test } from 'vitest'
import { CLI_ARTIFACT_KINDS_HEADER } from '@artifactshare/contract'
import {
  artifactsListForClient,
  clientUnderstandsPdf,
  resolveForClient,
} from './cli-artifact-kinds'

const request = (header?: string) =>
  new Request('https://example.test/api/cli/artifacts', {
    headers: header ? { [CLI_ARTIFACT_KINDS_HEADER]: header } : {},
  })

const entry = (id: string, artifact_kind: 'pdf' | 'html_page') => ({
  id,
  title: id,
  share_url: `https://example.test/a/${id}`,
  visibility: 'private' as const,
  updated_at: '2026-11-08T00:00:00.000Z',
  project_id: null,
  artifact_kind,
})

describe('responses for clients that predate the PDF kind', () => {
  test('a client names the kinds it understands in the header', () => {
    expect(clientUnderstandsPdf(request('pdf'))).toBe(true)
    expect(clientUnderstandsPdf(request('spa, pdf'))).toBe(true)
    expect(clientUnderstandsPdf(request())).toBe(false)
  })

  test('older clients still list a PDF, without its kind', () => {
    const data = {
      artifacts: [entry('aaaa1111bb', 'pdf'), entry('cccc2222dd', 'html_page')],
      limit: 50,
      has_more: false,
      next_cursor: null,
    }
    const old = artifactsListForClient(data, request())
    expect(old.artifacts.map((item) => item.id)).toEqual([
      'aaaa1111bb',
      'cccc2222dd',
    ])
    expect('artifact_kind' in old.artifacts[0]!).toBe(false)
    expect(old.artifacts[1]!.artifact_kind).toBe('html_page')
    expect(artifactsListForClient(data, request('pdf'))).toEqual(data)
  })

  test('older clients get no PDF resolve candidates', () => {
    const candidate = (id: string, artifact_kind: 'pdf' | 'html_page') => ({
      kind: 'artifact' as const,
      id,
      title: id,
      artifact_kind,
      visibility: 'private' as const,
      project: null,
      owner: { id: 'owner', email: 'owner@example.test' },
      updated_at: '2026-11-08T00:00:00.000Z',
      match: { kind: 'title' as const, confidence: 'exact' as const },
    })
    const data = {
      query: 'deck',
      candidates: [
        candidate('aaaa1111bb', 'pdf'),
        candidate('cccc2222dd', 'html_page'),
      ],
      has_more: false,
    } as Parameters<typeof resolveForClient>[0]
    expect(
      resolveForClient(data, request()).candidates.map((item) => item.id),
    ).toEqual(['cccc2222dd'])
    expect(resolveForClient(data, request('pdf'))).toEqual(data)
  })
})
