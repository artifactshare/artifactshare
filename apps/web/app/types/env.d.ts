// Augments the wrangler-generated Cloudflare.Env with secrets.
// Secrets live in `.dev.vars` (local) / `wrangler secret put` (remote);
// they are never written to wrangler.jsonc, so they don't get typed
// automatically. Mirror the names here.

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    MICROSOFT_CLIENT_ID: string
    MICROSOFT_CLIENT_SECRET: string
    BUCKET: R2Bucket
    BACKUP_BUCKET: R2Bucket
    D1_BACKUP_ACCOUNT_ID: string
    D1_BACKUP_DATABASE_ID: string
    D1_BACKUP_WORKFLOW: Workflow
    D1_REST_API_TOKEN: string
    VIEW_DEDUP: KVNamespace
    VIEWER_RATELIMIT?: import('../services/viewer-rate-limit.server').ViewerRateLimiter
    ARTIFACT_LIVE: DurableObjectNamespace<
      import('../../workers/artifact-live-room').ArtifactLiveRoom
    >
    POST_UPLOAD_WORKFLOW?: Workflow<PostUploadWorkflowSpikePayload>
    OG_IMAGE_WORKER: Fetcher
    STRIPE_SECRET_KEY?: string
    OPENAI_APPS_CHALLENGE_TOKEN?: string
    GA4_MEASUREMENT_ID?: string
    GA4_MP_API_SECRET?: string
    STRIPE_WEBHOOK_SECRET?: string
    STRIPE_PRODUCT_STORAGE_OVERAGE: string
    SLACK_SIGNING_SECRET?: string
    SLACK_BOT_TOKEN?: string
    SLACK_CLIENT_ID?: string
    SLACK_CLIENT_SECRET?: string
    SLACK_LINK_STATE_SECRET?: string
    SLACK_LOGGING_LEVEL?: string
    SLACK_PREVIEW_FONT_KV?: KVNamespace
    // Slack incoming webhook for production failure alerts. Unset → alert
    // producers log locally and skip Slack, so normal traffic is not blocked.
    SLACK_ALERT_WEBHOOK_URL?: string
    // Local-dev bearer token that bypasses OAuth on the MCP endpoint
    // (non-production only), so tools can be exercised without a browser login.
    // Typed required like the other provisioned secrets but guarded at runtime,
    // so an unset value fails closed rather than throwing.
    MCP_DEV_TOKEN: string
    // Comma-separated Flagship flag keys enabled in non-production when the
    // FLAGS binding is absent (e.g. local wrangler dev).
    DEV_FLAGS?: string
  }
}

// Cloudflare extends the standard CacheStorage with a `default` Cache.
// Wrangler's generated types don't include it, so augment here.
interface CacheStorage {
  readonly default: Cache
}

interface PostUploadWorkflowSpikePayload {
  shareable_id?: string
  version_id?: string
  r2_prefix?: string
  should_fail?: boolean
}
