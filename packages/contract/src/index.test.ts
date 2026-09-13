import { File as NodeFile } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  API_ERROR_RESPONSE_SCHEMA,
  ARTIFACT_APPEND_REQUEST_SCHEMA,
  ARTIFACT_APPEND_RESPONSE_SCHEMA,
  ARTIFACT_VERSION_UPDATE_RESPONSE_SCHEMA,
  ARTIFACT_DELETE_RESPONSE_SCHEMA,
  ARTIFACT_READ_RESPONSE_SCHEMA,
  ARTIFACT_UPLOAD_RESPONSE_SCHEMA,
  CLI_API_ENDPOINTS,
  CLI_DEVICE_CLIENT_ID,
  CLI_DOCTOR_RESPONSE_SCHEMA,
  CLI_AUTH_REFRESH_REQUEST_SCHEMA,
  CLI_AUTH_REFRESH_RESPONSE_SCHEMA,
  CLI_EDIT_REQUEST_SCHEMA,
  CLI_EDIT_RESPONSE_SCHEMA,
  CLI_MOVE_REQUEST_SCHEMA,
  CLI_MOVE_RESPONSE_SCHEMA,
  CLI_WHOAMI_RESPONSE_SCHEMA,
  COMMENT_REQUEST_SCHEMA,
  COMMENT_POST_RESPONSE_SCHEMA,
  COMMENT_ACTION_RESPONSE_SCHEMA,
  COMMENT_DELETE_RESPONSE_SCHEMA,
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
  ArtifactUploadFormSchema,
  ArtifactVersionUpdateFormSchema,
  ArtifactsListResponseSchema,
  CommentPostRequestSchema,
  ProjectCreateRequestSchema,
  ProjectEditRequestSchema,
  PROJECT_EDIT_RESPONSE_SCHEMA,
  PROJECTS_LIST_RESPONSE_SCHEMA,
  RESOLVE_RESPONSE_SCHEMA,
} from './index.js'

const shareUrl = 'https://artifactshare.example/a/abc123def4'

describe('@artifactshare/contract', () => {
  for (const [name, schema] of [
    ['upload', ArtifactUploadFormSchema],
    ['version update', ArtifactVersionUpdateFormSchema],
  ] as const) {
    it(`requires one or more repeated file parts for ${name}`, async () => {
      const form = new FormData()
      form.append('file', new Blob(['# Report']), 'index.md')
      const single = schema.parse({ file: form.getAll('file') })
      expect(single.file).toHaveLength(1)
      expect(single.file[0]).toBe(form.get('file'))
      expect(await single.file[0]!.arrayBuffer()).toEqual(
        await new Blob(['# Report']).arrayBuffer(),
      )

      form.append('file', new Blob(['body {}']), 'assets/style.css')
      const multiple = schema.parse({ file: form.getAll('file') })
      expect(multiple.file.map((file) => file.name)).toEqual([
        'index.md',
        'assets/style.css',
      ])
      for (const invalid of [
        {},
        { file: [] },
        { file: ['text'] },
        { file: [{}] },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false)
      }
    })
  }

  it('preserves multipart upload metadata wire values', () => {
    const input = {
      file: [new NodeFile([''], 'empty.md')],
      visibility: 'link',
      grant_email: ['reader@example.com', 'editor@example.com'],
      container_id: '',
      link_expires_at: 'null',
      slack_notify: 'false',
    }
    expect(ArtifactUploadFormSchema.parse(input)).toEqual(input)
  })

  it('imports and validates file parts without a global File constructor', async () => {
    vi.stubGlobal('File', undefined)
    vi.resetModules()
    try {
      const contract = await import('./index.js')
      const file = new NodeFile(['# Report'], 'index.md')
      expect(
        contract.ArtifactVersionUpdateFormSchema.parse({ file: [file] })
          .file[0],
      ).toBe(file)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('requires the agent preset for a device project selector', () => {
    const request = {
      client_id: CLI_DEVICE_CLIENT_ID,
      project_selector: 'Launch',
    }
    expect(
      DEVICE_CODE_REQUEST_SCHEMA.parse({ ...request, preset: 'agent' }),
    ).toEqual({
      ...request,
      preset: 'agent',
    })
    expect(DEVICE_CODE_REQUEST_SCHEMA.safeParse(request).success).toBe(false)
    expect(
      DEVICE_CODE_REQUEST_SCHEMA.safeParse({
        ...request,
        preset: 'unrestricted',
      }).success,
    ).toBe(false)
    expect(
      DEVICE_CODE_REQUEST_SCHEMA.parse({ client_id: CLI_DEVICE_CLIENT_ID }),
    ).toEqual({
      client_id: CLI_DEVICE_CLIENT_ID,
    })
  })

  it('accepts only the released CLI client ID on both device requests', () => {
    const token = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code-1',
    }
    for (const client_id of [CLI_DEVICE_CLIENT_ID, 'another-client']) {
      const expected = client_id === CLI_DEVICE_CLIENT_ID
      expect(DEVICE_CODE_REQUEST_SCHEMA.safeParse({ client_id }).success).toBe(
        expected,
      )
      expect(
        DEVICE_TOKEN_REQUEST_SCHEMA.safeParse({ ...token, client_id }).success,
      ).toBe(expected)
    }
  })

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

  it('accepts omitted response metadata supported by existing CLI callers', () => {
    // packages/cli/src/artifacts-get.test.ts and output.ts accept these omissions.
    const artifact = {
      id: 'abc123def4',
      share_url: shareUrl,
      version_id: 'ver123',
      format: 'markdown',
      content: '# Report',
      size_bytes: 8,
      truncated: false,
      next_offset: null,
    }
    expect(ARTIFACT_READ_RESPONSE_SCHEMA.parse(artifact)).toEqual(artifact)

    // artifactsListSuccessFields still requires project_id and pagination fields.
    const list = {
      artifacts: [
        {
          id: 'abc123def4',
          title: 'Weekly report',
          share_url: shareUrl,
          visibility: 'private',
          updated_at: '2026-06-18T00:00:00.000Z',
          project_id: null,
        },
      ],
      limit: 50,
      has_more: false,
      next_cursor: null,
    }
    expect(ArtifactsListResponseSchema.parse(list)).toEqual(list)
    expect(
      ArtifactsListResponseSchema.safeParse({
        ...list,
        artifacts: [{ ...list.artifacts[0], project_id: undefined }],
      }).success,
    ).toBe(false)
    expect(
      ArtifactsListResponseSchema.safeParse({
        ...list,
        artifacts: [{ ...list.artifacts[0], artifact_kind: null }],
      }).success,
    ).toBe(false)
    expect(
      ArtifactsListResponseSchema.parse({
        ...list,
        artifacts: [{ ...list.artifacts[0], link_expires_at: null }],
      }).artifacts[0]?.link_expires_at,
    ).toBeNull()

    // packages/cli/src/download.test.ts serves manifests without project_id.
    const manifest = {
      id: 'abc123def4',
      share_url: shareUrl,
      version_id: 'ver123',
      artifact_kind: 'markdown_page',
      files: [
        {
          path: '/index.md',
          size_bytes: 8,
          content_type: 'text/markdown',
          sha256: 'sha-index',
        },
      ],
      total_size_bytes: 8,
    }
    expect(DOWNLOAD_MANIFEST_RESPONSE_SCHEMA.parse(manifest)).toEqual(manifest)
    expect(
      DOWNLOAD_MANIFEST_RESPONSE_SCHEMA.parse({
        ...manifest,
        project_id: null,
      }).project_id,
    ).toBeNull()

    // packages/cli/src/comments.test.ts serves this minimal list response.
    const comments = { artifact_id: 'abc123def4', comments: [] }
    expect(COMMENTS_LIST_RESPONSE_SCHEMA.parse(comments)).toEqual(comments)
    expect(
      COMMENTS_LIST_RESPONSE_SCHEMA.parse({
        ...comments,
        share_url: null,
      }).share_url,
    ).toBeNull()
  })

  it('accepts null or omitted edit and move metadata without changing the wire shape', () => {
    // editData and moveData normalize missing URLs; editData also fills missing expiry.
    for (const artifact of [
      { id: 'abc123def4' },
      { id: 'abc123def4', url: null },
      { id: 'abc123def4', url: shareUrl },
    ]) {
      for (const share of [
        { visibility: 'private' },
        { visibility: 'private', link_expires_at: null },
        { visibility: 'link', link_expires_at: '2026-12-31T00:00:00.000Z' },
      ]) {
        const edit = {
          artifact,
          title: 'Report',
          destination: { type: 'home', project_id: null },
          share,
        }
        expect(CLI_EDIT_RESPONSE_SCHEMA.parse(edit)).toEqual(edit)
      }
      const move = {
        artifact,
        destination: { type: 'home', project_id: null },
        share: { visibility: 'private', project_audience_may_change: false },
      }
      expect(CLI_MOVE_RESPONSE_SCHEMA.parse(move)).toEqual(move)
    }
  })

  it('accepts null or omitted share URLs for every comment mutation', () => {
    // Each comment mutation runner passes share_url through configString.
    const thread = {
      id: 'thr1',
      status: 'open',
      resolved_at: null,
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
      anchor: { kind: 'artifact', quoted_text: null, state: null },
      messages: [],
    }
    const base = { artifact_id: 'abc123def4', thread_id: 'thr1' }
    for (const [schema, response] of [
      [COMMENT_POST_RESPONSE_SCHEMA, { ...base, thread, reply: false }],
      [COMMENT_ACTION_RESPONSE_SCHEMA, { ...base, thread }],
      [
        COMMENT_DELETE_RESPONSE_SCHEMA,
        { ...base, deleted: true, thread_deleted: true },
      ],
    ] as const) {
      for (const metadata of [
        {},
        { share_url: null },
        { share_url: shareUrl },
      ]) {
        const payload = { ...response, ...metadata }
        expect(schema.parse(payload)).toEqual(payload)
      }
      expect(schema.safeParse({ ...response, share_url: 123 }).success).toBe(
        false,
      )
    }
  })

  it('accepts minimal doctor responses and preserves full route metadata', () => {
    // doctor.test.ts serves the minimal response and authority without auth.kind.
    const minimal = {
      auth: { ok: true },
      user: { email: 'owner@example.com' },
      upload: { ok: true },
    }
    expect(CLI_DOCTOR_RESPONSE_SCHEMA.parse(minimal)).toEqual(minimal)
    const authority = { preset: 'agent', project_id: 'prj1' }
    const scoped = { ...minimal, auth: { ...minimal.auth, authority } }
    expect(CLI_DOCTOR_RESPONSE_SCHEMA.parse(scoped)).toEqual(scoped)
    const full = {
      ...minimal,
      user: { ...minimal.user, id: 'u1' },
      workspace: { id: 'w1', hosted_domain: null },
      auth: { ...minimal.auth, kind: 'bearer_or_session', authority },
    }
    expect(CLI_DOCTOR_RESPONSE_SCHEMA.parse(full)).toEqual(full)
    // Doctor compatibility must not relax whoami's separate identity contract.
    expect(CLI_WHOAMI_RESPONSE_SCHEMA.safeParse(minimal).success).toBe(false)
  })

  for (const [name, schema] of [
    ['append', ARTIFACT_APPEND_RESPONSE_SCHEMA],
    ['version update', ARTIFACT_VERSION_UPDATE_RESPONSE_SCHEMA],
  ] as const) {
    it(`accepts a version-only ${name} response before CLI fallback`, () => {
      // Both runners fill id/shareUrl before updateSuccessFields checks version.id.
      const minimal = { versionId: 'ver123' }
      expect(schema.parse(minimal)).toEqual(minimal)
      const full = {
        ...minimal,
        id: 'abc123def4',
        shareUrl,
        artifactKind: 'markdown_page',
      }
      expect(schema.parse(full)).toEqual(full)
      for (const invalid of [{}, { versionId: null }, { versionId: '' }]) {
        expect(schema.safeParse(invalid).success).toBe(false)
      }
    })
  }

  it('bounds trimmed project selectors by Unicode code points without changing the wire value', () => {
    // loginProjectSelector and normalizeProjectSelector both trim and count code points.
    for (const project_selector of [
      '😀'.repeat(61),
      '😀'.repeat(120),
      `  ${'界'.repeat(120)}  `,
      ` \t${'😀'.repeat(120)}\n`,
      ' x ',
    ]) {
      const request = {
        client_id: 'artifactshare-cli',
        preset: 'agent',
        project_selector,
      }
      expect(DEVICE_CODE_REQUEST_SCHEMA.parse(request)).toEqual(request)
    }
    for (const project_selector of [
      '',
      ' \t\n',
      '😀'.repeat(121),
      ` ${'界'.repeat(121)} `,
    ]) {
      expect(
        DEVICE_CODE_REQUEST_SCHEMA.safeParse({
          client_id: 'artifactshare-cli',
          preset: 'agent',
          project_selector,
        }).success,
      ).toBe(false)
    }
  })

  it('bounds agents after trimming and preserves empty or padded wire values', () => {
    // The comments route treats trimmed empty strings as absent and uses string.length.
    for (const agent of [
      '',
      ' '.repeat(31),
      ' \t\n',
      `  ${'a'.repeat(30)}  `,
      ` ${'😀'.repeat(15)} `,
    ]) {
      const request = { body: 'Comment', agent }
      expect(CommentPostRequestSchema.parse(request)).toEqual(request)
      expect(COMMENT_REQUEST_SCHEMA.parse(request)).toEqual(request)
    }
    for (const agent of [` ${'a'.repeat(31)} `, '😀'.repeat(16)]) {
      const request = { body: 'Comment', agent }
      expect(CommentPostRequestSchema.safeParse(request).success).toBe(false)
      expect(COMMENT_REQUEST_SCHEMA.safeParse(request).success).toBe(false)
    }
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
