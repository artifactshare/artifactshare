export const SANDBOX_PROBE_PATH = '/__artifactshare_probe'
export const SANDBOX_PROBE_MARKER = 'artifactshare-sandbox-probe-v1'

const confirmedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isUtcIsoMilliseconds(value: unknown): value is string {
  if (typeof value !== 'string' || !confirmedAtPattern.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

const SANDBOX_BLOCK_FAILURE_TYPES = [
  'forbidden',
  'network-error',
  'timeout',
] as const

export function isSandboxBlockFailureType(
  value: unknown,
): value is (typeof SANDBOX_BLOCK_FAILURE_TYPES)[number] {
  return (
    typeof value === 'string' &&
    (SANDBOX_BLOCK_FAILURE_TYPES as readonly string[]).includes(value)
  )
}

export function isSandboxArtifactId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{10}$/.test(value)
}
