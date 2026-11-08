import { describe, expect, test } from 'vitest'
import { CLI_ARTIFACT_KINDS_HEADER } from '@artifactshare/contract'
import {
  artifactsListForClient,
  clientArtifactKinds,
  resolveForClient,
} from './cli-artifact-kinds'

const request = (header?: string) =>
  new Request('https://example.test/api/cli/artifacts', {
    headers:
      header !== undefined ? { [CLI_ARTIFACT_KINDS_HEADER]: header } : {},
  })

type Kind = 'pdf' | 'video' | 'html_page'

const entry = (id: string, artifact_kind: Kind) => ({
  id,
  title: id,
  share_url: `https://example.test/a/${id}`,
  visibility: 'private' as const,
  updated_at: '2026-11-08T00:00:00.000Z',
  project_id: null,
  artifact_kind,
})

const listData = {
  artifacts: [
    entry('aaaa1111bb', 'pdf'),
    entry('bbbb1111cc', 'video'),
    entry('cccc2222dd', 'html_page'),
  ],
  limit: 50,
  has_more: false,
  next_cursor: null,
}

const candidate = (id: string, artifact_kind: Kind) => ({
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

const resolveData = {
  query: 'deck',
  candidates: [
    candidate('aaaa1111bb', 'pdf'),
    candidate('bbbb1111cc', 'video'),
    candidate('cccc2222dd', 'html_page'),
  ],
  has_more: false,
} as Parameters<typeof resolveForClient>[0]

// A released CLI knows the original kinds plus whatever it names.
const ORIGINAL_KINDS = [
  'markdown_page',
  'html_page',
  'static_site',
  'spa',
  'workspace_app',
]

// header → kinds whose list entries keep artifact_kind and whose resolve
// candidates are returned.
const cases: Array<[string | undefined, Kind[]]> = [
  [undefined, ['html_page']],
  ['', ['html_page']],
  ['pdf', ['pdf', 'html_page']],
  ['video', ['video', 'html_page']],
  ['pdf, video', ['pdf', 'video', 'html_page']],
  ['  video ,pdf  ', ['pdf', 'video', 'html_page']],
  ['spa, mp4, Video', ['html_page']],
]

describe('responses for clients that predate the PDF or video kind', () => {
  test('a client names the kinds it understands in the header', () => {
    expect([...clientArtifactKinds(request(' pdf ,video,,'))]).toEqual([
      'pdf',
      'video',
    ])
    expect(clientArtifactKinds(request()).size).toBe(0)
  })

  test.each(cases)(
    'list entries keep only kinds header %j names',
    (header, kept) => {
      const result = artifactsListForClient(listData, request(header))
      // Every row stays listed; only the kind field is withheld.
      expect(result.artifacts.map((item) => item.id)).toEqual(
        listData.artifacts.map((item) => item.id),
      )
      const known = new Set([
        ...ORIGINAL_KINDS,
        ...clientArtifactKinds(request(header)),
      ])
      for (const item of result.artifacts) {
        if (item.artifact_kind) expect(known.has(item.artifact_kind)).toBe(true)
      }
      expect(
        result.artifacts.flatMap((item) =>
          item.artifact_kind ? [item.artifact_kind] : [],
        ),
      ).toEqual(
        listData.artifacts
          .map((item) => item.artifact_kind)
          .filter((kind) => kept.includes(kind)),
      )
      expect(result.limit).toBe(50)
      expect(result.next_cursor).toBeNull()
    },
  )

  test.each(cases)(
    'resolve returns only candidates of kinds header %j names',
    (header, kept) => {
      const result = resolveForClient(resolveData, request(header))
      expect(
        result.candidates.map((item) =>
          'artifact_kind' in item ? item.artifact_kind : null,
        ),
      ).toEqual(
        ['pdf', 'video', 'html_page'].filter((kind) =>
          kept.includes(kind as Kind),
        ),
      )
    },
  )

  test('a client naming both kinds gets the response unchanged', () => {
    expect(artifactsListForClient(listData, request('pdf, video'))).toEqual(
      listData,
    )
    expect(resolveForClient(resolveData, request('pdf, video'))).toEqual(
      resolveData,
    )
  })
})
