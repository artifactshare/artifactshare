export type BridgeServerErrorCode =
  | 'invalid-context'
  | 'stale-context'
  | 'unauthorized'
  | 'unsupported-authority'
  | 'fallback-invalid'
  | 'requester-mismatch'
  | 'mapping-archived'
  | 'conversation-identity-conflict'
  | 'project-limit-reached'
  | 'artifact-viewer-limit-reached'
  | 'project-name-conflict'
  | 'idempotency-in-progress'
  | 'idempotency-mismatch'
  | 'payload-too-large'
  | 'upload-failed'
  | 'forbidden-target'
  | 'rate-limited'
  | 'internal-error'

export function bridgeErrorResponse(
  code: BridgeServerErrorCode,
  message: string,
  status: number,
  options: { retryable?: boolean; retryAfterMs?: number } = {},
): Response {
  const retryable = options.retryable ?? false
  return Response.json(
    {
      schema_version: 1,
      ok: false,
      error: {
        code,
        message,
        retryable,
        ...(retryable && options.retryAfterMs !== undefined
          ? { retry_after_ms: options.retryAfterMs }
          : {}),
      },
    },
    { status },
  )
}
