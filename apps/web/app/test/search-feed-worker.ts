import { WorkspaceSearchIndex as BaseIndex } from '../../workers/workspace-search-index'
import { workspaceSearchIndex } from '../services/search-index/names'

// Local runtime gates exercise the production class with real D1, SQLite and R2.
export class WorkspaceSearchIndex extends BaseIndex {
  private gates: {
    failCleanup: boolean
    failAck: boolean
    pause?: Promise<void>
    release?: () => void
    reached: boolean
  }
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const gates = {
      failCleanup: false,
      failAck: false,
      reached: false,
    } as WorkspaceSearchIndex['gates']
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (query: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(prepared, method) {
                if (method === 'bind')
                  return (...args: unknown[]) => wrap(prepared.bind(...args))
                if (method === 'all')
                  return async () => {
                    if (/delete from "search_index_changes"/iu.test(query)) {
                      if (gates.failAck) {
                        gates.failAck = false
                        throw new Error('synthetic acknowledgement failure')
                      }
                      if (gates.pause) {
                        gates.reached = true
                        await gates.pause
                        gates.pause = undefined
                      }
                    }
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
      },
    })
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === 'list')
          return (...args: Parameters<R2Bucket['list']>) => {
            if (gates.failCleanup) {
              gates.failCleanup = false
              throw new Error('synthetic cleanup failure')
            }
            return target.list(...args)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    super(ctx, { ...env, DB: database, BUCKET: bucket })
    this.gates = gates
  }
  seedLegacy(workspace: string) {
    this.ensureSchema()
    this.ctx.storage.sql.exec(
      'INSERT INTO state(singleton,workspace,dirty) VALUES(1,?,0)',
      workspace,
    )
    const id = `${workspace}-000`
    this.ctx.storage.sql.exec(
      "INSERT INTO active(id,generation,fingerprint,content,format) VALUES(?,'legacy','legacy','legacy',12)",
      id,
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO documents(id,shareable,version,path,generation,owner,container,updated_at,normalized_title,complete,expected_chunks) VALUES(1,?,'legacy-version','/index.html','legacy','legacy-owner','legacy-container','2026-01-01','legacy',1,1)",
      id,
    )
    this.ctx.storage.sql.exec(
      'INSERT INTO chunks(id,document,ordinal) VALUES(1,1,0)',
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO search(rowid,title,body,script) VALUES(1,'legacy','legacyneedle','')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO search_runs(rowid,katakana) VALUES(1,'')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO search_seams(rowid,title,body,script) VALUES(1,'legacy','legacyneedle','')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO snippets(document,ordinal,body) VALUES(1,0,'legacyneedle')",
    )
  }
  failCleanup() {
    this.gates.failCleanup = true
  }
  failAck() {
    this.gates.failAck = true
  }
  pauseAck() {
    this.gates.reached = false
    this.gates.pause = new Promise((resolve) => {
      this.gates.release = resolve
    })
  }
  reachedAck() {
    return this.gates.reached
  }
  releaseAck() {
    this.gates.release?.()
  }
  resume() {
    return this.alarm()
  }
  nextAlarm() {
    return this.ctx.storage.getAlarm()
  }
}

type SearchFeedTestEnv = Omit<Cloudflare.Env, 'WORKSPACE_SEARCH_INDEX'> & {
  WORKSPACE_SEARCH_INDEX: DurableObjectNamespace<WorkspaceSearchIndex>
}

// No product route imports this entrypoint.
export default {
  async fetch(request: Request, env: SearchFeedTestEnv) {
    const { workspace, action, query } = await request.json<{
      workspace: string
      action: string
      query?: string
    }>()
    const index = workspaceSearchIndex(env.WORKSPACE_SEARCH_INDEX, workspace)
    if (action === 'legacy') await index.seedLegacy(workspace)
    else if (action === 'sync') await index.sync(workspace)
    else if (action === 'alarm') await index.resume()
    else if (action === 'nextAlarm')
      return Response.json(await index.nextAlarm())
    else if (action === 'failCleanup') await index.failCleanup()
    else if (action === 'failAck') await index.failAck()
    else if (action === 'pauseAck') await index.pauseAck()
    else if (action === 'releaseAck') await index.releaseAck()
    else if (action === 'reachedAck')
      return Response.json(await index.reachedAck())
    else if (action === 'search')
      return Response.json(await index.search({ query: query! }))
    return Response.json({ ok: true })
  },
}
