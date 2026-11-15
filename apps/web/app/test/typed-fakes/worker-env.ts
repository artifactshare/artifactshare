import type { ScheduledWorkerEnv } from '../../../workers/app'
function unused(): never {
  throw new Error('Unused worker bucket method')
}
export function workerEnv(
  overrides: Partial<ScheduledWorkerEnv> = {},
): ScheduledWorkerEnv {
  return {
    BETTER_AUTH_URL: 'https://artifactshare.com',
    STRIPE_PRICE_PLUS_MONTHLY: '',
    STRIPE_PRICE_PLUS_YEARLY: '',
    STRIPE_PRICE_TEAM_MONTHLY: '',
    STRIPE_PRICE_TEAM_YEARLY: '',
    STRIPE_PRODUCT_STORAGE_OVERAGE: '',
    STRIPE_PORTAL_CONFIGURATION: '',
    BUCKET: {
      head: unused,
      get: unused,
      put: unused,
      delete: unused,
      list: unused,
      createMultipartUpload: unused,
      resumeMultipartUpload: unused,
    },
    ...overrides,
  }
}
