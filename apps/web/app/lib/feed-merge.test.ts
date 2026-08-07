import { describe, expect, test } from 'vitest'
import { mergeFeedRows } from './feed-merge'

const view = (
  id: string,
  shareableId: string,
  createdAt: string,
  dayKey: string,
) => ({
  id,
  type: 'artifact_viewed',
  shareableId,
  createdAt,
  dayKey,
})

describe('mergeFeedRows', () => {
  test('merges view aggregates across pages by (shareable, local day), not raw id', () => {
    const page1 = [view('ev-1', 's1', '2026-01-02T14:00:00Z', '2026-01-02')]
    const page2 = [
      view('ev-2', 's1', '2026-01-02T10:00:00Z', '2026-01-02'),
      view('ev-3', 's2', '2026-01-02T09:00:00Z', '2026-01-02'),
    ]
    const merged = mergeFeedRows([page1, page2])
    expect(merged.map((row) => row.id)).toEqual(['ev-1', 'ev-3'])
  })

  test('keeps distinct dayKeys and non-view events separate by id', () => {
    const rows = mergeFeedRows([
      [
        view('ev-1', 's1', '2026-01-02T14:00:00Z', '2026-01-02'),
        view('ev-2', 's1', '2026-01-01T14:00:00Z', '2026-01-01'),
        {
          id: 'c-1',
          type: 'comment_posted',
          shareableId: 's1',
          createdAt: '2026-01-02T14:00:00Z',
          dayKey: '2026-01-02',
        },
      ],
    ])
    expect(rows).toHaveLength(3)
  })

  test('merges mine view digests across pages by local day', () => {
    const digest = (id: string, createdAt: string, dayKey: string) => ({
      ...view(id, 's1', createdAt, dayKey),
      viewedFileCount: 2,
      viewUniqueCount: 1,
    })
    const merged = mergeFeedRows([
      [digest('mine-1', '2026-01-02T14:00:00Z', '2026-01-02')],
      [digest('mine-2', '2026-01-02T10:00:00Z', '2026-01-02')],
    ])
    expect(merged.map((row) => row.id)).toEqual(['mine-1'])
  })

  test('keeps all-slice view rows on the shareable/day key', () => {
    const merged = mergeFeedRows([
      [view('all-1', 's1', '2026-01-02T14:00:00Z', '2026-01-02')],
      [view('all-2', 's2', '2026-01-02T10:00:00Z', '2026-01-02')],
    ])
    expect(merged.map((row) => row.id)).toEqual(['all-1', 'all-2'])
  })

  test('merges version aggregates with a type-specific key', () => {
    const row = (id: string, createdAt: string, dayKey: string) => ({
      id,
      type: 'version_published',
      shareableId: 's1',
      createdAt,
      dayKey,
      versionStart: 2,
    })
    expect(
      mergeFeedRows([
        [row('v-2', '2026-01-02T14:00:00Z', '2026-01-02')],
        [row('v-1', '2026-01-02T10:00:00Z', '2026-01-02')],
      ]),
    ).toHaveLength(1)
  })

  test('merges comment aggregates by actor, shareable, and local day', () => {
    const comment = (id: string, body: string) => ({
      id,
      type: 'comment_posted',
      shareableId: 's1',
      actorId: 'u1',
      createdAt: '2026-01-02T14:00:00Z',
      dayKey: '2026-01-02',
      commentCount: 3,
      commentBody: body,
    })
    expect(
      mergeFeedRows([[comment('c-1', 'latest')], [comment('c-2', 'old')]]),
    ).toHaveLength(1)
  })

  test('does not merge rows with different dayKeys', () => {
    const merged = mergeFeedRows([
      [view('a', 's1', '2026-01-02T23:00:00Z', '2026-01-03')],
      [view('b', 's1', '2026-01-03T01:00:00Z', '2026-01-02')],
    ])
    expect(merged).toHaveLength(2)
  })

  test('merges by dayKey when createdAt falls on a different UTC calendar day', () => {
    const merged = mergeFeedRows([
      [view('late', 's1', '2026-01-02T20:00:00Z', '2026-01-03')],
      [view('early', 's1', '2026-01-03T02:00:00Z', '2026-01-03')],
    ])
    expect(merged.map((row) => row.id)).toEqual(['late'])
  })
})
