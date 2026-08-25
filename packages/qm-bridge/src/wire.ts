import type { OwnedBridgeRequest } from './types.js'

export function requestMetadata(
  request: OwnedBridgeRequest,
): Record<string, unknown> {
  return {
    schema_version: 1,
    request_id: request.context.request_id,
    operation: request.intent.operation,
    requested_audience: request.intent.requested_audience,
    ...(request.intent.target_artifact_id === undefined
      ? {}
      : { target_artifact_id: request.intent.target_artifact_id }),
    ...(request.intent.title === undefined
      ? {}
      : { title: request.intent.title }),
    source: request.context.source,
    conversation: request.context.conversation,
    requester: request.context.requester,
    ...(request.intent.content_kind === undefined
      ? {}
      : {
          content: {
            kind: request.intent.content_kind,
            files: request.files.map((file) => ({
              index: file.index,
              path: file.path,
              media_type: file.media_type,
              size: file.size,
              sha256: file.sha256,
            })),
          },
        }),
  }
}

export function metadataOverflowCode(
  request: OwnedBridgeRequest,
): 'invalid_context' | 'invalid_intent' | undefined {
  const encoder = new TextEncoder()
  if (
    encoder.encode(JSON.stringify(requestMetadata(request))).byteLength <=
    65_536
  ) {
    return undefined
  }
  const contextOnly = encoder.encode(
    JSON.stringify({
      schema_version: 1,
      request_id: request.context.request_id,
      source: request.context.source,
      conversation: request.context.conversation,
      requester: request.context.requester,
    }),
  )
  return contextOnly.byteLength > 65_536 ? 'invalid_context' : 'invalid_intent'
}
