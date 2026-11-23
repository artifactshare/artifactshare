import { env } from 'cloudflare:workers'
import { settingsSubmissionMiddleware } from '~/lib/settings-confirmation'
import {
  handleSandboxBlockReport,
  reportArtifactId,
} from '~/services/sandbox-block-report.server'

export const sandboxBlockReportMiddleware = settingsSubmissionMiddleware(
  ({ request, url }, next) => {
    const id = reportArtifactId(url.pathname)
    if (id === null) return next()
    return handleSandboxBlockReport(
      request,
      id,
      env.SANDBOX_BLOCK_REPORT_RATELIMIT,
    )
  },
)
