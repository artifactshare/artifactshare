import { WorkspaceSearchIndex as Index } from '../workers/workspace-search-index'

type Point = 'registry' | 'idle' | 'put' | 'cleanup'

/** Test-only storage gates: the implementation still runs against real D1, R2 and DO SQL. */
export class WorkspaceSearchIndex extends Index {
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
    super(ctx, { ...env, DB: database, BUCKET: bucket })
    this.gates = gates
    this.failures = failures
    this.operations = operations
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
    }>()
    const stub = env.WORKSPACE_SEARCH_INDEX.getByName(`${command.workspace}:0`)
    let result: unknown
    switch (command.action) {
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
