export const LINK_REPORT_REASONS = [
  'phishing',
  'malware',
  'impersonation',
  'other',
] as const

export type LinkReportReason = (typeof LINK_REPORT_REASONS)[number]

export function isLinkReportReason(value: unknown): value is LinkReportReason {
  return (
    typeof value === 'string' &&
    (LINK_REPORT_REASONS as readonly string[]).includes(value)
  )
}
