import { describe, expect, it } from 'vitest'
import {
  API_ERROR_RESPONSE_SCHEMA,
  ARTIFACT_APPEND_REQUEST_SCHEMA,
  ARTIFACT_DELETE_RESPONSE_SCHEMA,
  ARTIFACT_READ_RESPONSE_SCHEMA,
  ARTIFACT_UPLOAD_RESPONSE_SCHEMA,
  CLI_API_ENDPOINTS,
  CLI_DOCTOR_RESPONSE_SCHEMA,
  CLI_AUTH_REFRESH_REQUEST_SCHEMA,
  CLI_AUTH_REFRESH_RESPONSE_SCHEMA,
  CLI_EDIT_REQUEST_SCHEMA,
  CLI_MOVE_REQUEST_SCHEMA,
  CLI_MOVE_RESPONSE_SCHEMA,
  CLI_WHOAMI_RESPONSE_SCHEMA,
  COMMENT_REQUEST_SCHEMA,
  COMMENTS_LIST_RESPONSE_SCHEMA,
  DeviceApproveRequestSchema,
  DeviceDenyRequestSchema,
  DeviceVerifyQuerySchema,
  DeviceVerifyResponseSchema,
  DEVICE_CODE_REQUEST_SCHEMA,
  DEVICE_CODE_RESPONSE_SCHEMA,
  DEVICE_TOKEN_REQUEST_SCHEMA,
  DEVICE_TOKEN_RESPONSE_SCHEMA,
  DOWNLOAD_MANIFEST_RESPONSE_SCHEMA,
  ArtifactReadQueryParamsSchema,
  ProjectCreateRequestSchema,
  ProjectEditRequestSchema,
  PROJECT_EDIT_RESPONSE_SCHEMA,
  PROJECTS_LIST_RESPONSE_SCHEMA,
  RESOLVE_RESPONSE_SCHEMA,
} from './index.js'

const shareUrl = 'https://artifactshare.example/a/abc123def4'

describe('@artifactshare/contract', () => {
  it('accepts both rotating and legacy refresh wire shapes', () => {
    expect(
      CLI_AUTH_REFRESH_REQUEST_SCHEMA.parse({
        refresh_token: 'asr_legacy',
      }),
    ).toEqual({ refresh_token: 'asr_legacy' })
    expect(
      CLI_AUTH_REFRESH_REQUEST_SCHEMA.parse({
        refresh_token: 'asr_refresh',
        rotation_request_id: 'rotation-1',
      }),
    ).toEqual({
      refresh_token: 'asr_refresh',
      rotation_request_id: 'rotation-1',
    })

    expect(
      CLI_AUTH_REFRESH_RESPONSE_SCHEMA.parse({
        access_token: 'ass_session',
        token_type: 'Bearer',
        expires_at: '2026-12-31T00:00:00.000Z',
      }),
    ).toEqual({
      access_token: 'ass_session',
      token_type: 'Bearer',
      expires_at: '2026-12-31T00:00:00.000Z',
    })
    expect(
      CLI_AUTH_REFRESH_RESPONSE_SCHEMA.parse({
        access_token: 'ass_session',
        token_type: 'Bearer',
        expires_at: '2026-06-28T00:00:00.000Z',
        refresh_token: 'asr_rotated',
        refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
      }),
    ).toMatchObject({ refresh_token: 'asr_rotated' })
  })

  it('rejects malformed auth and append requests', () => {
    expect(() =>
      CLI_AUTH_REFRESH_REQUEST_SCHEMA.parse({ refresh_token: '' }),
    ).toThrow()
    expect(() =>
      CLI_AUTH_REFRESH_REQUEST_SCHEMA.parse({
        refresh_token: 'asr_refresh',
        rotation_request_id: null,
      }),
    ).toThrow()
    expect(() =>
      ARTIFACT_APPEND_REQUEST_SCHEMA.parse({ content: '' }),
    ).toThrow()
  })

  it('validates representative artifact, upload, and download responses', () => {
    const artifact = ARTIFACT_READ_RESPONSE_SCHEMA.parse({
      id: 'abc123def4',
      share_url: shareUrl,
      version_id: 'ver123',
      format: 'markdown',
      content: '# Report',
      size_bytes: 8,
      truncated: false,
      next_offset: null,
      link_expires_at: null,
      project_id: null,
      versions: [
        {
          version_id: 'ver123',
          status: 'published',
          size_bytes: 8,
          created_at: '2026-06-18T00:00:00.000Z',
          published_at: '2026-06-18T00:00:01.000Z',
          is_current: true,
          creator: {
            kind: 'human',
            name: 'Owner',
            email: 'owner@example.com',
            agent_profile_id: null,
          },
        },
      ],
      versions_has_more: false,
    })
    expect(artifact.id).toBe('abc123def4')
    expect(() =>
      ARTIFACT_READ_RESPONSE_SCHEMA.parse({ ...artifact, comments: [{}] }),
    ).toThrow()
    expect(
      ArtifactReadQueryParamsSchema.parse({
        offset: '200000',
        include: ['versions, comments'],
      }),
    ).toEqual({ offset: '200000', include: ['versions, comments'] })
    expect(() =>
      ArtifactReadQueryParamsSchema.parse({ include: ['versions, owners'] }),
    ).toThrow()

    expect(
      ARTIFACT_UPLOAD_RESPONSE_SCHEMA.parse({
        id: 'abc123def4',
        versionId: 'ver123',
        artifactKind: 'markdown_page',
        visibility: 'private',
        link_expires_at: null,
        containerId: null,
        shareUrl,
        created: true,
        warnings: [
          {
            code: 'slack_reauthorization_required',
            message: 'Reconnect Slack before the next notification.',
          },
        ],
      }),
    ).toMatchObject({ artifactKind: 'markdown_page' })
    expect(
      ARTIFACT_UPLOAD_RESPONSE_SCHEMA.parse({
        id: 'site123abc',
        versionId: 'ver123',
        artifactKind: 'static_site',
        shareUrl,
      }),
    ).toMatchObject({ artifactKind: 'static_site' })

    expect(
      DOWNLOAD_MANIFEST_RESPONSE_SCHEMA.parse({
        id: 'site123abc',
        share_url: shareUrl,
        version_id: 'ver123',
        artifact_kind: 'static_site',
        files: [
          {
            path: '/index.html',
            size_bytes: 24,
            content_type: 'text/html',
            sha256: 'sha-index',
          },
        ],
        total_size_bytes: 24,
        project_id: 'prj1',
      }),
    ).toMatchObject({ files: [{ path: '/index.html' }] })

    expect(() =>
      DOWNLOAD_MANIFEST_RESPONSE_SCHEMA.parse({
        id: 'site123abc',
        share_url: shareUrl,
        version_id: 'ver123',
        artifact_kind: 'static_site',
        files: [{ path: '/index.html', size_bytes: '24' }],
        total_size_bytes: 24,
        project_id: null,
      }),
    ).toThrow()
  })

  it('keeps comment actions separate from post payloads', () => {
    const list = COMMENTS_LIST_RESPONSE_SCHEMA.parse({
      artifact_id: 'abc123def4',
      share_url: shareUrl,
      comments: [
        {
          id: 'thr1',
          status: 'open',
          resolved_at: null,
          created_at: '2026-06-10T00:00:00.000Z',
          updated_at: '2026-06-10T00:00:00.000Z',
          anchor: { kind: 'artifact', quoted_text: null, state: null },
          messages: [
            {
              message_id: 'msg1',
              author_name: 'Coji',
              author_email: 'owner@example.com',
              agent: null,
              body: 'First comment',
              created_at: '2026-06-10T00:00:00.000Z',
              updated_at: '2026-06-10T00:00:00.000Z',
            },
          ],
        },
      ],
      has_more: false,
    })
    expect(list.comments).toHaveLength(1)

    expect(
      COMMENT_REQUEST_SCHEMA.parse({
        body: 'Please fix this',
        quote: 'exact text',
        quote_before: 'lead ',
        quote_after: ' tail',
      }),
    ).toMatchObject({ quote: 'exact text' })
    expect(
      COMMENT_REQUEST_SCHEMA.parse({
        action: 'delete',
        thread_id: 'thr1',
      }),
    ).toEqual({ action: 'delete', thread_id: 'thr1' })
    expect(() =>
      COMMENT_REQUEST_SCHEMA.parse({
        body: 'missing quote',
        quote_before: 'context',
      }),
    ).toThrow()
    expect(() =>
      COMMENT_REQUEST_SCHEMA.parse({ action: 'resolve', thread_id: '' }),
    ).toThrow()
  })

  it('preserves edit dispatch and rejects malformed actions instead of posting', () => {
    const edit = { action: 'edit', message_id: 'msg1', body: 'Updated comment' }
    expect(COMMENT_REQUEST_SCHEMA.parse(edit)).toEqual(edit)
    for (const payload of [
      { ...edit, message_id: '' },
      { action: 'edit', body: 'Missing message id' },
      { ...edit, body: '' },
      { ...edit, action: 'unknown' },
      { ...edit, action: null },
    ]) {
      expect(COMMENT_REQUEST_SCHEMA.safeParse(payload).success).toBe(false)
    }
    expect(COMMENT_REQUEST_SCHEMA.parse({ body: 'New comment' })).toEqual({
      body: 'New comment',
    })
  })

  it('describes the existing browser device verification and decision payloads', () => {
    expect(DeviceVerifyQuerySchema.parse({ user_code: 'ABCD1234' })).toEqual({
      user_code: 'ABCD1234',
    })
    expect(DeviceDenyRequestSchema.parse({ userCode: 'ABCD1234' })).toEqual({
      userCode: 'ABCD1234',
    })
    expect(DeviceApproveRequestSchema.parse({ userCode: 'ABCD1234' })).toEqual({
      userCode: 'ABCD1234',
    })
    expect(
      DeviceApproveRequestSchema.parse({
        userCode: 'ABCD1234',
        project_id: 'prj1',
      }),
    ).toEqual({ userCode: 'ABCD1234', project_id: 'prj1' })
    for (const status of [
      'pending',
      'approved',
      'denied',
      'expired',
      'used',
      'already_handled',
    ]) {
      expect(DeviceVerifyResponseSchema.parse({ status })).toEqual({ status })
    }
    expect(DeviceVerifyResponseSchema.parse({})).toEqual({})
    for (const value of [null, { status: 1 }]) {
      expect(DeviceVerifyResponseSchema.safeParse(value).success).toBe(false)
    }
    for (const value of [
      {},
      { user_code: '' },
      { user_code: null },
      { userCode: 'ABCD1234' },
    ]) {
      expect(DeviceVerifyQuerySchema.safeParse(value).success).toBe(false)
    }
    for (const value of [
      {},
      { userCode: '' },
      { userCode: null },
      { user_code: 'ABCD1234' },
    ]) {
      expect(DeviceDenyRequestSchema.safeParse(value).success).toBe(false)
    }
    expect(CLI_API_ENDPOINTS.deviceVerify).toMatchObject({
      path: '/api/auth/device',
      method: 'GET',
      auth: 'public',
      errorStatuses: [400],
    })
    expect(CLI_API_ENDPOINTS.deviceDeny).toMatchObject({
      path: '/api/auth/device/deny',
      method: 'POST',
      auth: 'session',
      errorStatuses: [400, 401, 403],
    })
    expect(CLI_API_ENDPOINTS.deviceApproval.auth).toBe('session')
    expect(CLI_API_ENDPOINTS.deviceApprove.auth).toBe('session')
  })

  it('includes concrete route and adapter failure statuses', () => {
    for (const endpoint of [
      CLI_API_ENDPOINTS.artifactAppend,
      CLI_API_ENDPOINTS.artifactVersionUpdate,
      CLI_API_ENDPOINTS.artifactUpload,
    ]) {
      expect(endpoint.errorStatuses).toContain(404)
    }
    expect(CLI_API_ENDPOINTS.artifactAppend.errorStatuses).toContain(415)
    expect(CLI_API_ENDPOINTS.artifactUpload.errorStatuses).toContain(500)
    for (const endpoint of [
      CLI_API_ENDPOINTS.commentsPostOrAction,
      CLI_API_ENDPOINTS.projectsCreate,
      CLI_API_ENDPOINTS.projectEdit,
      CLI_API_ENDPOINTS.artifactEdit,
      CLI_API_ENDPOINTS.artifactMove,
    ]) {
      expect(endpoint.errorStatuses).toContain(405)
    }
    for (const endpoint of [
      CLI_API_ENDPOINTS.artifactDownloadManifest,
      CLI_API_ENDPOINTS.artifactDownloadFile,
    ]) {
      expect(endpoint.errorStatuses).toContain(400)
    }
    // A valid scoped bearer can be rejected before any route adapter runs.
    for (const endpoint of Object.values(CLI_API_ENDPOINTS)) {
      if (endpoint.auth === 'bearer_or_session') {
        expect(endpoint.errorStatuses).toContain(403)
      }
    }
  })

  it('validates mutation and identity response contracts', () => {
    expect(
      ARTIFACT_DELETE_RESPONSE_SCHEMA.parse({
        id: 'abc123def4',
        deleted: true,
      }),
    ).toEqual({ id: 'abc123def4', deleted: true })
    expect(CLI_MOVE_REQUEST_SCHEMA.parse({ destination: 'home' })).toEqual({
      destination: 'home',
    })
    expect(
      CLI_MOVE_RESPONSE_SCHEMA.parse({
        artifact: { id: 'abc123def4', url: shareUrl },
        destination: { type: 'home', project_id: null },
        share: { visibility: 'private', project_audience_may_change: false },
      }),
    ).toMatchObject({ destination: { type: 'home' } })
    expect(() =>
      CLI_EDIT_REQUEST_SCHEMA.parse({ visibility: 'project' }),
    ).toThrow()
    expect(() => ProjectEditRequestSchema.parse({})).toThrow()
    expect(
      ProjectCreateRequestSchema.parse({
        name: 'Launch review',
        description: null,
        base_visibility: 'private',
      }),
    ).toMatchObject({ base_visibility: 'private' })
    expect(
      CLI_WHOAMI_RESPONSE_SCHEMA.parse({
        user: { id: 'u1', email: 'owner@example.com' },
        workspace: { id: 'w1', hosted_domain: null },
        auth: { kind: 'bearer_or_session' },
      }),
    ).toMatchObject({ workspace: { id: 'w1' } })
    expect(
      CLI_DOCTOR_RESPONSE_SCHEMA.parse({
        user: { id: 'u1', email: 'owner@example.com' },
        workspace: { id: 'w1', hosted_domain: 'example.com' },
        auth: {
          kind: 'bearer_or_session',
          ok: true,
          authority: { preset: 'agent', project_id: 'prj1' },
        },
        upload: {
          ok: false,
          code: 'self-upload-disabled',
          message: 'Sign in.',
        },
      }),
    ).toMatchObject({ auth: { authority: { preset: 'agent' } } })
  })

  it('validates project, resolve, device auth, and shared error payloads', () => {
    expect(
      PROJECTS_LIST_RESPONSE_SCHEMA.parse({
        projects: [
          {
            id: 'prj1',
            name: 'Launch review',
            description: null,
            base_visibility: 'workspace',
            file_count: 3,
            updated_at: '2026-06-09T00:00:00.000Z',
          },
        ],
      }),
    ).toMatchObject({ projects: [{ id: 'prj1' }] })
    expect(
      PROJECT_EDIT_RESPONSE_SCHEMA.parse({
        project: {
          id: 'prj1',
          name: 'Launch review',
          description: null,
          base_visibility: 'workspace',
          file_count: 3,
          archived: false,
        },
        audience: ['viewer@example.com'],
      }),
    ).toMatchObject({ project: { archived: false } })
    expect(
      RESOLVE_RESPONSE_SCHEMA.parse({
        query: 'Weekly report',
        candidates: [
          {
            kind: 'artifact',
            id: 'abc123def4',
            title: 'Weekly report',
            artifact_kind: 'html_page',
            visibility: 'private',
            project: null,
            owner: { id: 'u1', email: 'owner@example.com' },
            updated_at: '2026-06-18T00:00:00.000Z',
            match: { kind: 'title', confidence: 'exact' },
          },
        ],
        has_more: false,
      }),
    ).toMatchObject({ candidates: [{ kind: 'artifact' }] })

    expect(
      DEVICE_CODE_REQUEST_SCHEMA.parse({
        client_id: 'artifactshare-cli',
        preset: 'agent',
        device_name: 'laptop',
        project_selector: 'Launch review',
      }),
    ).toMatchObject({ preset: 'agent' })
    expect(
      DEVICE_CODE_RESPONSE_SCHEMA.parse({
        device_code: 'device-code-1',
        user_code: 'ABCD1234',
        verification_uri: 'https://artifactshare.example/device',
        expires_in: 600,
        interval: 5,
      }),
    ).toMatchObject({ user_code: 'ABCD1234' })
    expect(
      DEVICE_TOKEN_REQUEST_SCHEMA.parse({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-code-1',
        client_id: 'artifactshare-cli',
      }),
    ).toMatchObject({ client_id: 'artifactshare-cli' })
    expect(
      DEVICE_TOKEN_RESPONSE_SCHEMA.parse({
        access_token: 'ass_session',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ).toMatchObject({ access_token: 'ass_session' })
    expect(() =>
      DEVICE_TOKEN_RESPONSE_SCHEMA.parse({
        access_token: 'ass_session',
        token_type: 'Basic',
      }),
    ).toThrow()

    expect(
      API_ERROR_RESPONSE_SCHEMA.parse({
        error: {
          code: 'validation-failed',
          message: 'Invalid request.',
          details: { field: 'name' },
        },
      }),
    ).toMatchObject({ error: { code: 'validation-failed' } })
    expect(CLI_API_ENDPOINTS.authRefresh.errorStatuses).toContain(401)
    expect(CLI_API_ENDPOINTS.artifactUpload.path).toBe(
      '/api/shareables/uploads',
    )
  })

  it('preserves the old payload field names instead of normalizing them', () => {
    const parsed = CLI_EDIT_REQUEST_SCHEMA.parse({
      title: 'Renamed',
      link_expires_at: null,
      destination: { project_id: 'prj1' },
    })
    expect(parsed).toEqual({
      title: 'Renamed',
      link_expires_at: null,
      destination: { project_id: 'prj1' },
    })
  })
})
