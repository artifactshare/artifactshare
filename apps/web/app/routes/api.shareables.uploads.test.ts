import { beforeEach, describe, expect, test, vi } from 'vitest'
import { STATIC_SITE_UPLOAD_LIMITS } from '~/lib/product-contracts'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'

const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const isAgentPublishableDestinationMock = vi.hoisted(() => vi.fn())
const uploadShareableMock = vi.hoisted(() => vi.fn())
const createVersionMock = vi.hoisted(() => vi.fn())
const resolveArtifactKeyMock = vi.hoisted(() => vi.fn())
const beginStaticSiteBundleUploadSessionMock = vi.hoisted(() => vi.fn())
const beginStaticSiteBundleVersionUploadSessionMock = vi.hoisted(() => vi.fn())
const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => Symbol('ctxContext'))
const authSourceContextMock = vi.hoisted(() => Symbol('authSourceContext'))
const waitUntilMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const resolveUploadContainerMock = vi.hoisted(() => vi.fn())
const recordFirstArtifactPostMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  authSourceContext: authSourceContextMock,
  getCliAuthority: getCliAuthorityMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/agent-scope.server', () => ({
  isAgentPublishableDestination: isAgentPublishableDestinationMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleUploadSession: beginStaticSiteBundleUploadSessionMock,
  beginStaticSiteBundleVersionUploadSession:
    beginStaticSiteBundleVersionUploadSessionMock,
}))
const publishMock = vi.hoisted(() => vi.fn())
const publishPrincipalMock = vi.hoisted(() => vi.fn())
vi.mock('~/modules/publish', () => ({
  publish: publishMock,
  publishPrincipal: publishPrincipalMock,
}))
vi.mock('~/services/artifact-keys.server', async () => {
  const actual = await vi.importActual<
    typeof import('~/services/artifact-keys.server')
  >('~/services/artifact-keys.server')
  return {
    normalizeArtifactKey: actual.normalizeArtifactKey,
    resolveArtifactKey: resolveArtifactKeyMock,
  }
})
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))
vi.mock('~/services/projects.server', () => ({
  resolveUploadContainer: resolveUploadContainerMock,
}))
vi.mock('~/services/first-post-analytics.server', () => ({
  recordFirstArtifactPost: recordFirstArtifactPostMock,
}))
vi.mock('~/lib/upload-permission-response.server', () => ({
  uploadPermissionFailureResponse: () =>
    Response.json(
      {
        error: {
          code: 'self-upload-disabled',
          message: 'Sign in with Google or Microsoft to upload files.',
        },
      },
      { status: 403 },
    ),
}))

import {
  action,
  LEGACY_MULTIPART_UPLOAD_ENVELOPE,
  middleware,
} from './api.shareables.uploads'

function actionArgs(form: FormData) {
  return actionArgsFor(
    'https://artifactshare.test/api/shareables/uploads',
    form,
  )
}

function actionArgsFor(url: string, form: FormData) {
  return {
    request: new Request(url, {
      method: 'POST',
      body: form,
    }),
    context: new Map([[ctxContextMock, { waitUntil: waitUntilMock }]]),
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/uploads', () => {
  beforeEach(() => {
    getCliAuthorityMock.mockReset().mockReturnValue(null)
    isAgentPublishableDestinationMock.mockReset().mockResolvedValue(true)
    uploadShareableMock.mockReset()
    createVersionMock.mockReset()
    publishPrincipalMock.mockReset().mockImplementation((user) => ({
      kind: 'human',
      user: {
        ...user,
        kind: 'human',
        emailVerified: user.emailVerified ?? false,
        hd: user.hd ?? null,
        msTenantId: user.msTenantId ?? null,
      },
    }))
    publishMock.mockReset().mockImplementation(async (intent) => {
      const user = {
        id: intent.actor.user.id,
        email: intent.actor.user.email ?? null,
        emailVerified: intent.actor.user.emailVerified ?? false,
        workspaceId: intent.actor.user.workspaceId,
        hd: intent.actor.user.hd ?? null,
        msTenantId: intent.actor.user.msTenantId ?? null,
      }
      if (intent.content.kind === 'site') {
        return await intent.content.session.publish({
          db: intent.db,
          user,
          authority: intent.actor.authority ?? null,
          target: intent.target,
          containerId:
            intent.target.kind === 'create' &&
            intent.destination.kind === 'project'
              ? intent.destination.id
              : null,
          idempotencyKey:
            intent.target.kind === 'create'
              ? (intent.idempotencyKey ?? null)
              : null,
          touchArtifactKeyId: intent.touchArtifactKeyId ?? null,
          ...(intent.waitUntil ? { waitUntil: intent.waitUntil } : {}),
        })
      }
      if (intent.target.kind === 'create') {
        const destination =
          intent.destination.kind === 'project' ? intent.destination.id : null
        return await uploadShareableMock(
          intent.db ?? createDbMock(),
          user,
          intent.content.bytes,
          intent.visibility ?? 'private',
          intent.grantEmails ?? [],
          destination,
          intent.idempotencyKey ?? null,
          {
            ...(intent.notify.slack === false ? { slackNotify: false } : {}),
            ...(intent.linkExpiresAt !== undefined
              ? { linkExpiresAt: intent.linkExpiresAt }
              : {}),
          },
        )
      }
      return await createVersionMock({
        db: intent.db,
        user,
        shareableId: intent.target.artifactId,
        file: intent.content.bytes,
        ...(intent.touchArtifactKeyId
          ? { touchArtifactKeyId: intent.touchArtifactKeyId }
          : {}),
        ...(intent.waitUntil ? { waitUntil: intent.waitUntil } : {}),
        ...(intent.target.expectedVersionId
          ? { expectedCurrentVersionId: intent.target.expectedVersionId }
          : {}),
        ...(intent.actor.authority
          ? { authority: intent.actor.authority }
          : {}),
        ...(intent.actor.authority?.kind === 'agent'
          ? { agentProfileId: intent.actor.authority.agentProfileId }
          : {}),
      })
    })
    resolveArtifactKeyMock.mockReset()
    beginStaticSiteBundleUploadSessionMock.mockReset()
    beginStaticSiteBundleVersionUploadSessionMock.mockReset()
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset().mockReturnValue({ mocked: true })
    waitUntilMock.mockReset()
    checkUploadAccessMock.mockReset()
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    resolveUploadContainerMock.mockReset()
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'inbox-1',
      containerKind: 'inbox',
      workspaceId: 'ws1',
      isExternalPosting: false,
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('single-file upload uses the first file when a later file entry is text', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      linkExpiresAt: null,
    })
    const form = new FormData()
    form.append('file', new File(['first'], 'index.html'))
    form.append('file', 'ignored')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    const file = uploadShareableMock.mock.calls[0]?.[2] as File
    expect(file.name).toBe('index.html')
    expect(await file.text()).toBe('first')
  })

  test.each([
    ['single', 'link_expires_at', 403, 'forbidden'],
    ['single', 'container_id', 400, 'invalid-container'],
    ['static', 'link_expires_at', 403, 'forbidden'],
    ['static', 'container_id', 403, 'forbidden'],
  ])(
    '%s preserves agent error precedence with file-valued %s',
    async (mode, field, status, code) => {
      getCliAuthorityMock.mockReturnValue({
        kind: 'agent',
        agentProfileId: 'agent-1',
      })
      const abort = vi.fn()
      const commit = vi.fn()
      beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: {
          addFile: vi.fn().mockResolvedValue({ kind: 'ok' }),
          abort,
          commit,
          fileCount: 1,
        },
      })
      const form = new FormData()
      form.append('file', new File(['first'], 'index.html'))
      form.append('visibility', 'private')
      form.append(field, new File(['invalid'], 'metadata.txt'))

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads' +
            (mode === 'static' ? '?artifact_kind=static_site' : ''),
          form,
        ),
      )

      expect(response.status).toBe(status)
      await expect(json(response)).resolves.toMatchObject({ error: { code } })
      expect(uploadShareableMock).not.toHaveBeenCalled()
      expect(commit).not.toHaveBeenCalled()
      if (mode === 'static') expect(abort).toHaveBeenCalledTimes(1)
    },
  )

  test('static-site missing file takes precedence over file-valued grant email', async () => {
    const abort = vi.fn()
    const commit = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: { addFile: vi.fn(), abort, commit, fileCount: 0 },
    })
    const form = new FormData()
    form.append('grant_email', new File(['invalid'], 'grant.txt'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'missing-file' },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('keeps the legacy multipart envelope distinct from static-site limits', () => {
    expect(LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFileBytes).toBe(
      LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxTotalBytes,
    )
    expect(LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFileBytes).toBeGreaterThan(
      STATIC_SITE_UPLOAD_LIMITS.fileBytes,
    )
    expect(LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFiles).toBe(
      STATIC_SITE_UPLOAD_LIMITS.files,
    )
    expect(LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxParts).toBe(
      LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFiles + 3 + MAX_GRANT_EMAILS * 2,
    )
  })

  test('single-file upload path is unchanged when artifact_kind is absent', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      link_expires_at: null,
      linkExpiresAt: null,
    })
    const form = new FormData()
    const file = new File(['<p>hello</p>'], 'hello.html', {
      type: 'text/html',
    })
    form.append('file', file)
    form.append('visibility', 'private')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      link_expires_at: null,
      containerId: null,
      shareUrl: 'https://artifactshare.test/a/abc123def4',
    })
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    const uploadCall = uploadShareableMock.mock.calls[0]
    expect(uploadCall?.[0]).toEqual({ mocked: true })
    expect(uploadCall?.[1]).toEqual({
      id: 'u1',
      email: 'owner@example.com',
      emailVerified: false,
      workspaceId: 'ws1',
      hd: 'example.com',
      msTenantId: null,
    })
    expect(uploadCall?.[2]).toMatchObject({
      name: file.name,
      size: file.size,
      type: file.type,
    })
    expect(uploadCall?.[3]).toBe('private')
    expect(uploadCall?.[4]).toEqual([])
    expect(uploadCall?.[5]).toBeNull()
    expect(checkUploadAccessMock).toHaveBeenCalledWith(expect.anything())
  })

  test.each(['false', new File(['false'], 'notify.txt')])(
    'preserves single-file slack_notify semantics for %j',
    async (slackNotify) => {
      uploadShareableMock.mockResolvedValue({
        kind: 'ok',
        id: 'abc123def4',
        versionId: 'ver1',
        artifactKind: 'html_page',
        visibility: 'private',
        linkExpiresAt: null,
      })
      const form = new FormData()
      form.append('file', new File(['hi'], 'hi.html'))
      form.append('visibility', 'private')
      form.append('slack_notify', slackNotify)
      const response = await action(actionArgs(form))
      expect(response.status).toBe(200)
      expect(uploadShareableMock.mock.calls[0]?.[7]).toEqual(
        slackNotify === 'false' ? { slackNotify: false } : {},
      )
    },
  )

  test('rejects unavailable workspace visibility before a missing file', async () => {
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: null,
    })
    const form = new FormData()
    form.append('visibility', 'workspace')
    const response = await action(actionArgs(form))
    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-unavailable' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test.each(['false', new File(['false'], 'notify.txt')])(
    'preserves static-site slack_notify semantics for %j',
    async (slackNotify) => {
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const setSlackNotify = vi.fn()
      const commit = vi.fn().mockResolvedValue({
        kind: 'ok',
        id: 'abc123def4',
        versionId: 'ver1',
        linkExpiresAt: null,
      })
      beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: {
          addFile,
          setSlackNotify,
          commit,
          abort: vi.fn(),
          get fileCount() {
            return addFile.mock.calls.length
          },
        },
      })
      const form = new FormData()
      form.append('visibility', 'private')
      form.append('slack_notify', slackNotify)
      form.append(
        'file',
        new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
      )
      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
          form,
        ),
      )
      expect(response.status).toBe(200)
      expect(setSlackNotify).toHaveBeenCalledWith(slackNotify !== 'false')
      expect(commit).toHaveBeenCalledWith('private', [], undefined)
    },
  )

  test('returns a localized warning when Slack enqueue is suppressed', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'project',
      linkExpiresAt: null,
      slackNotificationSuppressed: true,
    })
    const form = new FormData()
    form.append('file', new File(['hi'], 'hi.html'))
    form.append('visibility', 'project')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))
    await expect(json(response)).resolves.toMatchObject({
      warnings: [
        {
          code: 'slack_reauthorization_required',
          message: expect.stringContaining('Slack notifications'),
        },
      ],
    })
  })

  test('single-file upload forwards finite and unlimited link expiry', async () => {
    const finite = '2026-08-01T00:00:00.000Z'
    uploadShareableMock
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'finite1234',
        versionId: 'finite-version',
        artifactKind: 'html_page',
        visibility: 'link',
        linkExpiresAt: finite,
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'unlimit123',
        versionId: 'unlimited-version',
        artifactKind: 'html_page',
        visibility: 'link',
        linkExpiresAt: null,
      })

    const finiteForm = new FormData()
    finiteForm.append('file', new File(['<p>finite</p>'], 'finite.html'))
    finiteForm.append('visibility', 'link')
    finiteForm.append('link_expires_at', finite)
    const finiteResponse = await action(actionArgs(finiteForm))
    await expect(json(finiteResponse)).resolves.toMatchObject({
      id: 'finite1234',
      link_expires_at: finite,
      shareUrl: 'https://finite1234.localhost:5173/',
    })
    expect(uploadShareableMock.mock.calls[0]?.[7]).toEqual({
      linkExpiresAt: finite,
    })

    const unlimitedForm = new FormData()
    unlimitedForm.append(
      'file',
      new File(['<p>unlimited</p>'], 'unlimited.html'),
    )
    unlimitedForm.append('visibility', 'link')
    unlimitedForm.append('link_expires_at', 'null')
    const unlimitedResponse = await action(actionArgs(unlimitedForm))
    await expect(json(unlimitedResponse)).resolves.toMatchObject({
      id: 'unlimit123',
      shareUrl: 'https://unlimit123.localhost:5173/',
    })
    expect(uploadShareableMock.mock.calls[1]?.[7]).toEqual({
      linkExpiresAt: null,
    })
  })

  test.each([
    'link-sharing-plan-required',
    'link-sharing-disabled',
    'link-expiry-invalid',
  ])(
    'single-file upload maps %s without changing the error code',
    async (kind) => {
      uploadShareableMock.mockResolvedValue({ kind })
      const form = new FormData()
      form.append('file', new File(['<p>link</p>'], 'link.html'))
      form.append('visibility', 'link')

      const response = await action(actionArgs(form))

      expect(response.status).toBe(
        kind === 'link-sharing-plan-required'
          ? 402
          : kind === 'link-sharing-disabled'
            ? 403
            : 400,
      )
      await expect(json(response)).resolves.toMatchObject({
        error: { code: kind },
      })
    },
  )

  test('single-file upload passes a project container id to the create call', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[5]).toBe('project-a')
  })

  test('single-file upload passes initial grant emails to the create call', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'A@example.com')
    form.append('grant_email', 'b@example.com')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[4]).toEqual([
      'A@example.com',
      'b@example.com',
    ])
  })

  test('single-file upload lets the service normalize duplicate grant emails', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    for (let i = 0; i < 51; i += 1) {
      form.append('grant_email', 'viewer@example.com')
    }

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[4]).toHaveLength(51)
  })

  test('single-file upload maps grant limit errors to invalid-grants', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'too-many-grants',
      limit: 50,
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'viewer@example.com')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
  })

  test('single-file upload maps invalid container errors to invalid-container', async () => {
    uploadShareableMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
  })

  test('rejects any artifact_kind on the single-file endpoint', async () => {
    const form = new FormData()
    form.append('artifact_kind', 'static_site')
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'unknown-artifact-kind' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('single-file upload maps the contributor guardrail to forbidden', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'contributor-limit-exceeded',
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'contributor-limit-exceeded' },
    })
  })

  test('single-file upload maps revoked workspace access to forbidden response', async () => {
    uploadShareableMock.mockResolvedValue({ kind: 'workspace-access-revoked' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
  })

  test('single-file upload rejects users without self-upload enabled after resolving the destination', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'self-upload-disabled' })
    const form = new FormData()
    const file = new File(['x'], 'a.html', { type: 'text/html' })
    form.append('file', file)

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'self-upload-disabled' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('cross-workspace upload remains subject to self-upload access', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    checkUploadAccessMock.mockResolvedValue({ kind: 'self-upload-disabled' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'self-upload-disabled' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('single-file upload maps an unresolved destination to invalid-container', async () => {
    resolveUploadContainerMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
    expect(checkUploadAccessMock).not.toHaveBeenCalled()
  })

  test('single-file upload rejects publish_key for a cross-workspace destination', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=foo',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('static_site upload rejects publish_key for a cross-workspace destination', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=foo',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(resolveArtifactKeyMock).not.toHaveBeenCalled()
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
    expect(beginStaticSiteBundleVersionUploadSessionMock).not.toHaveBeenCalled()
  })

  test('static_site upload forwards a cross-workspace destination to the upload session', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      linkExpiresAt: null,
    })
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-b',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledTimes(1)
    expect(beginStaticSiteBundleUploadSessionMock.mock.calls[0]?.[2]).toBe(
      'project-b',
    )
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
  })

  function staticSiteSessionWithCommit(commitResult: unknown) {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue(commitResult)
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )
    return action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-b',
        form,
      ),
    )
  }

  test('static_site upload records a first post only when the commit succeeds', async () => {
    recordFirstArtifactPostMock.mockClear()
    await staticSiteSessionWithCommit({ kind: 'missing-entrypoint' })
    // A failed commit posts nothing, so it must not claim the one-time row.
    expect(recordFirstArtifactPostMock).not.toHaveBeenCalled()

    recordFirstArtifactPostMock.mockClear()
    await staticSiteSessionWithCommit({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      linkExpiresAt: null,
    })
    expect(recordFirstArtifactPostMock).toHaveBeenCalledTimes(1)
  })

  test('static_site upload maps an unresolved destination to invalid-container', async () => {
    resolveUploadContainerMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(checkUploadAccessMock).not.toHaveBeenCalled()
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
  })

  test('static_site upload rejects users without self-upload enabled after resolving the destination', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'self-upload-disabled' })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'self-upload-disabled' },
    })
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
  })

  test('rejects File-typed artifact_kind with 400', async () => {
    const form = new FormData()
    form.append(
      'artifact_kind',
      new File(['unused'], 'oops', { type: 'application/octet-stream' }),
    )
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-artifact-kind' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test.each(['public'])(
    'single-file upload rejects %s visibility as a new setting',
    async (visibility) => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
      form.append('visibility', visibility)

      const response = await action(actionArgs(form))

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(uploadShareableMock).not.toHaveBeenCalled()
    },
  )

  test('rejects non-string form metadata through the shared upload contract', async () => {
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
    form.append(
      'visibility',
      new File(['private'], 'visibility.txt', { type: 'text/plain' }),
    )

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-visibility' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test.each(['public'])(
    'static_site upload rejects %s visibility as a new setting',
    async (visibility) => {
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const commit = vi.fn()
      const abort = vi.fn()
      beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: {
          addFile,
          commit,
          abort,
          get fileCount() {
            return addFile.mock.calls.length
          },
        },
      })
      const form = new FormData()
      form.append('file', new File(['<p>hi</p>'], 'index.html'))
      form.append('visibility', visibility)

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
          form,
        ),
      )

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(commit).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledTimes(1)
    },
  )

  test('static_site hint streams files through an upload session instead of keeping a File array', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    const index = new File(['<p>hi</p>'], 'index.html', {
      type: 'text/html',
    })
    const css = new File(['body{}'], 'style.css', { type: 'text/css' })
    form.append('visibility', 'private')
    form.append('file', index)
    form.append('file', css, 'assets/site.css')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'static_site',
      shareUrl: 'https://artifactshare.test/a/abc123def4',
    })
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledWith(
      { mocked: true },
      {
        id: 'u1',
        email: 'owner@example.com',
        emailVerified: false,
        workspaceId: 'ws1',
        hd: 'example.com',
        msTenantId: null,
      },
      null,
      null,
    )
    expect(addFile).toHaveBeenCalledTimes(2)
    expect(addFile.mock.calls[0]?.[0]).toMatchObject({ name: index.name })
    expect(addFile.mock.calls[1]?.[0]).toMatchObject({
      name: 'assets/site.css',
    })
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload forwards finite and unlimited link expiry', async () => {
    const finite = '2026-08-01T00:00:00.000Z'
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'finite1234',
        versionId: 'finite-version',
        visibility: 'link',
        linkExpiresAt: finite,
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'unlimit123',
        versionId: 'unlimited-version',
        visibility: 'link',
        linkExpiresAt: null,
      })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })

    const finiteForm = new FormData()
    finiteForm.append('visibility', 'link')
    finiteForm.append('link_expires_at', finite)
    finiteForm.append('file', new File(['<p>hi</p>'], 'index.html'))
    const finiteResponse = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        finiteForm,
      ),
    )
    await expect(json(finiteResponse)).resolves.toMatchObject({
      id: 'finite1234',
      link_expires_at: finite,
      shareUrl: 'https://finite1234.localhost:5173/',
    })
    expect(commit.mock.calls[0]).toEqual(['link', [], finite])

    const unlimitedForm = new FormData()
    unlimitedForm.append('visibility', 'link')
    unlimitedForm.append('link_expires_at', 'null')
    unlimitedForm.append('file', new File(['<p>hi</p>'], 'index.html'))
    const unlimitedResponse = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        unlimitedForm,
      ),
    )
    await expect(json(unlimitedResponse)).resolves.toMatchObject({
      id: 'unlimit123',
      link_expires_at: null,
      shareUrl: 'https://unlimit123.localhost:5173/',
    })
    expect(commit.mock.calls[1]).toEqual(['link', [], null])
  })

  test.each(['empty', 'file'] as const)(
    'static-site create preserves the form error for %s link expiry',
    async (value) => {
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const commit = vi.fn()
      const abort = vi.fn()
      beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: { addFile, commit, abort, fileCount: 1 },
      })
      const form = new FormData()
      form.append('file', new File(['<p>hi</p>'], 'index.html'))
      form.append('visibility', 'link')
      form.append(
        'link_expires_at',
        value === 'empty' ? '' : new File(['invalid'], 'expiry.txt'),
      )

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
          form,
        ),
      )

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toEqual({
        error: {
          code: 'link-expiry-invalid',
          message:
            'link_expires_at must be a future RFC3339 UTC timestamp or null.',
        },
      })
      expect(addFile).toHaveBeenCalledTimes(1)
      expect(commit).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledTimes(1)
    },
  )

  test.each(['create', 'publish_key update'] as const)(
    'static-site %s preserves the commit link expiry policy error',
    async (target) => {
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const commit = vi.fn().mockResolvedValue({ kind: 'link-expiry-invalid' })
      const commitVersion = vi
        .fn()
        .mockResolvedValue({ kind: 'link-expiry-invalid' })
      const abort = vi.fn()
      const beginSession =
        target === 'create'
          ? beginStaticSiteBundleUploadSessionMock
          : beginStaticSiteBundleVersionUploadSessionMock
      beginSession.mockResolvedValue({
        kind: 'ok',
        session: { addFile, commit, commitVersion, abort, fileCount: 1 },
      })
      if (target === 'publish_key update') {
        resolveArtifactKeyMock.mockResolvedValue({
          kind: 'update',
          keyId: 'key-1',
          shareableId: 'abc123def4',
          artifactKind: 'static_site',
          visibility: 'link',
        })
      }
      const form = new FormData()
      form.append('file', new File(['<p>hi</p>'], 'index.html'))
      form.append('visibility', 'link')
      form.append('link_expires_at', 'null')

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site' +
            (target === 'publish_key update' ? '&publish_key=site-key' : ''),
          form,
        ),
      )

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toEqual({
        error: {
          code: 'link-expiry-invalid',
          message: 'The link expiry is invalid for this workspace policy.',
        },
      })
      expect(addFile).toHaveBeenCalledTimes(1)
      if (target === 'create') {
        expect(commit).toHaveBeenCalledWith('link', [], null)
        expect(commitVersion).not.toHaveBeenCalled()
      } else {
        expect(commitVersion).toHaveBeenCalledTimes(1)
        expect(commit).not.toHaveBeenCalled()
      }
      expect(abort).not.toHaveBeenCalled()
    },
  )

  test('static_site upload passes a project container id to the upload session', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-a',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(beginStaticSiteBundleUploadSessionMock.mock.calls[0]?.[2]).toBe(
      'project-a',
    )
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
  })

  test('static_site upload rejects mismatched query and form container ids', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-a',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site upload passes initial grant emails to commit', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'team@example.com')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(commit).toHaveBeenCalledWith(
      'private',
      ['team@example.com'],
      undefined,
    )
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload maps grant limit errors to invalid-grants', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'too-many-grants', limit: 50 })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'team@example.com')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload rejects file-valued grant emails and aborts uploaded files', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('grant_email', new File(['x'], 'grant.txt'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site upload maps the contributor guardrail to forbidden', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'contributor-limit-exceeded' })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'contributor-limit-exceeded' },
    })
  })

  test('static_site upload rejects revoked workspace access before parsing files', async () => {
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'workspace-access-revoked',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
  })

  describe.each(['create', 'publish_key update'] as const)(
    'static-site %s size errors',
    (target) => {
      test.each(['parser file', 'parser total', 'service'] as const)(
        'preserves the %s error response',
        async (source) => {
          const addFile = vi.fn().mockResolvedValue(
            source === 'service'
              ? {
                  kind: 'too-large',
                  limitBytes: STATIC_SITE_UPLOAD_LIMITS.totalBytes,
                }
              : { kind: 'ok' },
          )
          const commit = vi.fn()
          const commitVersion = vi.fn()
          const abort = vi.fn()
          const beginSession =
            target === 'create'
              ? beginStaticSiteBundleUploadSessionMock
              : beginStaticSiteBundleVersionUploadSessionMock
          beginSession.mockResolvedValue({
            kind: 'ok',
            session: { addFile, commit, commitVersion, abort, fileCount: 1 },
          })
          if (target === 'publish_key update') {
            resolveArtifactKeyMock.mockResolvedValue({
              kind: 'update',
              keyId: 'key-1',
              shareableId: 'abc123def4',
              artifactKind: 'static_site',
              visibility: 'project',
            })
          }
          const form = new FormData()
          if (source === 'parser total') {
            form.append(
              'padding',
              'x'.repeat(STATIC_SITE_UPLOAD_LIMITS.totalBytes + 1),
            )
          } else {
            form.append(
              'file',
              new File(
                [
                  source === 'parser file'
                    ? new Uint8Array(STATIC_SITE_UPLOAD_LIMITS.fileBytes + 1)
                    : '<p>hi</p>',
                ],
                'index.html',
              ),
            )
          }

          const response = await action(
            actionArgsFor(
              'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site' +
                (target === 'publish_key update'
                  ? '&publish_key=site-key'
                  : ''),
              form,
            ),
          )

          expect(response.status).toBe(413)
          await expect(json(response)).resolves.toEqual({
            error: {
              code: 'too-large',
              message:
                source === 'service'
                  ? 'Static site bundle is larger than 25 MB.'
                  : 'Upload is larger than 25 MB.',
            },
          })
          expect(commit).not.toHaveBeenCalled()
          expect(commitVersion).not.toHaveBeenCalled()
          expect(abort).toHaveBeenCalledTimes(1)
        },
      )
    },
  )

  test('static_site hint maps session validation errors and aborts uploaded files', async () => {
    const addFile = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok' })
      .mockResolvedValueOnce({
        kind: 'invalid-path',
        path: '../secret.txt',
        reason: 'Blocked path traversal: ../secret.txt',
      })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('file', new File(['secret'], '../secret.txt'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: {
        code: 'invalid-path',
        message: expect.stringContaining('../secret.txt'),
      },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site hint maps duplicate paths to 400 and aborts uploaded files', async () => {
    const addFile = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok' })
      .mockResolvedValueOnce({
        kind: 'duplicate-path',
        path: '/assets/café.html',
      })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'assets/cafe\u0301.html'))
    form.append('file', new File(['<p>bye</p>'], 'assets/café.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: {
        code: 'duplicate-path',
        message: expect.stringContaining('/assets/café.html'),
      },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('publish_key that is blank after trimming fails with invalid-key', async () => {
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=%20%20',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(resolveArtifactKeyMock).not.toHaveBeenCalled()
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key create path passes the key to uploadShareable and reports created', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'create',
      containerId: 'inbox-1',
    })
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toMatchObject({
      id: 'abc123def4',
      created: true,
    })
    expect(resolveArtifactKeyMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      null,
      'pr-482',
      'single_file',
    )
    expect(uploadShareableMock.mock.calls[0]?.[6]).toBe('pr-482')
  })

  test('publish_key update path adds a version and reports created: false', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'update',
      keyId: 'key-1',
      shareableId: 'abc123def4',
      artifactKind: 'html_page',
      visibility: 'project',
    })
    createVersionMock.mockResolvedValue({
      kind: 'ok',
      versionId: 'ver2',
      artifactKind: 'html_page',
    })
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver2',
      artifactKind: 'html_page',
      visibility: 'project',
      containerId: null,
      shareUrl: 'https://artifactshare.test/a/abc123def4',
      created: false,
    })
    expect(createVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shareableId: 'abc123def4',
        touchArtifactKeyId: 'key-1',
        waitUntil: expect.any(Function),
      }),
    )
    const waitUntil = createVersionMock.mock.calls[0]?.[0].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key resolution failures map to key error responses', async () => {
    for (const [kind, code, status] of [
      ['key-target-moved', 'key-target-moved', 409],
      ['key-kind-mismatch', 'key-kind-mismatch', 409],
      ['invalid-container', 'invalid-container', 400],
    ] as const) {
      resolveArtifactKeyMock.mockResolvedValue({ kind })
      const form = new FormData()
      form.append(
        'file',
        new File(['<p>x</p>'], 'x.html', { type: 'text/html' }),
      )
      form.append('visibility', 'private')

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
          form,
        ),
      )

      expect(response.status).toBe(status)
      await expect(json(response)).resolves.toMatchObject({
        error: { code },
      })
    }
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key static-site update path delegates to the version upload flow', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'update',
      keyId: 'key-1',
      shareableId: 'abc123def4',
      artifactKind: 'static_site',
      visibility: 'project',
    })
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commitVersion = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver2',
    })
    const abort = vi.fn()
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion,
        abort,
        fileCount: 1,
      },
    })
    const executeTakeFirstOrThrow = vi
      .fn()
      .mockResolvedValue({ visibility: 'project' })
    const db = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ executeTakeFirstOrThrow }),
        }),
      }),
    }
    createDbMock.mockReturnValueOnce(db)
    const form = new FormData()
    form.append('visibility', 'project')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=site-key',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(resolveArtifactKeyMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'u1' }),
      null,
      'site-key',
      'static_site',
    )
    expect(beginStaticSiteBundleVersionUploadSessionMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'u1' }),
      'abc123def4',
      'key-1',
      {
        waitUntil: expect.any(Function),
      },
    )
    const waitUntil =
      beginStaticSiteBundleVersionUploadSessionMock.mock.calls[0]?.[4].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
    expect(commitVersion).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
  })

  test('publish_key static-site create path passes the key to the create session', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'create',
      containerId: 'inbox-1',
    })
    const addFile = vi.fn(async () => ({ kind: 'ok' }))
    const commit = vi.fn(async () => ({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      visibility: 'private',
    }))
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=site-key',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toMatchObject({
      id: 'abc123def4',
      created: true,
    })
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      null,
      'site-key',
    )
  })
})
