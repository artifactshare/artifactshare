import { afterEach, describe, expect, test, vi } from 'vitest'
import { extractAnchorDocument } from '@artifactshare/viewer-kit/anchor-text'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  createAnchorResolver,
  type StoredAnchor,
} from './comment-anchor-positions.server'
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
