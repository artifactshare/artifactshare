import {
  visibilityPredicate,
  LOCAL_VISIBILITY_SCHEMA,
} from '../app/services/search-index/visibility'
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
import { searchIndexName } from '../app/services/search-index/names'
import { searchFailureReason } from '../app/services/search-index/failure'
import { createDb } from '../app/services/db.server'
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
  dirty: number
}
type Active = {
  id: string
  generation: string
  fingerprint: string
  content: string
  format: number
}
class SearchCleanupError extends Error {
  override name = 'SearchCleanupError'
}

// Format 13 changes only candidate policy, not extraction or document ranking.
const compatibleContentFormat = (format: number | string) =>
  Number(format) === INDEX_FORMAT_VERSION ||
  (INDEX_FORMAT_VERSION === 13 && Number(format) === 12)

const BATCH = 5
const FAILURE_SPACING_MS = 5 * 60_000
// A file that keeps failing stops holding back rebuild completion and the
// dispatch queue after this many failures spread over at least this long,
// so an outage that clears within the hour still blocks, but a file that can
// never be indexed does not block forever. It is then retried once a day,
// and a change to the file resets its count.
const GIVE_UP_FAILURES = 3
const GIVE_UP_AFTER_MS = 60 * 60_000
const GIVEN_UP_RETRY_MS = 24 * 60 * 60_000
// Rows compared with D1, or swept, in one pass step. A D1 lookup binds the
// workspace and these ids, under its 100-parameter limit.
const PASS_BATCH = 50
/** Internal RPC only. No search endpoint or authorization copies. */
export class WorkspaceSearchIndex extends DurableObject<Cloudflare.Env> {
  private running = false
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    // Storage is created by the first sync, never by a read: a read can
    // reach an index that was never synced.
    if (
      ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state'")
        .toArray().length
    )
      this.#initSchema()
  }
  // Whether this instance has its tables; false before the first sync and
  // after a leftover object (not named as its recorded workspace's index, or
  // with no recorded workspace) deleted its storage.
  #schemaReady = false
  protected ensureSchema(): void {
    if (!this.#schemaReady) this.#initSchema()
  }
  #initSchema(): void {
    this.#schemaReady = true
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', sweep TEXT NOT NULL DEFAULT '', recent_time TEXT NOT NULL DEFAULT '', recent_id TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS active (id TEXT PRIMARY KEY, generation TEXT NOT NULL, fingerprint TEXT NOT NULL, content TEXT NOT NULL, format INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rebuild (singleton INTEGER PRIMARY KEY CHECK(singleton=1), target INTEGER NOT NULL, cursor TEXT NOT NULL DEFAULT '', sweep TEXT NOT NULL DEFAULT '', scanned INTEGER NOT NULL DEFAULT 0, swept INTEGER NOT NULL DEFAULT 0);
      ${LOCAL_VISIBILITY_SCHEMA}
      CREATE TABLE IF NOT EXISTS policy_pending (kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(kind,key));
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
      this.ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(documents)')
        .toArray()
        .map((row) => row.name),
    )
    if (!columns.has('title_key'))
      this.ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN title_key TEXT NOT NULL DEFAULT ''",
      )
    if (!columns.has('activity_at'))
      this.ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN activity_at TEXT NOT NULL DEFAULT ''",
      )
    if (!columns.has('group_key'))
      this.ctx.storage.sql.exec(
        "ALTER TABLE documents ADD COLUMN group_key TEXT NOT NULL DEFAULT ''",
      )
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS documents_group_key ON documents(group_key)',
    )
    const pendingColumns = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(pending)')
        .toArray()
        .map((row) => row.name),
    )
    // Failure counts and the readiness record of earlier versions are unused.
    for (const column of ['failures', 'failed_at', 'first_failed_at'])
      if (pendingColumns.has(column))
        this.ctx.storage.sql.exec(`ALTER TABLE pending DROP COLUMN ${column}`)
    this.ctx.storage.sql.exec('DROP TABLE IF EXISTS placement')
    // When a failed item may be tried again; 0 means now.
    if (!pendingColumns.has('retry_at'))
      this.ctx.storage.sql.exec(
        'ALTER TABLE pending ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0',
      )
    // A file can finish refreshing access policy even if its text needs a retry.
    if (!pendingColumns.has('policy_dirty'))
      this.ctx.storage.sql.exec(
        'ALTER TABLE pending ADD COLUMN policy_dirty INTEGER NOT NULL DEFAULT 1',
      )
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS pending_dirty_policy ON pending(policy_dirty) WHERE policy_dirty=1',
    )
    // Consecutive failures since the file last changed, and when they began.
    if (!pendingColumns.has('failed_count'))
      this.ctx.storage.sql.exec(
        'ALTER TABLE pending ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0',
      )
    if (!pendingColumns.has('failing_since'))
      this.ctx.storage.sql.exec(
        'ALTER TABLE pending ADD COLUMN failing_since INTEGER NOT NULL DEFAULT 0',
      )
    // Retain legacy reconciliation columns for additive cutover and rollback.
    // New code only advances the explicit rebuild checkpoint.
    const stateColumns = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(state)')
        .toArray()
        .map((row) => row.name),
    )
    for (const [column, definition] of [
      ['recent_mark', "TEXT NOT NULL DEFAULT ''"],
      ['scanned_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['scanned_format', 'INTEGER NOT NULL DEFAULT 0'],
      ['scan_format', 'INTEGER NOT NULL DEFAULT 0'],
      ['swept_at', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const)
      if (!stateColumns.has(column))
        this.ctx.storage.sql.exec(
          `ALTER TABLE state ADD COLUMN ${column} ${definition}`,
        )
    // Remove the prior persisted query cache and its invalidation triggers.
    for (const table of ['documents', 'chunks', 'active'])
      for (const event of ['INSERT', 'UPDATE', 'DELETE'])
        this.ctx.storage.sql.exec(
          `DROP TRIGGER IF EXISTS invalidate_query_${table}_${event}`,
        )
    this.ctx.storage.sql
      .exec(`DROP TABLE IF EXISTS query_results; DROP TABLE IF EXISTS query_cache; DROP TABLE IF EXISTS query_allowed_ids;
      CREATE INDEX IF NOT EXISTS chunks_document_ordinal ON chunks(document,ordinal);`)
  }
  /** Build one SQL ranking over the requested document set, never JS-wide row arrays. */
  #matchingPages(input: IndexSearchInput, details = false, titleOnly = false) {
    if (
      input.visibility &&
      this.ctx.storage.sql
        .exec<{ target: number }>('SELECT target FROM rebuild')
        .toArray()
        .some((row) => row.target > INDEX_FORMAT_VERSION)
    )
      throw new SearchCapacityError()
    const query = prepareQuery(input.query)
    const filters: string[] = []
    const bindings: Array<string | number> = []
    if (input.visibility) {
      const policy = visibilityPredicate(input.visibility)
      filters.push('(' + policy.sql + ')')
      bindings.push(...policy.bindings)
    }
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

  private async visibilityPending(input: IndexSearchInput): Promise<boolean> {
    if (!input.visibility) return false
    const workspace =
      input.workspaceId ??
      (this.#schemaReady
        ? this.ctx.storage.sql
            .exec<State>('SELECT workspace,dirty FROM state WHERE singleton=1')
            .toArray()[0]?.workspace
        : undefined)
    const durable = workspace
      ? (
          await this.env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM search_index_changes WHERE workspace_id=?) OR
      EXISTS(SELECT 1 FROM search_index_policy_changes WHERE workspace_id=?) AS pending,
      (SELECT target FROM search_index_workspace_rebuilds WHERE workspace_id=? AND completed=0) AS rebuildTarget`)
            .bind(workspace, workspace, workspace)
            .all<{ pending: number; rebuildTarget: number | null }>()
        ).results[0]
      : undefined
    // Dispatch persists policy work before acknowledging its D1 feed identity.
    // Once policy has converged, a text extraction or object cleanup failure
    // cannot make the indexed candidate set incomplete indefinitely.
    const local = this.#schemaReady
      ? this.ctx.storage.sql
          .exec<{ pending: number; scannedPolicyTarget: number }>(`SELECT
      EXISTS(SELECT 1 FROM pending WHERE policy_dirty=1) OR
      EXISTS(SELECT 1 FROM policy_pending) OR
      EXISTS(SELECT 1 FROM rebuild WHERE scanned=0 OR swept=0) OR
      EXISTS(SELECT 1 FROM state WHERE dirty>0) AS pending,
      coalesce((SELECT target FROM rebuild WHERE singleton=1 AND scanned=1 AND swept=1),0) AS scannedPolicyTarget`)
          .one()
      : undefined
    return Boolean(
      durable?.pending ||
      local?.pending ||
      (durable?.rebuildTarget ?? 0) > (local?.scannedPolicyTarget ?? 0),
    )
  }
  async search(input: IndexSearchInput): Promise<IndexSearchResult> {
    if (input.visibility && input.visibility.protocol !== 1)
      return { error: { code: 'search_capacity_exceeded' } }
    const incomplete = await this.visibilityPending(input)
    if (!this.#schemaReady)
      return {
        items: [],
        nextCursor: null,
        visibilityProtocol: 1,
        incomplete,
      }
    try {
      return { ...this.searchPage(input), incomplete }
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
      visibilityProtocol: 1 as const,
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

  async groupMembers(
    input: IndexSearchInput,
    keys: string[],
  ): Promise<IndexSearchResult> {
    if (input.visibility && input.visibility.protocol !== 1)
      return { error: { code: 'search_capacity_exceeded' } }
    const incomplete = await this.visibilityPending(input)
    if (!this.#schemaReady)
      return {
        items: [],
        nextCursor: null,
        visibilityProtocol: 1,
        incomplete,
      }
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
        visibilityProtocol: 1 as const,
        incomplete,
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
    if (!this.#schemaReady) return []
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

  private state(): State | undefined {
    return this.ctx.storage.sql
      .exec<State>('SELECT workspace, dirty FROM state WHERE singleton=1')
      .toArray()[0]
  }
  // When this instance last received a sync request, so a failure based on
  // data read before it does not postpone the retry that sync asked for.
  #syncedAt = 0

  /**
   * Delete the storage of an object that is not named as the index of the
   * workspace it recorded (one left from before every index moved to one
   * location), or that has tables but never recorded a workspace (created by
   * a read before storage waited for the first sync). A real index records
   * its workspace in the sync that creates its tables. Returns whether it
   * deleted.
   */
  async #dropIfLeftover(): Promise<boolean> {
    if (!this.#schemaReady) return false
    const workspace = this.state()?.workspace
    if (workspace && this.#isNamedIndex(workspace)) return false
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.#schemaReady = false
    return true
  }
  /** Whether this object is the index named for the workspace. */
  #isNamedIndex(workspace: string): boolean {
    return this.ctx.id.equals(
      this.env.WORKSPACE_SEARCH_INDEX.idFromName(searchIndexName(workspace)),
    )
  }
  /** Only the index named for this workspace accepts its sync. */
  async sync(workspace: string, mutation = true): Promise<void> {
    workspaceSearchPrefix(workspace)
    if (!this.#isNamedIndex(workspace)) {
      // A leftover object, judged by the workspace it recorded itself or by
      // having recorded none, drops its storage when asked; a misrouted sync
      // never touches a real index.
      await this.#dropIfLeftover()
      throw new Error('search_partition_mismatch')
    }
    // Tables without a recorded workspace were created by a read before
    // storage waited for the first sync; they start over here.
    await this.#dropIfLeftover()
    // Storage is created only for a sync this object accepts by name.
    this.ensureSchema()
    const state = this.state()
    if (state && state.workspace !== workspace)
      throw new Error('search_workspace_mismatch')
    this.ctx.storage.sql.exec(
      'INSERT INTO state(singleton,workspace,dirty) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET dirty=dirty+excluded.dirty',
      workspace,
      Number(mutation),
    )
    // Only product notifications invalidate retries; cron wakes preserve backoff.
    if (mutation) this.#syncedAt = Date.now()
    await this.ctx.storage.setAlarm(Date.now() + 1000)
    await this.run()
  }
  async alarm(): Promise<void> {
    await this.run()
  }
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    // Notifications this run has not consumed. Only ones that arrive while it
    // runs need an early alarm; a failed run retries on its 30-second alarm.
    let unconsumed = 0
    // An eviction or exception always leaves a durable continuation.
    try {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      // An index without storage has nothing to run.
      if (!this.#schemaReady) {
        await this.ctx.storage.deleteAlarm()
        return
      }
      // A leftover object only deletes its storage, so it never writes into
      // an index's text area.
      if (await this.#dropIfLeftover()) return
      const state = this.state()
      if (!state) return
      const readAt = Date.now()
      unconsumed = state.dirty
      const db = createDb(this.env.DB)
      try {
        // Keep local work discoverable even when a format fence pauses its alarm.
        // DO handoff and D1 acknowledgement must never outlive this durable wake row.
        await db
          .insertInto('search_index_ready')
          .values({ workspace_id: state.workspace, dispatched_at: '' })
          .onConflict((oc) => oc.column('workspace_id').doNothing())
          .execute()
        const latest = await db
          .selectFrom('search_index_rebuilds')
          .select('target')
          .orderBy('target', 'desc')
          .limit(1)
          .executeTakeFirst()
        const obligation = await db
          .selectFrom('search_index_workspace_rebuilds')
          .selectAll()
          .where('workspace_id', '=', state.workspace)
          .executeTakeFirst()
        // Retained targets fence rollback even after seeding and completion.
        if (
          (latest?.target ?? 0) > INDEX_FORMAT_VERSION ||
          (obligation?.target ?? 0) > INDEX_FORMAT_VERSION
        ) {
          await this.ctx.storage.deleteAlarm()
          return
        }
        if (state.dirty)
          this.ctx.storage.sql.exec(
            'UPDATE pending SET retry_at=0 WHERE retry_at>0',
          )
        if (
          obligation &&
          !obligation.completed &&
          obligation.target === INDEX_FORMAT_VERSION
        ) {
          this.ctx.storage.sql.exec(
            "INSERT INTO rebuild(singleton,target) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET target=excluded.target,cursor='',sweep='',scanned=0,swept=0 WHERE rebuild.target < excluded.target",
            obligation.target,
          )
        }
        const rebuild = this.ctx.storage.sql
          .exec<{
            target: number
            cursor: string
            sweep: string
            scanned: number
            swept: number
          }>('SELECT * FROM rebuild')
          .toArray()[0]
        // Alternate recent and oldest identities so continuous edits cannot starve tombstones.
        const changes = await db
          .selectFrom('search_index_changes')
          .select(['id', 'shareable_id'])
          .where('workspace_id', '=', state.workspace)
          .orderBy('id', 'desc')
          .limit(PASS_BATCH / 2)
          .execute()
        const oldest = await db
          .selectFrom('search_index_changes')
          .select(['id', 'shareable_id'])
          .where('workspace_id', '=', state.workspace)
          .orderBy('id')
          .limit(PASS_BATCH / 2)
          .execute()
        const received = [
          ...new Map(
            [...changes, ...oldest].map((row) => [row.id, row]),
          ).values(),
        ]
        const policyChanges = await db
          .selectFrom('search_index_policy_changes')
          .selectAll()
          .where('workspace_id', '=', state.workspace)
          .orderBy('id')
          .limit(PASS_BATCH)
          .execute()
        this.ctx.storage.transactionSync(() => {
          for (const row of policyChanges)
            this.ctx.storage.sql.exec(
              'INSERT INTO policy_pending(kind,key) VALUES(?,?) ON CONFLICT(kind,key) DO NOTHING',
              row.kind,
              row.policy_key,
            )
        })
        // The continuation alarm is already durable. Persist the handoff before exact-ID acknowledgement.
        this.ctx.storage.transactionSync(() => {
          for (const row of received)
            this.ctx.storage.sql.exec(
              'INSERT INTO pending(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET retry_at=0, policy_dirty=1, failed_count=0, failing_since=0',
              row.shareable_id,
            )
          this.ctx.storage.sql.exec(
            'UPDATE state SET dirty=max(dirty-?,0) WHERE singleton=1',
            state.dirty,
          )
        })
        unconsumed = 0
        if (received.length)
          await db
            .deleteFrom('search_index_changes')
            .where('workspace_id', '=', state.workspace)
            .where(
              'id',
              'in',
              received.map((row) => row.id),
            )
            // A migration can land while this run awaits D1. Do not acknowledge
            // obligations introduced under a format this Worker cannot process.
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_rebuilds')
                    .select('target')
                    .where('target', '>', INDEX_FORMAT_VERSION),
                ),
              ),
            )
            .execute()
        if (policyChanges.length)
          await db
            .deleteFrom('search_index_policy_changes')
            .where('workspace_id', '=', state.workspace)
            .where(
              'id',
              'in',
              policyChanges.map((r) => r.id),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_rebuilds')
                    .select('target')
                    .where('target', '>', INDEX_FORMAT_VERSION),
                ),
              ),
            )
            .execute()
        // Replayed work reloads policy by key; no container mutation visits child files.
        const policies = this.ctx.storage.sql
          .exec<{ kind: 'container' | 'workspace'; key: string }>(
            'SELECT kind,key FROM policy_pending ORDER BY kind,key LIMIT ?',
            PASS_BATCH,
          )
          .toArray()
        for (const row of policies) {
          // A failure must leave subsequent durable keys untouched for the next alarm.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await this.refreshPolicy(db, state.workspace, row.kind, row.key)
          this.ctx.storage.sql.exec(
            'DELETE FROM policy_pending WHERE kind=? AND key=?',
            row.kind,
            row.key,
          )
        }
        if (rebuild?.target === INDEX_FORMAT_VERSION && !rebuild.scanned) {
          const scan = await inventory(db, state.workspace)
            .where('s.id', '>', rebuild.cursor)
            .orderBy('s.id')
            .limit(PASS_BATCH)
            .execute()
          this.ctx.storage.transactionSync(() => {
            for (const row of scan)
              this.ctx.storage.sql.exec(
                'INSERT OR IGNORE INTO pending(id) VALUES(?)',
                row.id,
              )
            this.ctx.storage.sql.exec(
              'UPDATE rebuild SET cursor=?,scanned=? WHERE singleton=1',
              scan.at(-1)?.id ?? rebuild.cursor,
              Number(scan.length < PASS_BATCH),
            )
          })
        }
        if (rebuild?.target === INDEX_FORMAT_VERSION && !rebuild.swept) {
          const stored = this.ctx.storage.sql
            .exec<{ id: string }>(
              'SELECT id FROM active WHERE id>? UNION SELECT shareable AS id FROM intentions WHERE shareable>? UNION SELECT id FROM reclaims WHERE id>? UNION SELECT id FROM cleanup WHERE id>? UNION SELECT id FROM staging WHERE id>? ORDER BY id LIMIT ?',
              rebuild.sweep,
              rebuild.sweep,
              rebuild.sweep,
              rebuild.sweep,
              rebuild.sweep,
              PASS_BATCH,
            )
            .toArray()
          this.ctx.storage.transactionSync(() => {
            for (const row of stored)
              this.ctx.storage.sql.exec(
                'INSERT OR IGNORE INTO pending(id) VALUES(?)',
                row.id,
              )
            this.ctx.storage.sql.exec(
              'UPDATE rebuild SET sweep=?,swept=? WHERE singleton=1',
              stored.at(-1)?.id ?? rebuild.sweep,
              Number(stored.length < PASS_BATCH),
            )
          })
        }
        // Old queued cleanup uses the same fair retry queue; staged writes wait for replacement.
        // Exclude already-pending IDs so a failing prefix cannot occupy every slot.
        const cleanup = this.ctx.storage.sql
          .exec<{ id: string }>(
            'SELECT id FROM (SELECT shareable AS id FROM intentions WHERE shareable NOT IN (SELECT id FROM staging) UNION SELECT id FROM reclaims UNION SELECT id FROM cleanup WHERE id NOT IN (SELECT id FROM staging)) WHERE id NOT IN (SELECT id FROM pending) ORDER BY id LIMIT ?',
            BATCH,
          )
          .toArray()
        for (const row of cleanup)
          this.ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO pending(id) VALUES(?)',
            row.id,
          )
        // Drain recent work before older pending rows; one corrupt object cannot block a pass.
        // A failed item waits until its retry time, so a file that keeps
        // failing is retried every few minutes rather than keeping the index
        // busy (and its replies waiting) every second.
        const now = Date.now()
        const pending = this.ctx.storage.sql
          .exec<{ id: string }>(
            'SELECT id FROM pending WHERE retry_at <= ? ORDER BY attempted, id LIMIT ?',
            now,
            BATCH,
          )
          .toArray()
        const recentPending = received
          .filter(
            (row) =>
              this.ctx.storage.sql
                .exec(
                  'SELECT 1 FROM pending WHERE id=? AND retry_at<=?',
                  row.shareable_id,
                  now,
                )
                .toArray().length,
          )
          .slice(0, BATCH)
        const ordered = [
          ...new Set([
            ...recentPending.map((row) => row.shareable_id),
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
        let cleanupFailure: SearchCleanupError | undefined
        for (const [position, id] of ordered.entries()) {
          this.ctx.storage.sql.exec(
            'UPDATE pending SET attempted=? WHERE id=?',
            Date.now(),
            id,
          )
          let stage: 'policy' | 'retain' | 'replace' | 'remove' = 'policy'
          try {
            const source = sources[position]
            // Keep generation staging serial: concurrent 25 MiB extractions exceed the isolate memory budget.
            if (source) {
              // Policy and the following generation replacement share the serial item budget.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await this.refreshFilePolicy(db, state.workspace, id)
              this.ctx.storage.sql.exec(
                'UPDATE pending SET policy_dirty=0 WHERE id=?',
                id,
              )
              const active = this.ctx.storage.sql
                .exec<Active>('SELECT * FROM active WHERE id=?', id)
                .toArray()[0]
              if (
                active?.fingerprint === fingerprint(source) &&
                compatibleContentFormat(active.format)
              ) {
                stage = 'retain'
                // Format 13 adds policy only: retain the already indexed text generation.
                this.ctx.storage.sql.exec(
                  'UPDATE active SET format=? WHERE id=?',
                  INDEX_FORMAT_VERSION,
                  id,
                )
                this.ctx.storage.sql.exec('DELETE FROM staging WHERE id=?', id)
                this.reclaim(id)
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                await this.cleanObjects(source)
              } else {
                stage = 'replace'
                if (!(await this.replace(source))) continue
              }
            }
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            else {
              stage = 'remove'
              this.ctx.storage.sql.exec(
                'DELETE FROM file_policy WHERE id=?',
                id,
              )
              this.ctx.storage.sql.exec(
                'UPDATE pending SET policy_dirty=0 WHERE id=?',
                id,
              )
              await this.remove(state.workspace, id)
            }
            this.ctx.storage.sql.exec('DELETE FROM pending WHERE id=?', id)
          } catch (error) {
            // Report cleanup failures after scheduling their durable retry. The
            // deduplicated batch must not revisit the failed prefix this run.
            if (error instanceof SearchCleanupError) cleanupFailure ??= error
            // Wait five minutes before the next try, unless a sync request
            // arrived after this run began reading D1, since the failure may
            // come from what it read.
            let givenUp = false
            if (this.#syncedAt <= readAt) {
              const failedAt = Date.now()
              const failure = this.ctx.storage.sql
                .exec<{ failed_count: number; failing_since: number }>(
                  'UPDATE pending SET failed_count=failed_count+1, failing_since=CASE WHEN failing_since=0 THEN ? ELSE failing_since END WHERE id=? RETURNING failed_count, failing_since',
                  failedAt,
                  id,
                )
                .toArray()[0]
              givenUp =
                !!failure &&
                failure.failed_count >= GIVE_UP_FAILURES &&
                failedAt - failure.failing_since >= GIVE_UP_AFTER_MS
              this.ctx.storage.sql.exec(
                'UPDATE pending SET retry_at=? WHERE id=?',
                failedAt + (givenUp ? GIVEN_UP_RETRY_MS : FAILURE_SPACING_MS),
                id,
              )
            }
            console.error(
              givenUp
                ? 'workspace_search_item_given_up'
                : 'workspace_search_item_failed',
              {
                workspace_id: state.workspace,
                shareable_id: id,
                stage,
                reason: searchFailureReason(error),
              },
            )
          }
        }
        const policyPending =
          this.ctx.storage.sql
            .exec('SELECT 1 FROM policy_pending LIMIT 1')
            .toArray().length > 0
        const remaining = this.ctx.storage.sql
          .exec<{
            pending: number
            due: number
            retry: number | null
            cleanup: number
            rebuild: number
          }>(
            'SELECT (SELECT count(*) FROM pending WHERE NOT (failed_count>=? AND failing_since>0 AND failing_since<=?)) AS pending, (SELECT count(*) FROM pending WHERE retry_at<=?) AS due, (SELECT min(retry_at) FROM pending) AS retry, EXISTS(SELECT id FROM (SELECT shareable AS id FROM intentions WHERE shareable NOT IN (SELECT id FROM staging) UNION SELECT id FROM reclaims UNION SELECT id FROM cleanup WHERE id NOT IN (SELECT id FROM staging)) WHERE id NOT IN (SELECT id FROM pending)) AS cleanup, EXISTS(SELECT 1 FROM rebuild WHERE target=? AND (scanned=0 OR swept=0)) AS rebuild',
            GIVE_UP_FAILURES,
            Date.now() - GIVE_UP_AFTER_MS,
            Date.now(),
            INDEX_FORMAT_VERSION,
          )
          .one()
        if (
          obligation &&
          obligation.target === INDEX_FORMAT_VERSION &&
          !obligation.completed &&
          !policyPending &&
          !remaining.pending &&
          !remaining.cleanup &&
          !remaining.rebuild
        ) {
          await db
            .updateTable('search_index_workspace_rebuilds')
            .set({ completed: 1 })
            .where('workspace_id', '=', state.workspace)
            .where('target', '=', obligation.target)
            .execute()
        }
        if (
          !policyPending &&
          !remaining.pending &&
          !remaining.cleanup &&
          !remaining.rebuild
        )
          this.ctx.storage.sql.exec(
            'UPDATE state SET scanned_format=? WHERE EXISTS(SELECT 1 FROM rebuild WHERE target=? AND scanned=1 AND swept=1)',
            INDEX_FORMAT_VERSION,
            INDEX_FORMAT_VERSION,
          )
        // Delete only after both local and D1 work drain. The D1 predicates
        // also protect a concurrent source insert or migration target.
        if (
          !policyPending &&
          !remaining.pending &&
          !remaining.cleanup &&
          !remaining.rebuild &&
          !this.state()!.dirty
        )
          await db
            .deleteFrom('search_index_ready')
            .where('workspace_id', '=', state.workspace)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_policy_changes')
                    .select('id')
                    .where('workspace_id', '=', state.workspace),
                ),
              ),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_changes')
                    .select('id')
                    .where('workspace_id', '=', state.workspace),
                ),
              ),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_workspace_rebuilds')
                    .select('workspace_id')
                    .where('workspace_id', '=', state.workspace)
                    .where('completed', '=', 0),
                ),
              ),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('search_index_rebuilds')
                    .select('target')
                    .where('target', '>', INDEX_FORMAT_VERSION),
                ),
              ),
            )
            .execute()
        const feed = await db
          .selectFrom('search_index_changes')
          .select('id')
          .where('workspace_id', '=', state.workspace)
          .limit(1)
          .executeTakeFirst()
        const policyFeed = await db
          .selectFrom('search_index_policy_changes')
          .select('id')
          .where('workspace_id', '=', state.workspace)
          .limit(1)
          .executeTakeFirst()
        if (
          policyFeed ||
          policyPending ||
          feed ||
          this.state()!.dirty ||
          remaining.due ||
          remaining.cleanup ||
          remaining.rebuild
        )
          await this.ctx.storage.setAlarm(Date.now() + 1000)
        else if (remaining.retry !== null)
          await this.ctx.storage.setAlarm(
            Math.max(Date.now() + 1000, remaining.retry),
          )
        else await this.ctx.storage.deleteAlarm()
        if (cleanupFailure) throw cleanupFailure.cause
      } finally {
        await db.destroy()
      }
    } finally {
      // Signals received across any awaited operation belong to the next pass.
      // Recheck after idle scheduling so that it cannot overwrite their alarm.
      this.running = false
      if (this.#schemaReady && (this.state()?.dirty ?? 0) > unconsumed)
        await this.ctx.storage.setAlarm(Date.now() + 1000)
    }
  }
  private async refreshPolicy(
    db: ReturnType<typeof createDb>,
    workspace: string,
    kind: 'container' | 'workspace',
    key: string,
  ) {
    if (kind === 'workspace') {
      const row = await db
        .selectFrom('workspaces')
        .select('link_sharing_enabled')
        .where('id', '=', workspace)
        .executeTakeFirst()
      this.ctx.storage.sql.exec(
        'INSERT INTO workspace_policy(singleton,links) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET links=excluded.links',
        row?.link_sharing_enabled ?? 0,
      )
    } else {
      const row = await db
        .selectFrom('artifact_containers')
        .select([
          'id',
          'kind',
          'base_visibility',
          'created_by_id',
          'archived_at',
        ])
        .where('id', '=', key)
        .where('workspace_id', '=', workspace)
        .executeTakeFirst()
      if (row)
        this.ctx.storage.sql.exec(
          'INSERT INTO container_policy(id,kind,base,creator,archived) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,base=excluded.base,creator=excluded.creator,archived=excluded.archived',
          row.id,
          row.kind,
          row.base_visibility,
          row.created_by_id,
          row.archived_at,
        )
      else
        this.ctx.storage.sql.exec(
          'DELETE FROM container_policy WHERE id=?',
          key,
        )
    }
  }
  private async refreshFilePolicy(
    db: ReturnType<typeof createDb>,
    workspace: string,
    id: string,
  ) {
    const row = await db
      .selectFrom('shareables')
      .select([
        'owner_user_id',
        'container_id',
        'visibility',
        'link_expires_at',
        'link_suspended_at',
      ])
      .where('id', '=', id)
      .where('workspace_id', '=', workspace)
      .executeTakeFirst()
    if (!row) {
      this.ctx.storage.sql.exec('DELETE FROM file_policy WHERE id=?', id)
      return
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO file_policy(id,owner,container,visibility,expires,suspended) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,container=excluded.container,visibility=excluded.visibility,expires=excluded.expires,suspended=excluded.suspended',
      id,
      row.owner_user_id,
      row.container_id,
      row.visibility,
      row.link_expires_at,
      row.link_suspended_at,
    )
    if (row.container_id)
      await this.refreshPolicy(db, workspace, 'container', row.container_id)
    await this.refreshPolicy(db, workspace, 'workspace', workspace)
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
      compatibleContentFormat(active.format)
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
          compatibleContentFormat(object.customMetadata.format ?? '')
        const cached = reuse || resume ? await this.env.BUCKET.get(key) : null
        if (fits(cached)) {
          text = await cached!.json<ExtractedText>()
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
            ),
          ),
      ),
    )
    await this.deleteObjects(source.workspace_id, source.id, keep)
  }
  private async remove(workspace: string, id: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM file_policy WHERE id=?', id)
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO intentions(key,shareable) VALUES(?,?)',
      shareableSearchPrefix(workspace, id),
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
    try {
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
          prefix: shareableSearchPrefix(workspace, id),
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
    } catch (cause) {
      throw new SearchCleanupError(
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      )
    }
  }
}
