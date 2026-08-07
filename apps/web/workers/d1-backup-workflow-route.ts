import type { Workflow } from '@cloudflare/workers-types'

export async function handleD1BackupWorkflow(
  request: Request,
  workflow: Workflow<unknown>,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }
  try {
    const body = await request.json().catch(() => ({}))
    const instance = await workflow.create({
      id: crypto.randomUUID(),
      params: body,
    })
    return Response.json(
      { id: instance.id, status: await instance.status() },
      { status: 202 },
    )
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
