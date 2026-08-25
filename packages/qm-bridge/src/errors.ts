import type { BridgeErrorCode, BridgeFailure } from './types.js'

const MESSAGES: Record<BridgeErrorCode, string> = {
  invalid_intent: 'Share intent is invalid.',
  invalid_context: 'Trusted host context is invalid.',
  policy_denied: 'The conversation is not allowed by bridge policy.',
  credential_unavailable: 'Bridge credential is unavailable.',
  transport_error: 'Artifact Share could not be reached.',
  timeout: 'Artifact Share request timed out.',
  bridge_rejected: 'Artifact Share rejected the bridge request.',
  invalid_server_response:
    'Artifact Share returned an invalid bridge response.',
  internal_error: 'The bridge failed unexpectedly.',
}

export class BridgeValidationError extends Error {
  readonly code: 'invalid_intent' | 'invalid_context' | 'policy_denied'

  constructor(code: BridgeValidationError['code']) {
    super(MESSAGES[code])
    this.name = 'BridgeValidationError'
    this.code = code
  }
}

export function failure(
  code: BridgeErrorCode,
  options: {
    retryable?: boolean
    retry_after_ms?: number
    server_code?: string
  } = {},
): BridgeFailure {
  return {
    ok: false,
    code,
    message: MESSAGES[code],
    retryable: options.retryable ?? false,
    ...(options.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: options.retry_after_ms }),
    ...(options.server_code === undefined
      ? {}
      : { server_code: options.server_code }),
  }
}
