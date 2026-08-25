import type {
  BridgeClient,
  BridgeCredential,
  BridgeResult,
  OwnedBridgeRequest,
} from './types.js'

export interface RecordedBridgeCall {
  request: OwnedBridgeRequest
  credential: BridgeCredential
}

export function createFakeBridgeClient(
  result: BridgeResult | ((request: OwnedBridgeRequest) => BridgeResult),
  credentialOrigin = 'https://artifactshare.com',
): BridgeClient & { readonly calls: RecordedBridgeCall[] } {
  const calls: RecordedBridgeCall[] = []
  return {
    calls,
    credentialOrigin,
    request(request, credential) {
      calls.push({ request, credential })
      return Promise.resolve(
        typeof result === 'function' ? result(request) : result,
      )
    },
  }
}

export function fixedRandomBytes(
  value: number,
): (length: number) => Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError('value must be one byte')
  }
  return (length) => new Uint8Array(length).fill(value)
}
