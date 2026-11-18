import {
  prepareQuery,
  bindAllowedIds,
  SearchCapacityError,
  type IndexSearchResult,
  literalKey,
  groupKey,
  excerpt,
  type IndexSearchInput,
  type SearchTier,
} from '../app/services/search-index/query'
import { DurableObject } from 'cloudflare:workers'
import {
  isSearchIndexLocation,
  SEARCH_INDEX_LOCATIONS,
  searchIndexName,
  type SearchIndexLocation,
} from '../app/services/search-index/names'
import { createDb, type Db } from '../app/services/db.server'
import {
  inventory,
  fingerprint,
  contentFingerprint,
  displayTitle,
  type Source,
} from '../app/services/search-index/inventory.server'
import {
  extractPage,
  isMarkdownPath,
  extractLocalStrings,
  type ExtractedText,
} from '../app/services/search-index/extract'
import {
  INDEX_FORMAT_VERSION,
  BM25_WEIGHTS,
  KATAKANA_WEIGHT,
  katakanaRuns,
  normalizeSearchText,
  packTokens,
  phraseSeam,
  snippet,
  splitUtf8,
  COLUMN_BYTES,
} from '../app/services/search-index/normalize'
import {
  searchTextKey,
  shareableSearchPrefix,
  workspaceSearchPrefix,
} from '../app/services/search-index/keys'

type State = {
  workspace: string
  cursor: string
  sweep: string
  dirty: number
  recent_time: string
  recent_id: string
}
type Active = {
  id: string
  generation: string
  fingerprint: string
  content: string
  format: number
}
const BATCH = 5

/** Internal RPC only. No search endpoint or authorization copies. */
export class WorkspaceSearchIndex extends DurableObject<Cloudflare.Env> {
  private running = false
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', sweep TEXT NOT NULL DEFAULT '', recent_time TEXT NOT NULL DEFAULT '', recent_id TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS active (id TEXT PRIMARY KEY, generation TEXT NOT NULL, fingerprint TEXT NOT NULL, content TEXT NOT NULL, format INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, attempted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS staging (id TEXT PRIMARY KEY, generation TEXT NOT NULL, fingerprint TEXT NOT NULL, format INTEGER NOT NULL, expected_documents INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cleanup (id TEXT PRIMARY KEY, cursor TEXT, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reclaims (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS intentions (key TEXT PRIMARY KEY, shareable TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, shareable TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, generation TEXT NOT NULL, owner TEXT NOT NULL, container TEXT NOT NULL, updated_at TEXT NOT NULL, normalized_title TEXT NOT NULL, expected_chunks INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, UNIQUE(shareable,generation,path));
      CREATE INDEX IF NOT EXISTS documents_generation ON documents(shareable, generation);
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, document INTEGER NOT NULL, ordinal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title, body, script);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_runs USING fts5(katakana);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_seams USING fts5(title, body, script);
      CREATE TABLE IF NOT EXISTS snippets (document INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(document, ordinal));
      CREATE VIEW IF NOT EXISTS serving_chunks AS SELECT c.id, d.shareable, d.version, d.path FROM chunks c JOIN documents d ON d.id=c.document JOIN active a ON a.id=d.shareable AND a.generation=d.generation;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version(version) VALUES(1);
    `)
    const columns = new Set(
      ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(documents)')
        .toArray()
        .map((row) => row.name),
    )
    if (!columns.has('title_key'))
      ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN title_key TEXT NOT NULL DEFAULT ''",
      )
    if (!columns.has('activity_at'))
      ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN activity_at TEXT NOT NULL DEFAULT ''",
      )
    if (!columns.has('group_key'))
      ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN group_key TEXT NOT NULL DEFAULT ''",
      )
    ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS documents_group_key ON documents(group_key)',
    )
    // Thrown failures per pending item; budget yields do not count.
    if (
      !ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(pending)')
        .toArray()
        .some((row) => row.name === 'failures')
    )
      ctx.storage.sql.exec(
        'ALTER TABLE pending ADD COLUMN failures INTEGER NOT NULL DEFAULT 0',
      )
    // When a placed index reported its first full reconciliation as ready.
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS placement (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ready_at TEXT NOT NULL)',
    )
    // Remove the prior persisted query cache and its invalidation triggers.
    for (const table of ['documents', 'chunks', 'active'])
      for (const event of ['INSERT', 'UPDATE', 'DELETE'])
        ctx.storage.sql.exec(
          `DROP TRIGGER IF EXISTS invalidate_query_${table}_${event}`,
        )
    ctx.storage.sql
      .exec(`DROP TABLE IF EXISTS query_results; DROP TABLE IF EXISTS query_cache; DROP TABLE IF EXISTS query_allowed_ids;
      CREATE INDEX IF NOT EXISTS chunks_document_ordinal ON chunks(document,ordinal);`)
  }
  /** Build one SQL ranking over the requested document set, never JS-wide row arrays. */
  #matchingPages(input: IndexSearchInput, details = false, titleOnly = false) {
    const query = prepareQuery(input.query)
    const filters: string[] = []
    const bindings: Array<string | number> = []
    if (titleOnly) {
      filters.push('instr(d.title_key,?)>0')
      bindings.push(query.literal)
    }
    if (input.allowedIds !== undefined) {
      const arrays = bindAllowedIds(input.allowedIds)
      filters.push(
        '(' +
          arrays
            .map(() => 'd.shareable IN (SELECT value FROM json_each(?))')
            .join(' OR ') +
          ')',
      )
      bindings.push(...arrays)
    }
    for (const [column, values] of [
      ['d.owner', input.ownerUserIds],
      ['d.container', input.containerIds],
    ] as const)
      if (values !== undefined) {
        filters.push(`${column} IN (SELECT value FROM json_each(?))`)
        bindings.push(JSON.stringify(values))
      }
    if (input.groupKeys) {
      filters.push('d.group_key IN (SELECT value FROM json_each(?))')
      bindings.push(JSON.stringify(input.groupKeys))
    }
    if (input.updated?.from) {
      filters.push("strftime('%Y-%m-%dT%H:%M:%fZ',d.activity_at)>=?")
      bindings.push(input.updated.from)
    }
    if (input.updated?.to) {
      filters.push("strftime('%Y-%m-%dT%H:%M:%fZ',d.activity_at)<?")
      bindings.push(input.updated.to)
    }
    if (!query.blank && !query.terms.length) filters.push('0')
    const order =
      query.blank || input.sort === 'newest'
        ? 'activityAt DESC,id'
        : 'tierNumber,score,id'
    const phrase =
      '{title body script}: "' + query.phrase.replaceAll('"', '""') + '"'
    const statement = `WITH filtered AS MATERIALIZED (
      SELECT d.id AS document,d.shareable AS id,d.path,d.title_key,d.group_key,coalesce(strftime('%Y-%m-%dT%H:%M:%fZ',d.activity_at),'') AS activityAt
      FROM documents d JOIN active a ON a.id=d.shareable AND a.generation=d.generation ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ), token_hits AS MATERIALIZED (
      SELECT search.rowid AS chunk,t.key AS term,bm25(search,?,?,?) AS score
      FROM json_each(?) t CROSS JOIN search WHERE search MATCH t.value
    ), run_hits AS MATERIALIZED (
      SELECT search_runs.rowid AS chunk,t.key AS term,bm25(search_runs,?) AS score
      FROM json_each(?) t CROSS JOIN search_runs WHERE search_runs MATCH t.value
    ), phrase_hits AS MATERIALIZED (
      SELECT rowid AS chunk FROM search WHERE search MATCH ?
    ), seam_hits AS MATERIALIZED (
      SELECT rowid AS chunk FROM search_seams WHERE search_seams MATCH ?
    ), phrase_documents AS MATERIALIZED (
      SELECT DISTINCT c.document FROM phrase_hits h JOIN chunks c ON c.id=h.chunk
      UNION SELECT c.document FROM seam_hits h JOIN chunks c ON c.id=h.chunk
    ), raw_hits AS (
      SELECT c.document,h.term,h.score FROM token_hits h JOIN chunks c ON c.id=h.chunk JOIN filtered d ON d.document=c.document
      UNION ALL
      SELECT c.document,h.term,h.score FROM run_hits h JOIN chunks c ON c.id=h.chunk JOIN filtered d ON d.document=c.document
    ), evidence AS (
      SELECT document,count(DISTINCT term) AS terms,sum(score) AS score FROM raw_hits GROUP BY document
    ), candidates AS MATERIALIZED (
      SELECT d.*,coalesce(e.score,0) AS score,instr(d.title_key,?)>0 AS literal
      FROM filtered d LEFT JOIN evidence e ON e.document=d.document
      WHERE ${query.blank ? '1 OR' : ''} ${input.any ? 'e.terms>0' : 'e.terms=?'} OR ${query.blank ? '0' : 'instr(d.title_key,?)>0'}
    ), tiers AS (
      SELECT d.*,CASE WHEN ${input.any ? '1' : '0'} THEN 3 WHEN ${query.blank ? '0' : 'd.literal'} THEN 0
      WHEN ${titleOnly ? '0' : 'p.document IS NOT NULL'} THEN 1 ELSE 2 END AS tierNumber
      FROM candidates d ${titleOnly ? '' : 'LEFT JOIN phrase_documents p ON p.document=d.document'}
    ), pages AS (
      SELECT *,row_number() OVER(PARTITION BY id ORDER BY tierNumber,score,path) AS page FROM tiers
    )${
      !details && input.maxResults !== undefined
        ? `, top_pages AS MATERIALIZED (
      SELECT * FROM pages WHERE page=1 ORDER BY ${order} LIMIT ?
    )`
        : ''
    } SELECT ${details ? '' : `row_number() OVER(ORDER BY ${order}) AS rank,`}id,document,path,
      CASE tierNumber WHEN 0 THEN 'title' WHEN 1 THEN 'phrase' WHEN 2 THEN 'all' ELSE 'any' END AS tier,activityAt
      ${input.groupKeys ? ',group_key AS groupKey,row_number() OVER(PARTITION BY group_key ORDER BY ' + order + ') AS groupRank' : ''}
      FROM ${!details && input.maxResults !== undefined ? 'top_pages' : 'pages WHERE page=1'} ${details ? '' : input.maxResults !== undefined ? 'ORDER BY rank' : 'ORDER BY rank LIMIT ?'}`
    // Keep binding order explicit: MATCH terms are data, never query syntax from callers.
    return {
      statement,
      bindings: [
        ...bindings,
        ...BM25_WEIGHTS,
        JSON.stringify(query.expressions),
        KATAKANA_WEIGHT,
        JSON.stringify(query.runExpressions),
        phrase,
        phrase,
        query.literal,
        ...(input.any ? [] : [query.terms.length]),
        ...(query.blank ? [] : [query.literal]),
        ...(details ? [] : [input.maxResults ?? -1]),
      ],
    }
  }

  search(input: IndexSearchInput): IndexSearchResult {
    try {
      return this.searchPage(input)
    } catch (error) {
      if (error instanceof SearchCapacityError)
        return { error: { code: 'search_capacity_exceeded' } }
      throw error
    }
  }
  private searchPage(input: IndexSearchInput) {
    const { cursor = 0, limit: requestedLimit = 2000, ...criteria } = input
    const limit = Math.max(1, Math.min(2000, requestedLimit))
    const read = (titleOnly: boolean) => {
      const query = this.#matchingPages(criteria, false, titleOnly)
      return this.ctx.storage.sql
        .exec<{
          id: string
          tier: SearchTier
          rank: number
          activityAt: string
        }>(
          `SELECT id,tier,rank,activityAt FROM (${query.statement}) WHERE rank>? ORDER BY rank LIMIT ?`,
          ...query.bindings,
          cursor,
          limit + 1,
        )
        .toArray()
    }
    // Literal-title hits precede every other tier. A full window plus its witness
    // proves that lower tiers cannot change this bounded relevance page.
    const titles =
      criteria.maxResults !== undefined &&
      criteria.sort !== 'newest' &&
      !criteria.any &&
      criteria.query.trim()
        ? read(true)
        : []
    const rows = titles.length > limit ? titles : read(false)
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? cursor + limit : null,
      ...(input.includeActiveDocumentCount
        ? {
            activeDocumentCount: this.ctx.storage.sql
              .exec<{ n: number }>('SELECT count(*) AS n FROM active')
              .one().n,
          }
        : {}),
    }
  }

  groupMembers(input: IndexSearchInput, keys: string[]): IndexSearchResult {
    try {
      const query = this.#matchingPages({ ...input, groupKeys: keys })
      const cursor = Math.max(0, input.cursor ?? 0)
      const end = cursor + 2000
      // Per-key pages let the caller count authorized members, not index rows.
      const rows = this.ctx.storage.sql
        .exec<{
          id: string
          tier: SearchTier
          rank: number
          activityAt: string
          groupKey: string
          groupRank: number
        }>(
          `SELECT * FROM (${query.statement}) WHERE groupRank>? AND groupRank<=?`,
          ...query.bindings,
          cursor,
          end + 1,
        )
        .toArray()
      return {
        items: rows
          .filter((row) => row.groupRank <= end)
          .map(({ id, tier, rank, activityAt }) => ({
            id,
            tier,
            rank,
            activityAt,
          })),
        nextCursor: null,
        incompleteGroupKeys: [
          ...new Set(
            rows
              .filter((row) => row.groupRank > end)
              .map((row) => row.groupKey),
          ),
        ],
      }
    } catch (error) {
      if (error instanceof SearchCapacityError)
        return { error: { code: 'search_capacity_exceeded' } }
      throw error
    }
  }

  /**
   * Temporary placement check: no index work, and the Cloudflare location
   * this object runs in, read once from the trace endpoint.
   */
  #colo: Promise<string> | undefined
  placement(): Promise<string> {
    this.#colo ??= fetch('https://www.cloudflare.com/cdn-cgi/trace')
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => /^colo=(\w+)$/m.exec(text)?.[1] ?? 'unknown')
      .catch(() => 'unknown')
    return this.#colo
  }

  details(
    input: IndexSearchInput,
    ids: string[],
  ): Array<{
    id: string
    path: string
    excerpt: string
    hasBody: boolean
    matchedKeywords: string[]
  }> {
    const query = this.#matchingPages({ ...input, allowedIds: ids }, true)
    const rows = this.ctx.storage.sql
      .exec<{ id: string; document: number; path: string }>(
        query.statement,
        ...query.bindings,
      )
      .toArray()
    const matchedById = new Map(ids.map((id) => [id, new Set<string>()]))
    const sameAsPages = (other: typeof query) =>
      other.statement === query.statement &&
      JSON.stringify(other.bindings) === JSON.stringify(query.bindings)
    for (const term of prepareQuery(input.query).terms) {
      const evidence = this.#matchingPages(
        { ...input, query: term, any: false, allowedIds: ids },
        true,
      )
      // A single-term search builds this same query again; its rows are the
      // page rows already read, so the index is not searched twice.
      const matches = sameAsPages(evidence)
        ? rows
        : this.ctx.storage.sql
            .exec<{ id: string }>(evidence.statement, ...evidence.bindings)
            .toArray()
      for (const match of matches) matchedById.get(match.id)?.add(term)
    }
    return rows.map((row) => {
      const body = this.ctx.storage.sql
        .exec<{ body: string }>(
          'SELECT body FROM snippets WHERE document=? ORDER BY ordinal',
          row.document,
        )
        .toArray()
        .map((part) => part.body)
        .join('')
      const matchedKeywords = [...(matchedById.get(row.id) ?? [])]
      return {
        id: row.id,
        path: row.path,
        excerpt: excerpt(body, input.query),
        hasBody: Boolean(body.trim()),
        matchedKeywords,
      }
    })
  }

  /** Shared ingestion writer; protected so the test subclass uses identical FTS seams. */
  protected writeChunk(document: number, ordinal: number, columns: string[][]) {
    this.ctx.storage.transactionSync(() => {
      const id = this.ctx.storage.sql
        .exec<{ id: number }>(
          'INSERT INTO chunks(document,ordinal) VALUES(?,?) RETURNING id',
          document,
          ordinal,
        )
        .one().id
      this.ctx.storage.sql.exec(
        'INSERT INTO search(rowid,title,body,script) VALUES(?,?,?,?)',
        id,
        columns[0][ordinal] ?? '',
        columns[1][ordinal] ?? '',
        columns[2][ordinal] ?? '',
      )
      if (ordinal > 0)
        this.ctx.storage.sql.exec(
          'INSERT INTO search_seams(rowid,title,body,script) VALUES(?,?,?,?)',
          id,
          ...columns
            .slice(0, 3)
            .map((column) =>
              phraseSeam(column[ordinal - 1] ?? '', column[ordinal] ?? ''),
            ),
        )
      this.ctx.storage.sql.exec(
        'INSERT INTO search_runs(rowid,katakana) VALUES(?,?)',
        id,
        columns[3][ordinal] ?? '',
      )
    })
  }

  #location: { value: SearchIndexLocation | undefined } | undefined
  /**
   * The location this placed index was created for, or undefined for the
   * legacy index. Derived from the object's own name, which sync() checks.
   */
  private location(): SearchIndexLocation | undefined {
    if (this.#location) return this.#location.value
    const workspace = this.state()?.workspace
    if (!workspace) return undefined
    const value = SEARCH_INDEX_LOCATIONS.find((location) =>
      this.ctx.id.equals(
        this.env.WORKSPACE_SEARCH_INDEX.idFromName(
          searchIndexName(workspace, location),
        ),
      ),
    )
    this.#location = { value }
    return value
  }

  private state(): State | undefined {
    return this.ctx.storage.sql
      .exec<State>(
        'SELECT workspace, cursor, sweep, dirty, recent_time, recent_id FROM state WHERE singleton=1',
      )
      .toArray()[0]
  }
  /**
   * A placed index reports once that its first full reconciliation finished:
   * the D1 scan reached the end, nothing is staged, and every pending item
   * has either finished or failed at least three times. Searches move to it
   * then; the report is never withdrawn.
   */
  private async reportReady(db: Db, state: State): Promise<void> {
    const location = this.location()
    if (!location || state.cursor) return
    const blocked = this.ctx.storage.sql
      .exec<{ blocked: number }>(
        // An item that failed three times keeps its staging row while it
        // retries; it no longer holds back readiness.
        'SELECT (EXISTS(SELECT 1 FROM placement) OR EXISTS(SELECT 1 FROM pending WHERE failures < 3) OR EXISTS(SELECT 1 FROM staging s WHERE NOT EXISTS(SELECT 1 FROM pending p WHERE p.id=s.id AND p.failures >= 3))) AS blocked',
      )
      .one().blocked
    if (blocked) return
    const readyAt = new Date().toISOString()
    await db
      .updateTable('search_index_workspaces')
      .set({ ready_at: readyAt })
      .where('workspace_id', '=', state.workspace)
      .where('location_hint', '=', location)
      .where('ready_at', 'is', null)
      .execute()
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO placement(singleton,ready_at) VALUES(1,?)',
      readyAt,
    )
  }

  /** location is set only for the index placed near the workspace's members. */
  async sync(workspace: string, location?: SearchIndexLocation): Promise<void> {
    workspaceSearchPrefix(workspace)
    if (location !== undefined && !isSearchIndexLocation(location))
      throw new Error('search_partition_mismatch')
    const state = this.state()
    if (state && state.workspace !== workspace)
      throw new Error('search_workspace_mismatch')
    if (
      !this.ctx.id.equals(
        this.env.WORKSPACE_SEARCH_INDEX.idFromName(
          searchIndexName(workspace, location),
        ),
      )
    )
      throw new Error('search_partition_mismatch')
    this.#location = { value: location }
    this.ctx.storage.sql.exec(
      'INSERT INTO state(singleton,workspace) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET dirty=1',
      workspace,
    )
    await this.ctx.storage.setAlarm(Date.now() + 1000)
    await this.run()
  }
  async alarm(): Promise<void> {
    await this.run()
  }
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    // An eviction or exception always leaves a durable continuation.
    try {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      const state = this.state()
      if (!state) return
      this.ctx.storage.sql.exec('UPDATE state SET dirty=0 WHERE singleton=1')
      const db = createDb(this.env.DB)
      try {
        await db
          .insertInto('search_index_workspaces')
          .values({ workspace_id: state.workspace, dispatched_at: '' })
          .onConflict((oc) => oc.column('workspace_id').doNothing())
          .execute()
        // Recent changes are independent of the backfill cursor.
        const recent = await inventory(db, state.workspace)
          .$if(!state.dirty && Boolean(state.recent_time), (query) =>
            query.where((eb) =>
              eb.or([
                eb('s.updated_at', '<', state.recent_time),
                eb.and([
                  eb('s.updated_at', '=', state.recent_time),
                  eb('s.id', '>', state.recent_id),
                ]),
              ]),
            ),
          )
          .orderBy('s.updated_at', 'desc')
          .orderBy('s.id')
          .limit(BATCH)
          .execute()
        const scan = await inventory(db, state.workspace)
          .where('s.id', '>', state.cursor)
          .orderBy('s.id')
          .limit(BATCH)
          .execute()
        for (const row of [...recent, ...scan]) {
          const active = this.ctx.storage.sql
            .exec<Active>('SELECT * FROM active WHERE id=?', row.id)
            .toArray()[0]
          if (
            !active ||
            active.fingerprint !== fingerprint(row) ||
            active.format !== INDEX_FORMAT_VERSION
          )
            this.ctx.storage.sql.exec(
              'INSERT OR IGNORE INTO pending(id) VALUES(?)',
              row.id,
            )
        }
        const recentEnd =
          recent.length === BATCH ? recent[recent.length - 1] : undefined
        this.ctx.storage.sql.exec(
          'UPDATE state SET recent_time=?,recent_id=? WHERE singleton=1',
          recentEnd?.updated_at ?? '',
          recentEnd?.id ?? '',
        )
        this.ctx.storage.sql.exec(
          'UPDATE state SET cursor=? WHERE singleton=1',
          scan.length === BATCH ? scan[scan.length - 1].id : '',
        )
        // Drain recent work before older pending rows; one corrupt object cannot block a pass.
        const pending = this.ctx.storage.sql
          .exec<{ id: string }>(
            'SELECT id FROM pending ORDER BY attempted, id LIMIT ?',
            BATCH,
          )
          .toArray()
        const ordered = [
          ...new Set([
            ...recent
              .filter(
                (row) =>
                  this.ctx.storage.sql
                    .exec('SELECT id FROM pending WHERE id=?', row.id)
                    .toArray().length,
              )
              .map((row) => row.id),
            ...pending.map((row) => row.id),
          ]),
        ]
        const sources = await Promise.all(
          ordered.map((id) =>
            inventory(db, state.workspace)
              .where('s.id', '=', id)
              .executeTakeFirst(),
          ),
        )
        for (const [position, id] of ordered.entries()) {
          this.ctx.storage.sql.exec(
            'UPDATE pending SET attempted=? WHERE id=?',
            Date.now(),
            id,
          )
          try {
            const source = sources[position]
            // Keep generation staging serial: concurrent 25 MiB extractions exceed the isolate memory budget.
            if (source) {
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              if (!(await this.replace(source))) continue
            }
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            else await this.remove(state.workspace, id)
            this.ctx.storage.sql.exec('DELETE FROM pending WHERE id=?', id)
          } catch {
            this.ctx.storage.sql.exec(
              'UPDATE pending SET failures=failures+1 WHERE id=?',
              id,
            )
            console.error('workspace_search_item_failed')
          }
        }
        // Paginate indexed identities as well as D1, including deleted rows and abandoned writes.
        const cleanup = this.ctx.storage.sql
          .exec<{ id: string }>(
            'SELECT id FROM active WHERE id>? UNION SELECT shareable AS id FROM intentions WHERE shareable>? UNION SELECT id FROM reclaims WHERE id>? UNION SELECT id FROM cleanup WHERE id>? ORDER BY id LIMIT ?',
            state.sweep,
            state.sweep,
            state.sweep,
            state.sweep,
            BATCH,
          )
          .toArray()
        const cleanupSources = cleanup.length
          ? await inventory(db, state.workspace)
              .where(
                's.id',
                'in',
                cleanup.map((row) => row.id),
              )
              .execute()
          : []
        const sourcesById = new Map(cleanupSources.map((row) => [row.id, row]))
        for (const row of cleanup) {
          const source = sourcesById.get(row.id)
          // The persisted sweep cursor advances only after each prefix cleanup succeeds.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          if (!source) await this.remove(state.workspace, row.id)
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          else if (
            this.ctx.storage.sql
              .exec(
                'SELECT shareable FROM intentions WHERE shareable=? UNION SELECT id FROM cleanup WHERE id=? UNION SELECT id FROM reclaims WHERE id=? LIMIT 1',
                row.id,
                row.id,
                row.id,
              )
              .toArray().length
          )
            await this.cleanObjects(source)
          this.reclaim(row.id)
          this.ctx.storage.sql.exec(
            'UPDATE state SET sweep=? WHERE singleton=1',
            row.id,
          )
        }
        if (cleanup.length < BATCH)
          this.ctx.storage.sql.exec(
            "UPDATE state SET sweep='' WHERE singleton=1",
          )
        const more = this.state()!
        await this.reportReady(db, more)
        const pendingCount = this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT ((SELECT count(*) FROM pending) + (SELECT count(*) FROM reclaims)) AS count',
          )
          .one().count
        if (
          more.cursor ||
          more.sweep ||
          more.recent_time ||
          more.dirty ||
          pendingCount
        )
          await this.ctx.storage.setAlarm(Date.now() + 1000)
        else {
          const workspaceExists = await db
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', state.workspace)
            .executeTakeFirst()
          const unfinishedCleanup = this.ctx.storage.sql
            .exec<{ remaining: number }>(
              'SELECT (EXISTS(SELECT 1 FROM active) OR EXISTS(SELECT 1 FROM intentions) OR EXISTS(SELECT 1 FROM staging) OR EXISTS(SELECT 1 FROM reclaims)) AS remaining',
            )
            .one().remaining
          if (!workspaceExists && unfinishedCleanup) {
            await this.ctx.storage.setAlarm(Date.now() + 1000)
          } else if (!workspaceExists) {
            await db
              .deleteFrom('search_index_workspaces')
              .where('workspace_id', '=', state.workspace)
              .execute()
            await this.ctx.storage.deleteAlarm()
          } else await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000)
        }
      } finally {
        await db.destroy()
      }
    } finally {
      // Signals received across any awaited operation belong to the next pass.
      // Recheck after idle scheduling so that it cannot overwrite their alarm.
      this.running = false
      if (this.state()?.dirty)
        await this.ctx.storage.setAlarm(Date.now() + 1000)
    }
  }
  private async replace(source: Source): Promise<boolean> {
    const db = createDb(this.env.DB)
    const previousStage = this.ctx.storage.sql
      .exec<{ generation: string; fingerprint: string; format: number }>(
        'SELECT generation,fingerprint,format FROM staging WHERE id=?',
        source.id,
      )
      .toArray()[0]
    const resume =
      previousStage?.fingerprint === fingerprint(source) &&
      previousStage.format === INDEX_FORMAT_VERSION
    const generation = resume ? previousStage.generation : crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO staging(id,generation,fingerprint,format) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint,format=excluded.format',
      source.id,
      generation,
      fingerprint(source),
      INDEX_FORMAT_VERSION,
    )
    this.reclaim(source.id)
    const active = this.ctx.storage.sql
      .exec<Active>('SELECT * FROM active WHERE id=?', source.id)
      .toArray()[0]
    const reuse =
      active?.content === contentFingerprint(source) &&
      active.format === INDEX_FORMAT_VERSION
    const location = this.location()
    try {
      const files = await db
        .selectFrom('version_files')
        .select(['path', 'r2_key', 'mime_type'])
        .where('version_id', '=', source.current_version_id!)
        .orderBy('path')
        .execute()
      const site = ['static_site', 'spa', 'workspace_app'].includes(
        source.artifact_kind,
      )
      const pages = site
        ? files.filter(
            (file) => /\.html?$/iu.test(file.path) || isMarkdownPath(file.path),
          )
        : []
      if (!pages.some((file) => file.path === source.entrypoint_path))
        pages.push({
          path: source.entrypoint_path,
          r2_key: source.r2_key,
          mime_type: '',
        })
      this.ctx.storage.sql.exec(
        'UPDATE staging SET expected_documents=? WHERE id=?',
        pages.length,
        source.id,
      )
      let chunkBudget = 64
      for (const page of pages) {
        const stagedDocument = this.ctx.storage.sql
          .exec<{ id: number; complete: number }>(
            'SELECT id,complete FROM documents WHERE shareable=? AND generation=? AND path=?',
            source.id,
            generation,
            page.path,
          )
          .toArray()[0]
        if (stagedDocument?.complete) continue
        const key = await searchTextKey(
          source.workspace_id,
          source.id,
          source.current_version_id!,
          page.path,
          location,
        )
        // Persist BEFORE writing, including metadata-only repairs of missing extraction.
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO intentions(key,shareable) VALUES(?,?)',
          key,
          source.id,
        )
        let text: ExtractedText
        const fits = (object: R2ObjectBody | null) =>
          object?.customMetadata?.source === contentFingerprint(source) &&
          object.customMetadata.format === String(INDEX_FORMAT_VERSION)
        let cached = reuse || resume ? await this.env.BUCKET.get(key) : null
        let copied = false
        if (!fits(cached) && location) {
          // A placed index reads, never writes or deletes, the legacy
          // index's extraction of the same version.
          const legacy = await this.env.BUCKET.get(
            await searchTextKey(
              source.workspace_id,
              source.id,
              source.current_version_id!,
              page.path,
            ),
          )
          if (fits(legacy)) {
            cached = legacy
            copied = true
          }
        }
        if (fits(cached)) {
          text = await cached!.json<ExtractedText>()
          if (copied)
            await this.env.BUCKET.put(key, JSON.stringify(text), {
              customMetadata: {
                source: contentFingerprint(source),
                format: String(INDEX_FORMAT_VERSION),
              },
              httpMetadata: { contentType: 'application/json' },
            })
        } else {
          if (
            source.artifact_kind === 'pdf' ||
            source.artifact_kind === 'video'
          )
            text = {
              format: INDEX_FORMAT_VERSION,
              body: source.description ?? '',
              script: '',
            }
          else {
            const object = await this.env.BUCKET.get(page.r2_key)
            if (!object) throw new Error('search_source_missing')
            text = await extractPage(
              await object.text(),
              page.path,
              site ? undefined : source.artifact_kind,
            )
            if (site && page.path === source.entrypoint_path) {
              const local: string[] = []
              const scripts = files.filter((entry) =>
                /\.(m?js|json)$/iu.test(entry.path),
              )
              for (let offset = 0; offset < scripts.length; offset += 2) {
                const pair = await Promise.all(
                  scripts.slice(offset, offset + 2).map(async (file) => {
                    const localObject = await this.env.BUCKET.get(file.r2_key)
                    if (!localObject) throw new Error('search_source_missing')
                    return extractLocalStrings(
                      await localObject.text(),
                      file.path,
                    )
                  }),
                )
                local.push(...pair)
              }
              text.script += ` ${local.join(' ')}`
            }
          }
          text.format = INDEX_FORMAT_VERSION
          await this.env.BUCKET.put(key, JSON.stringify(text), {
            customMetadata: {
              source: contentFingerprint(source),
              format: String(INDEX_FORMAT_VERSION),
            },
            httpMetadata: { contentType: 'application/json' },
          })
        }
        const document =
          stagedDocument?.id ??
          this.ctx.storage.sql
            .exec<{ id: number }>(
              'INSERT INTO documents(shareable,version,path,generation,owner,container,updated_at,normalized_title,title_key,activity_at,group_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
              source.id,
              source.current_version_id!,
              page.path,
              generation,
              source.owner_user_id,
              source.container_id,
              source.updated_at,
              normalizeSearchText(displayTitle(source)),
              literalKey(displayTitle(source)),
              source.activity_at,
              groupKey(displayTitle(source)),
            )
            .one().id
        const columns = [displayTitle(source), text.body, text.script].map(
          (value) => packTokens(normalizeSearchText(value)),
        )
        columns.push(
          packTokens(
            katakanaRuns(
              [displayTitle(source), text.body, text.script].join(' '),
            ),
          ),
        )
        const count = Math.max(1, ...columns.map((column) => column.length))
        this.ctx.storage.sql.exec(
          'UPDATE documents SET expected_chunks=? WHERE id=?',
          count,
          document,
        )
        const written = this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT count(*) AS count FROM chunks WHERE document=?',
            document,
          )
          .one().count
        for (let ordinal = written; ordinal < count; ordinal++) {
          if (chunkBudget === 0) return false
          chunkBudget--
          this.writeChunk(document, ordinal, columns)
        }
        this.ctx.storage.sql.exec(
          'DELETE FROM snippets WHERE document=?',
          document,
        )
        let ordinal = 0
        for (const body of splitUtf8(snippet(text.body), COLUMN_BYTES))
          this.ctx.storage.sql.exec(
            'INSERT INTO snippets(document,ordinal,body) VALUES(?,?,?)',
            document,
            ordinal++,
            body,
          )
        this.ctx.storage.sql.exec(
          'UPDATE documents SET complete=1 WHERE id=? AND expected_chunks=(SELECT count(*) FROM chunks WHERE document=documents.id)',
          document,
        )
      }
      const current = await inventory(db, source.workspace_id)
        .where('s.id', '=', source.id)
        .executeTakeFirst()
      if (!current || fingerprint(current) !== fingerprint(source)) {
        this.ctx.storage.sql.exec('DELETE FROM staging WHERE id=?', source.id)
        this.reclaim(source.id)
        if (!current) await this.remove(source.workspace_id, source.id)
        throw new Error('search_source_changed')
      }
      this.ctx.storage.transactionSync(() => {
        const completed = this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT count(*) AS count FROM documents WHERE shareable=? AND generation=? AND complete=1',
            source.id,
            generation,
          )
          .one().count
        if (completed !== pages.length)
          throw new Error('search_incomplete_generation')
        this.ctx.storage.sql.exec(
          'INSERT INTO active(id,generation,fingerprint,content,format) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint,content=excluded.content,format=excluded.format',
          source.id,
          generation,
          fingerprint(source),
          contentFingerprint(source),
          INDEX_FORMAT_VERSION,
        )
      })
      this.ctx.storage.sql.exec('DELETE FROM staging WHERE id=?', source.id)
      this.reclaim(source.id)
      await this.cleanObjects(source)
      const afterCleanup = await inventory(db, source.workspace_id)
        .where('s.id', '=', source.id)
        .executeTakeFirst()
      if (!afterCleanup) await this.remove(source.workspace_id, source.id)
      else if (fingerprint(afterCleanup) !== fingerprint(source))
        throw new Error('search_source_changed')
      return true
    } finally {
      await db.destroy()
    }
  }
  private reclaim(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<{ id: number }>(
          'SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document WHERE d.shareable=? AND NOT EXISTS (SELECT 1 FROM active a WHERE a.id=d.shareable AND a.generation=d.generation) AND NOT EXISTS (SELECT 1 FROM staging s WHERE s.id=d.shareable AND s.generation=d.generation) LIMIT 64',
          id,
        )
        .toArray()
      for (const row of rows) {
        this.ctx.storage.sql.exec('DELETE FROM search WHERE rowid=?', row.id)
        this.ctx.storage.sql.exec(
          'DELETE FROM search_runs WHERE rowid=?',
          row.id,
        )
        this.ctx.storage.sql.exec(
          'DELETE FROM search_seams WHERE rowid=?',
          row.id,
        )
        this.ctx.storage.sql.exec('DELETE FROM chunks WHERE id=?', row.id)
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM snippets WHERE document IN (SELECT d.id FROM documents d WHERE d.shareable=? AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document=d.id) AND NOT EXISTS (SELECT 1 FROM active a WHERE a.id=d.shareable AND a.generation=d.generation) AND NOT EXISTS (SELECT 1 FROM staging s WHERE s.id=d.shareable AND s.generation=d.generation))',
        id,
      )
      this.ctx.storage.sql.exec(
        'DELETE FROM documents WHERE shareable=? AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document=documents.id) AND NOT EXISTS (SELECT 1 FROM active a WHERE a.id=documents.shareable AND a.generation=documents.generation) AND NOT EXISTS (SELECT 1 FROM staging s WHERE s.id=documents.shareable AND s.generation=documents.generation)',
        id,
      )
      const remaining = this.ctx.storage.sql
        .exec(
          'SELECT id FROM documents d WHERE shareable=? AND NOT EXISTS (SELECT 1 FROM active a WHERE a.id=d.shareable AND a.generation=d.generation) AND NOT EXISTS (SELECT 1 FROM staging s WHERE s.id=d.shareable AND s.generation=d.generation) LIMIT 1',
          id,
        )
        .toArray().length
      if (remaining)
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO reclaims(id) VALUES(?)',
          id,
        )
      else this.ctx.storage.sql.exec('DELETE FROM reclaims WHERE id=?', id)
    })
  }
  private async cleanObjects(source: Source): Promise<void> {
    if (
      this.ctx.storage.sql
        .exec('SELECT id FROM staging WHERE id=?', source.id)
        .toArray().length
    )
      return
    const keep = new Set(
      await Promise.all(
        this.ctx.storage.sql
          .exec<{ path: string; version: string }>(
            'SELECT d.path,d.version FROM documents d JOIN active a ON a.id=d.shareable AND a.generation=d.generation WHERE d.shareable=?',
            source.id,
          )
          .toArray()
          .map((row) =>
            searchTextKey(
              source.workspace_id,
              source.id,
              row.version,
              row.path,
              this.location(),
            ),
          ),
      ),
    )
    await this.deleteObjects(source.workspace_id, source.id, keep)
  }
  private async remove(workspace: string, id: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO intentions(key,shareable) VALUES(?,?)',
      shareableSearchPrefix(workspace, id, this.location()),
      id,
    )
    this.ctx.storage.sql.exec('DELETE FROM staging WHERE id=?', id)
    this.ctx.storage.sql.exec('DELETE FROM active WHERE id=?', id)
    this.reclaim(id)
    await this.deleteObjects(workspace, id, new Set())
  }
  private async deleteObjects(
    workspace: string,
    id: string,
    keep: Set<string>,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT INTO cleanup(id,cursor,generation) VALUES(?,NULL,?) ON CONFLICT(id) DO UPDATE SET cursor=CASE WHEN cleanup.generation=excluded.generation THEN cleanup.cursor ELSE NULL END,generation=excluded.generation',
      id,
      this.ctx.storage.sql
        .exec<{ generation: string }>(
          'SELECT generation FROM active WHERE id=?',
          id,
        )
        .toArray()[0]?.generation ?? 'deleted',
    )
    let cursor =
      this.ctx.storage.sql
        .exec<{ cursor: string | null }>(
          'SELECT cursor FROM cleanup WHERE id=?',
          id,
        )
        .one().cursor ?? undefined
    do {
      const page = await this.env.BUCKET.list({
        prefix: shareableSearchPrefix(workspace, id, this.location()),
        cursor,
        limit: 100,
      })
      const keys = page.objects
        .map((object) => object.key)
        .filter((key) => !keep.has(key))
      if (keys.length) await this.env.BUCKET.delete(keys)
      cursor = page.truncated ? page.cursor : undefined
      this.ctx.storage.sql.exec(
        'UPDATE cleanup SET cursor=? WHERE id=?',
        cursor ?? null,
        id,
      )
    } while (cursor)
    this.ctx.storage.sql.exec('DELETE FROM cleanup WHERE id=?', id)
    this.ctx.storage.sql.exec('DELETE FROM intentions WHERE shareable=?', id)
  }
}
