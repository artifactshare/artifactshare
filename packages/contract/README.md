# @artifactshare/contract

Zod 4 schemas and inferred TypeScript types for the public Artifact Share CLI
API surface.

The package describes the wire payloads used by the CLI and its device
authorization flow. It keeps the API's existing snake_case and camelCase field
names, nullable fields, and legacy refresh request/response shapes intact.

```ts
import {
  CliAuthRefreshRequestSchema,
  CliAuthRefreshResponseSchema,
} from '@artifactshare/contract'

const request = CliAuthRefreshRequestSchema.parse({
  refresh_token: 'asr_refresh',
})
const response = CliAuthRefreshResponseSchema.parse({
  access_token: 'ass_session',
  token_type: 'Bearer',
  expires_at: '2026-12-31T00:00:00.000Z',
})
```

The package contains schemas only; it does not make network requests or change
route behavior.

Device verification uses `GET /api/auth/device` with `user_code`; approval and
denial use `userCode` in their POST bodies. Verification lookup is public; the
browser signs in first so the session claims the code before a decision. Its response schema describes only the optional `status`
read by the public adapter. Approval and denial success body schemas are
intentionally omitted because the public adapters inspect HTTP success and
errors without reading response fields. Endpoint error statuses describe
concrete adapter and middleware outcomes, not every possible upstream failure.
