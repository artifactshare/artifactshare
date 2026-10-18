import { env } from 'cloudflare:workers'
import type { Route } from './+types/api.shareables.$id.sandbox-block-report'
import {
  handleSandboxBlockReport,
  reportMethodNotAllowed,
} from '~/services/sandbox-block-report.server'

export function loader() {
  return reportMethodNotAllowed()
}
export function action({ request, params }: Route.ActionArgs) {
  return handleSandboxBlockReport(
    request,
    params.id,
    env.SANDBOX_BLOCK_REPORT_RATELIMIT,
  )
}
