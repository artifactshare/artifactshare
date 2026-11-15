import {
  literalKey,
  type IndexSearchInput,
} from '../app/services/search-index/query'
import {
  seedSearchBenchmark,
  measureSearchBenchmark,
} from './search-benchmark-worker'
import {
  normalizeSearchText,
  katakanaRuns,
  INDEX_FORMAT_VERSION,
} from '../app/services/search-index/normalize'
import { WorkspaceSearchIndex as Index } from '../workers/workspace-search-index'

export type SearchProbeDocument = {
  id: string
  title: string
  chunks: Array<{ body: string; script?: string }>
  path?: string
  generation?: string
  active?: boolean
  activityAt?: string
}
type Point = 'registry' | 'idle' | 'put' | 'cleanup'

/** Test-only storage gates: the implementation still runs against real D1, R2 and DO SQL. */
export class WorkspaceSearchIndex extends Index {
  private readonly constructorChanges: number
  private readonly gates: Map<
    Point,
    { reached: boolean; release: () => void; wait: Promise<void> }
  >
  private readonly failures: Map<Point, number>
  private readonly operations: { lists: number }

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const gates = new Map<
      Point,
      { reached: boolean; release: () => void; wait: Promise<void> }
    >()
    const failures = new Map<Point, number>()
    const operations = { lists: 0 }
    const reach = async (point: Point) => {
      const gate = gates.get(point)
      if (gate) {
        gate.reached = true
        await gate.wait
      }
      const remaining = failures.get(point)
      if (remaining === 0) throw new Error(`injected_${point}_failure`)
      if (remaining !== undefined) failures.set(point, remaining - 1)
    }
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === 'list')
          return (...args: Parameters<R2Bucket['list']>) => {
            operations.lists++
            return target.list(...args)
          }
        if (property === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            if (String(args[0]).startsWith('search-text/')) await reach('put')
            return target.put(...args)
          }
        if (property === 'delete')
          return async (...args: Parameters<R2Bucket['delete']>) => {
            await reach('cleanup')
            return target.delete(...args)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === 'bind')
                    return (...args: unknown[]) => wrap(prepared.bind(...args))
                  if (method === 'all')
                    return async () => {
                      if (/insert into "search_index_workspaces"/iu.test(query))
                        await reach('registry')
                      if (/select "id" from "workspaces"/iu.test(query))
                        await reach('idle')
                      return prepared.all()
                    }
                  const value = Reflect.get(prepared, method)
                  return typeof value === 'function'
                    ? value.bind(prepared)
                    : value
                },
              })
            return wrap(target.prepare(query))
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const before = ctx.storage.sql
      .exec<{ n: number }>('SELECT total_changes() AS n')
      .one().n
    super(ctx, { ...env, DB: database, BUCKET: bucket })
    this.constructorChanges =
      ctx.storage.sql.exec<{ n: number }>('SELECT total_changes() AS n').one()
        .n - before
    this.gates = gates
    this.failures = failures
    this.operations = operations
  }
  queryState() {
    return {
      constructorChanges: this.constructorChanges,
      changes: this.ctx.storage.sql
        .exec<{ n: number }>('SELECT total_changes() AS n')
        .one().n,
    }
  }
  seedDocuments(documents: SearchProbeDocument[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const row of documents) {
        const generation = row.generation ?? 'current'
        const document = this.ctx.storage.sql
          .exec<{ id: number }>(
            'INSERT INTO documents(shareable,version,path,generation,owner,container,updated_at,normalized_title,title_key,activity_at,complete) VALUES(?,?,?,?,?,?,?,?,?,?,1) RETURNING id',
            row.id,
            'version',
            row.path ?? 'index.html',
            generation,
            'owner',
            'home',
            '2026-09-15T00:00:00.000Z',
            normalizeSearchText(row.title),
            literalKey(row.title),
            row.activityAt ?? '2026-09-15T00:00:00.000Z',
          )
          .one().id
        if (row.active !== false)
          this.ctx.storage.sql.exec(
            'INSERT OR REPLACE INTO active(id,generation,fingerprint,content,format) VALUES(?,?,?,?,?)',
            row.id,
            generation,
            'seed',
            'seed',
            INDEX_FORMAT_VERSION,
          )
        for (const [ordinal, text] of row.chunks.entries()) {
          const chunk = this.ctx.storage.sql
            .exec<{ id: number }>(
              'INSERT INTO chunks(document,ordinal) VALUES(?,?) RETURNING id',
              document,
              ordinal,
            )
            .one().id
          this.ctx.storage.sql.exec(
            'INSERT INTO search(rowid,title,body,script) VALUES(?,?,?,?)',
            chunk,
            ordinal === 0 ? normalizeSearchText(row.title) : '',
            normalizeSearchText(text.body),
            normalizeSearchText(text.script ?? ''),
          )
          this.ctx.storage.sql.exec(
            'INSERT INTO search_runs(rowid,katakana) VALUES(?,?)',
            chunk,
            katakanaRuns([row.title, text.body, text.script ?? ''].join(' ')),
          )
          this.ctx.storage.sql.exec(
            'INSERT INTO snippets(document,ordinal,body) VALUES(?,?,?)',
            document,
            ordinal,
            text.body,
          )
        }
      }
    })
  }
  seedSearch(
    workspace: string,
    offset: number,
    count: number,
    size: number,
  ): void {
    this.ctx.storage.transactionSync(() => {
      for (let i = offset; i < offset + count; i++) {
        const id = `${workspace}-${i}`
        const key = (size >= 4 && i === size - 2 ? 0 : i)
          .toString(26)
          .replace(/[0-9a-p]/g, (c) =>
            String.fromCharCode(97 + parseInt(c, 26)),
          )
        const title = `alpha ${key}`
        const document = this.ctx.storage.sql
          .exec<{ id: number }>(
            'INSERT INTO documents(shareable,version,path,generation,owner,container,updated_at,normalized_title,title_key,activity_at,complete) VALUES(?,?,?,?,?,?,?,?,?,?,1) RETURNING id',
            id,
            'version',
            'index.html',
            'current',
            `${workspace}-${i === size - 1 ? 'owner' : 'actor'}`,
            `${workspace}-home`,
            '2026-09-15T00:00:00.000Z',
            normalizeSearchText(title),
            title,
            '2026-09-15T00:00:00.000Z',
          )
          .one().id
        this.ctx.storage.sql.exec(
          'INSERT INTO active(id,generation,fingerprint,content,format) VALUES(?,?,?,?,?)',
          id,
          'current',
          'seed',
          'seed',
          INDEX_FORMAT_VERSION,
        )
        const chunk = this.ctx.storage.sql
          .exec<{ id: number }>(
            'INSERT INTO chunks(document,ordinal) VALUES(?,0) RETURNING id',
            document,
          )
          .one().id
        this.ctx.storage.sql.exec(
          'INSERT INTO search(rowid,title,body,script) VALUES(?,?,?,?)',
          chunk,
          normalizeSearchText(title),
          'alpha payload body',
          '',
        )
        this.ctx.storage.sql.exec(
          'INSERT INTO snippets(document,ordinal,body) VALUES(?,0,?)',
          document,
          'alpha payload body',
        )
      }
    })
  }
  listCount(): number {
    return this.operations.lists
  }
  pause(point: Point): void {
    const deferred = Promise.withResolvers<void>()
    this.gates.set(point, {
      reached: false,
      release: deferred.resolve,
      wait: deferred.promise,
    })
  }
  reached(point: Point): boolean {
    return this.gates.get(point)?.reached ?? false
  }
  release(point: Point): void {
    this.gates.get(point)?.release()
    this.gates.delete(point)
  }
  fail(point: Point, after = 0): void {
    this.failures.set(point, after)
  }
  async attemptSync(workspace: string): Promise<{ error: string | null }> {
    try {
      await super.sync(workspace)
      return { error: null }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  resume(): Promise<void> {
    return super.alarm()
  }
  async resumeAt(now: number): Promise<void> {
    const original = Date.now
    Date.now = () => now
    try {
      await super.alarm()
    } finally {
      Date.now = original
    }
  }
  nextAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm()
  }
}

import app from '../workers/app'

type ProbeEnv = Omit<Cloudflare.Env, 'WORKSPACE_SEARCH_INDEX'> & {
  WORKSPACE_SEARCH_INDEX: DurableObjectNamespace<WorkspaceSearchIndex>
}
// Fetch scopes release RPC references before eviction; the Node binding proxy
// otherwise retains its remote stub until garbage collection.
export default {
  ...app,
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname !== '/__test/search-index')
      return app.fetch(request, env, ctx)
    const command = await request.json<{
      workspace: string
      action: string
      point: Point
      after?: number
      now: number
      input: IndexSearchInput
      ids: string[]
      documents: SearchProbeDocument[]
      size: number
      warmup: number
      samples: number
    }>()
    const stub = env.WORKSPACE_SEARCH_INDEX.getByName(`${command.workspace}:0`)
    let result: unknown
    switch (command.action) {
      case 'seedDocuments':
        result = await stub.seedDocuments(command.documents)
        break
      case 'queryState':
        result = await stub.queryState()
        break
      case 'search':
        result = await stub.search(command.input)
        break
      case 'details':
        result = await stub.details(command.input, command.ids)
        break
      case 'seedSearch':
        await seedSearchBenchmark(env, command.workspace, command.size)
        for (let offset = 0; offset < command.size; offset += 500)
          // Keep one bounded storage batch in flight on this single DO.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await stub.seedSearch(
            command.workspace,
            offset,
            Math.min(500, command.size - offset),
            command.size,
          )
        result = { size: command.size }
        break
      case 'measureSearch':
        result = await measureSearchBenchmark(
          env,
          command.workspace,
          command.warmup,
          command.samples,
        )
        break
      case 'sync':
        result = await stub.sync(command.workspace)
        break
      case 'attemptSync':
        result = await stub.attemptSync(command.workspace)
        break
      case 'resume':
        result = await stub.resume()
        break
      case 'resumeAt':
        result = await stub.resumeAt(command.now)
        break
      case 'pause':
        result = await stub.pause(command.point)
        break
      case 'release':
        result = await stub.release(command.point)
        break
      case 'reached':
        result = await stub.reached(command.point)
        break
      case 'fail':
        result = await stub.fail(command.point, command.after)
        break
      case 'listCount':
        result = await stub.listCount()
        break
      case 'nextAlarm':
        result = await stub.nextAlarm()
        break
      default:
        throw new Error('unknown_search_probe_command')
    }
    return Response.json(result ?? null)
  },
}
