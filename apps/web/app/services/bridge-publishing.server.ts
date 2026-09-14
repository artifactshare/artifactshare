import type { Kysely } from 'kysely'
import { publish } from '~/modules/publish'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'
import type {
  BridgePublishResult,
  BridgePublishUser,
  BridgeRequestSuccess,
} from './bridge-publish-types.server'
import { parseTrustedBridgeContext } from './bridge-request-validation.server'

type BridgeAuthority = Extract<CliAuthority, { kind: 'bridge' }>

export type { BridgeRequestSuccess }
export type ExecuteBridgeRequestResult = BridgePublishResult

export async function executeBridgeRequest(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  user: BridgePublishUser,
  metadata: unknown,
  files: readonly File[],
  origin: string,
  now = new Date(),
): Promise<ExecuteBridgeRequestResult> {
  const contextResult = parseTrustedBridgeContext(metadata, authority, now)
  if (contextResult.kind !== 'ok') return contextResult

  const result = await publish({
    db,
    actor: {
      kind: 'bridge',
      user: { ...user, kind: user.kind ?? 'bot' },
      authority,
    },
    idempotencyKey: contextResult.context.requestId,
    bridge: {
      metadata,
      files,
      origin,
      now,
    },
  })
  return result.kind === 'forbidden'
    ? { kind: 'unsupported-authority' }
    : result
}
