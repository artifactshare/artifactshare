import { afterEach, describe, expect, test, vi } from 'vitest'
import { extractAnchorDocument } from '@artifactshare/viewer-kit/anchor-text'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  createAnchorResolver,
  type StoredAnchor,
} from './comment-anchor-positions.server'
import { renderMarkdownDocument } from '@artifactshare/viewer-kit/markdown-render'
import * as mapping from './comment-anchor-map.server'

const fixtures: ReturnType<typeof createMigratedInMemoryDb>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) await fixture.db.destroy()
})
function createFixture() {
  const fixture = createMigratedInMemoryDb()
  fixtures.push(fixture)
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id,name,created_at) VALUES ('ws1','Workspace','2026-09-01');
    INSERT INTO users (id,email,name,created_at,updated_at,workspace_id) VALUES ('u1','author@example.com','Author','2026-09-01','2026-09-01','ws1');
    INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('c1','ws1','inbox','u1','u1','Home','2026-09-01','2026-09-01');
    INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,created_at,updated_at,container_id) VALUES ('s1','ws1','u1','Report','html_page','private','2026-09-01','2026-09-01','c1');
  `)
  function version(id: string) {
    fixture.sqlite
      .prepare(
        "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at,published_at) VALUES (?,'s1','html_page','published','/index.html',?,12,'hash','u1','2026-09-01','2026-09-01')",
      )
      .run(id, id)
    fixture.sqlite
      .prepare("UPDATE shareables SET current_version_id = ? WHERE id = 's1'")
      .run(id)
  }
  function anchor(id = 'a1', start = 6, quote = 'world'): StoredAnchor {
    fixture.sqlite
      .prepare(
        "INSERT INTO comment_threads (id,shareable_id,status,created_by_id,created_at,updated_at) VALUES (?,'s1','open','u1','2026-09-01','2026-09-01')",
      )
      .run(id)
    fixture.sqlite
      .prepare(
        "INSERT INTO comment_anchors (id,thread_id,version_id,target_path,quoted_text,prefix_text,suffix_text,text_start,text_end,created_at) VALUES (?,?,'v1','/index.html',?,'','',?,?,'2026-09-01')",
      )
      .run(id, id, quote, start, start + quote.length)
    return {
      id,
      version_id: 'v1',
      target_path: '/index.html',
      quoted_text: quote,
      text_start: start,
      text_end: start + quote.length,
    }
  }
  return { ...fixture, version, anchor }
}

describe('lazy anchor progress', () => {
  test('hop exhaustion preserves completed hops and resumes there', async () => {
    const { db, version, anchor } = createFixture()
    for (const id of ['v1', 'v2', 'v3', 'v4']) version(id)
    const saved = anchor()
    const read = vi.fn(async (v: { id: string }) =>
      extractAnchorDocument(
        `<p>${'!'.repeat(Number(v.id.slice(1)) - 1)}Hello world</p>`,
      ),
    )
    const first = createAnchorResolver(db, 's1', 'v4', read, { hops: 1 })
    expect(await first(saved)).toBeNull()
    expect(
      (await db.selectFrom('comment_anchor_positions').selectAll().execute())
        .map((p) => p.version_id)
        .sort(),
    ).toEqual(['v1', 'v2'])
    expect(
      await createAnchorResolver(db, 's1', 'v4', read, { hops: 1 })(saved),
    ).toBeNull()
    expect(
      await createAnchorResolver(db, 's1', 'v4', read, { hops: 1 })(saved),
    ).toEqual({ textStart: 9, textEnd: 14 })
    expect(
      (
        await db.selectFrom('comment_anchor_positions').selectAll().execute()
      ).every((p) => p.reason === null),
    ).toBe(true)
  })
  test('frontier exhaustion never writes absence and later work finishes', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    version('v2')
    const saved = anchor('a1', 0, 'abcdefgh')
    const read = async (v: { id: string }) =>
      extractAnchorDocument(
        v.id === 'v1' ? '<p>abcdefgh</p>' : '<p>abXYefgh</p>',
      )
    expect(
      await createAnchorResolver(db, 's1', 'v2', read, { frontier: 0 })(saved),
    ).toBeNull()
    expect(
      await db
        .selectFrom('comment_anchor_positions')
        .selectAll()
        .where('version_id', '=', 'v2')
        .execute(),
    ).toEqual([])
    expect(
      await createAnchorResolver(db, 's1', 'v2', read, { frontier: 100 })(
        saved,
      ),
    ).toEqual({ textStart: 0, textEnd: 8 })
  })
  test('one transition serves many comments regardless of list ordering', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    version('v2')
    const saved = Array.from({ length: 20 }, (_, i) =>
      anchor(`a${i}`, 6, 'world'),
    )
    const build = vi.spyOn(mapping, 'buildAnchorTransition')
    const read = vi.fn(async (v: { id: string }) =>
      extractAnchorDocument(
        v.id === 'v1' ? '<p>Hello world</p>' : '<p>New: Hello world</p>',
      ),
    )
    const resolver = createAnchorResolver(db, 's1', 'v2', read)
    for (const item of saved.toReversed())
      expect(await resolver(item)).toEqual({ textStart: 11, textEnd: 16 })
    expect(build).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
    const again = createAnchorResolver(db, 's1', 'v2', read)
    for (const item of saved)
      expect(await again(item)).toEqual({ textStart: 11, textEnd: 16 })
    expect(build).toHaveBeenCalledTimes(1)
  })
  test.each([
    ['same', '<p>Hello world</p>', 6, 11],
    ['edited', '<p>New Hello world</p>', 10, 15],
  ] as const)(
    'renamed entrypoint maps %s text and restoration reuses its position',
    async (_, updated, start, end) => {
      const { db, sqlite, version, anchor } = createFixture()
      version('v1')
      const saved = anchor()
      version('v2')
      sqlite.exec(
        "UPDATE versions SET entrypoint_path = '/renamed.html' WHERE id = 'v2'",
      )
      const load = async (v: { id: string }) =>
        extractAnchorDocument(v.id === 'v1' ? '<p>Hello world</p>' : updated)
      expect(await createAnchorResolver(db, 's1', 'v2', load)(saved)).toEqual({
        textStart: start,
        textEnd: end,
      })
      expect(await createAnchorResolver(db, 's1', 'v1', load)(saved)).toEqual({
        textStart: 6,
        textEnd: 11,
      })
    },
  )
  test.each([
    [50, 32],
    [150, 3],
  ])(
    'batches %i anchors over %i versions within a per-hop query budget',
    async (count, hops) => {
      const { db, sqlite, version, anchor } = createFixture()
      for (let i = 1; i <= hops; i++) version(`v${i}`)
      const anchors = Array.from({ length: count }, (_, i) => anchor(`a${i}`))
      const prepare = vi.spyOn(sqlite, 'prepare')
      const load = vi.fn(async (v: { id: string }) =>
        extractAnchorDocument(
          `<p>${'!'.repeat(Number(v.id.slice(1)) - 1)}Hello world</p>`,
        ),
      )
      const results = await createAnchorResolver(
        db,
        's1',
        `v${hops}`,
        load,
      ).resolveMany(anchors.toReversed())
      expect(results).toEqual(
        anchors.map(() => ({ textStart: 5 + hops, textEnd: 10 + hops })),
      )
      expect(prepare.mock.calls.length).toBeLessThan(hops * 12 + 10)
      const writes = prepare.mock.calls.filter(([query]) =>
        /INSERT OR IGNORE INTO comment_anchor_positions/.test(query),
      )
      expect(writes).toHaveLength(hops)
      expect(load).toHaveBeenCalledTimes(hops)
    },
  )
  test('exhausted pairs back off without writing absence and a larger budget retries immediately', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    version('v2')
    const saved = anchor('a1', 0, 'start unchanged end')
    const load = async (v: { id: string }) =>
      extractAnchorDocument(
        v.id === 'v1'
          ? '<p>start unchanged end</p>'
          : '<p>new unchanged last</p>',
      )
    const build = vi.spyOn(mapping, 'buildAnchorTransition')
    expect(
      await createAnchorResolver(db, 's1', 'v2', load, { frontier: 1 })(saved),
    ).toBeNull()
    expect(
      await createAnchorResolver(db, 's1', 'v2', load, { frontier: 1 })(saved),
    ).toBeNull()
    expect(build).toHaveBeenCalledTimes(1)
    expect(
      await createAnchorResolver(db, 's1', 'v2', load, { frontier: 1000 })(
        saved,
      ),
    ).toHaveProperty('textStart')
    expect(build).toHaveBeenCalledTimes(2)
  })
  test.each(['many blocks', 'Japanese'])(
    'large %s snapshots fit in bounded rows and support format transitions',
    async (kind) => {
      const { db, version, anchor } = createFixture()
      version('v1')
      const document =
        kind === 'many blocks'
          ? extractAnchorDocument('<p>x</p>'.repeat(50_000))
          : extractAnchorDocument(`<p>${'日本語'.repeat(220_000)}</p>`)
      const saved = anchor('a1', 0, document.text.slice(0, 1))
      const load = async () => document
      expect(
        await createAnchorResolver(db, 's1', 'v1', load, { format: 'large-a' })(
          saved,
        ),
      ).toEqual({ textStart: 0, textEnd: 1 })
      const rows = await db
        .selectFrom('comment_anchor_documents')
        .selectAll()
        .execute()
      expect(rows.length).toBeGreaterThan(2)
      for (const row of rows)
        expect(new TextEncoder().encode(row.document).byteLength).toBeLessThan(
          1_000_000,
        )
      expect(
        await createAnchorResolver(db, 's1', 'v1', load, { format: 'large-b' })(
          saved,
        ),
      ).toEqual({ textStart: 0, textEnd: 1 })
    },
  )
  test('same-version format changes map saved source positions and switching back reuses them', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    const saved = anchor()
    const original = async () => extractAnchorDocument('<p>Hello world</p>')
    expect(
      await createAnchorResolver(db, 's1', 'v1', original, {
        format: 'format-a',
      })(saved),
    ).toEqual({ textStart: 6, textEnd: 11 })
    expect(
      await createAnchorResolver(
        db,
        's1',
        'v1',
        async () => extractAnchorDocument('<p>New Hello world</p>'),
        { format: 'format-b' },
      )(saved),
    ).toEqual({ textStart: 10, textEnd: 15 })
    const unread = vi.fn(original)
    expect(
      await createAnchorResolver(db, 's1', 'v1', unread, {
        format: 'format-a',
      })(saved),
    ).toEqual({ textStart: 6, textEnd: 11 })
    expect(unread).not.toHaveBeenCalled()
  })
  test('cache write failures do not fail a completed read or erase hop progress', async () => {
    const { db, sqlite, version, anchor } = createFixture()
    version('v1')
    version('v2')
    const saved = anchor()
    sqlite.exec(`
      CREATE TRIGGER reject_document_cache BEFORE INSERT ON comment_anchor_documents
        BEGIN SELECT RAISE(ABORT, 'cache unavailable'); END;
      CREATE TRIGGER reject_transition_cache BEFORE INSERT ON comment_anchor_transitions
        BEGIN SELECT RAISE(ABORT, 'cache unavailable'); END;
    `)
    const result = await createAnchorResolver(db, 's1', 'v2', async (v) =>
      extractAnchorDocument(
        v.id === 'v1' ? '<p>Hello world</p>' : '<p>New Hello world</p>',
      ),
    ).resolveMany([saved])
    expect(result).toEqual([{ textStart: 10, textEnd: 15 }])
    expect(
      await db
        .selectFrom('comment_anchor_positions')
        .select(['version_id', 'reason'])
        .orderBy('version_id')
        .execute(),
    ).toEqual([
      { version_id: 'v1', reason: null },
      { version_id: 'v2', reason: null },
    ])
  })
  test('failed origin loading remains unresolved and supports retry', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    const saved = anchor()
    expect(
      await createAnchorResolver(db, 's1', 'v1', async () => {
        throw new Error('unavailable')
      })(saved),
    ).toBeNull()
    expect(
      await db.selectFrom('comment_anchor_positions').selectAll().execute(),
    ).toEqual([])
    expect(
      await createAnchorResolver(db, 's1', 'v1', async () =>
        extractAnchorDocument('<p>Hello world</p>'),
      )(saved),
    ).toEqual({ textStart: 6, textEnd: 11 })
  })
  test('size limits are per text; two supported large sources can be mapped', async () => {
    const { db, version, anchor } = createFixture()
    version('v1')
    version('v2')
    const text = 'A'.repeat(600_000) + 'world',
      saved = anchor('a1', 600_000, 'world')
    expect(
      await createAnchorResolver(db, 's1', 'v2', async (v) => ({
        text: (v.id === 'v2' ? 'X' : '') + text,
        blocks: [],
      }))(saved),
    ).toEqual({ textStart: 600_001, textEnd: 600_006 })
  })
})

describe('legacy representation coordinates', () => {
  test.each([
    ['textarea duplicate', '<textarea>old </textarea><p>world</p>', 'world', 4],
    [
      'Markdown toolbar',
      renderMarkdownDocument('```js\nconst answer = 42\n```\n\nBelow the code'),
      'Below the code',
      null,
    ],
  ] as const)(
    '%s rejects offsets that only match the historical representation',
    async (_name, source, quote, offset) => {
      const { db, version, anchor } = createFixture()
      version('v1')
      version('v2')
      const canonical = extractAnchorDocument(source)
      const start = offset ?? canonical.text.indexOf(quote) + 'Copy'.length
      expect(start).not.toBe(canonical.text.indexOf(quote))
      const saved = anchor('a1', start, quote)
      const read = async (v: { id: string }) =>
        extractAnchorDocument(v.id === 'v1' ? source : source + '<p>After</p>')
      const origin = await createAnchorResolver(db, 's1', 'v1', read)(saved)
      expect(origin).toEqual({ reason: 'invalid-origin' })
      expect(await createAnchorResolver(db, 's1', 'v2', read)(saved)).toEqual(
        origin,
      )
      expect(saved.text_start).toBe(start)
      const mismatch = anchor('a2', start + 1, quote)
      expect(
        await createAnchorResolver(db, 's1', 'v1', read)(mismatch),
      ).toEqual({ reason: 'invalid-origin' })
    },
  )
})
