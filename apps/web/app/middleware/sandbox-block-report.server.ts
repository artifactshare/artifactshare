import { env } from 'cloudflare:workers'
import type { MiddlewareFunction } from 'react-router'
import {
  handleSandboxBlockReport,
  reportArtifactId,
} from '~/services/sandbox-block-report.server'

export const sandboxBlockReportMiddleware: MiddlewareFunction = (
  { request, url },
  next,
) => {
  const id = reportArtifactId(url.pathname)
  if (id === null) return next()
  return handleSandboxBlockReport(
    request,
    id,
    env.SANDBOX_BLOCK_REPORT_RATELIMIT,
  )
}
