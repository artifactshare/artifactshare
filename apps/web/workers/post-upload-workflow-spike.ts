import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'

type PostUploadWorkflowProbe = {
  received: {
    shareable_id: string | null
    version_id: string | null
    r2_prefix: string | null
  }
  d1_ok: boolean
  r2_ok: boolean
}

export class PostUploadWorkflowSpike extends WorkflowEntrypoint<
  Cloudflare.Env,
  PostUploadWorkflowSpikePayload
> {
  async run(
    event: Readonly<WorkflowEvent<PostUploadWorkflowSpikePayload>>,
    step: WorkflowStep,
  ): Promise<PostUploadWorkflowProbe> {
    const received = await step.do('normalize payload', () =>
      Promise.resolve({
        shareable_id: event.payload.shareable_id ?? null,
        version_id: event.payload.version_id ?? null,
        r2_prefix: event.payload.r2_prefix ?? null,
      }),
    )

    const d1 = await step.do('check d1 binding', async () => {
      const row = await this.env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sqlite_master',
      ).first<{ count: number }>()
      return { table_count_query_ok: typeof row?.count === 'number' }
    })

    const r2 = await step.do('check r2 binding', async () => {
      const listed = await this.env.BUCKET.list({
        prefix: received.r2_prefix ?? undefined,
        limit: 1,
      })
      return { list_succeeded: true, listed_keys: listed.objects.length }
    })

    await step.do(
      'optional failure probe',
      { retries: { limit: 2, delay: '1 second', backoff: 'constant' } },
      () => {
        if (event.payload.should_fail) {
          return Promise.reject(new Error('post upload workflow spike failure'))
        }
        return Promise.resolve({ should_fail: false })
      },
    )

    return {
      received,
      d1_ok: d1.table_count_query_ok,
      r2_ok: r2.list_succeeded,
    }
  }
}

export async function handlePostUploadWorkflowSpike(
  request: Request,
  workflow: Workflow<PostUploadWorkflowSpikePayload>,
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET') {
    const instanceId = url.searchParams.get('instance_id')
    if (!instanceId) {
      return Response.json(
        { error: 'instance_id query parameter is required' },
        { status: 400 },
      )
    }
    try {
      const instance = await workflow.get(instanceId)
      return Response.json({ id: instance.id, status: await instance.status() })
    } catch (err) {
      return workflowSpikeErrorResponse(err)
    }
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }

  const readResult = await readPostUploadWorkflowSpikePayload(request)
  if (!readResult.ok) return readResult.response

  try {
    const instance = await workflow.create({
      id: crypto.randomUUID(),
      params: readResult.payload,
    })
    return Response.json(
      { id: instance.id, status: await instance.status() },
      { status: 202 },
    )
  } catch (err) {
    return workflowSpikeErrorResponse(err)
  }
}

async function readPostUploadWorkflowSpikePayload(
  request: Request,
): Promise<
  | { ok: true; payload: PostUploadWorkflowSpikePayload }
  | { ok: false; response: Response }
> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType) return { ok: true, payload: {} }
  if (!contentType.includes('application/json')) {
    return {
      ok: false,
      response: Response.json(
        { error: 'content-type must be application/json' },
        { status: 415 },
      ),
    }
  }
  const body = await request.json().catch(() => undefined)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      response: Response.json({ error: 'invalid json body' }, { status: 400 }),
    }
  }
  const record = body as Record<string, unknown>
  return {
    ok: true,
    payload: {
      shareable_id:
        typeof record.shareable_id === 'string'
          ? record.shareable_id
          : undefined,
      version_id:
        typeof record.version_id === 'string' ? record.version_id : undefined,
      r2_prefix:
        typeof record.r2_prefix === 'string' ? record.r2_prefix : undefined,
      should_fail:
        typeof record.should_fail === 'boolean'
          ? record.should_fail
          : undefined,
    },
  }
}

function workflowSpikeErrorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  return Response.json({ error: message }, { status: 500 })
}
