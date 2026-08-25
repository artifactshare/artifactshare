import { describe, expect, it, vi } from 'vitest'
import {
  createBridgePolicy,
  publishTrusted,
  validateBridgeConfig,
} from './index.js'
import { ArtifactShareBridgeClient } from './client.js'
import { createFakeBridgeClient } from './testing.js'
import type { BridgeSuccess, ShareIntent, TrustedHostContext } from './types.js'

const now = '2026-08-25T05:00:00.000Z'

function config() {
  return validateBridgeConfig({
    base_url: 'https://artifactshare.com',
    source: {
      kind: 'qm',
      installation_id: 'install-1',
      external_workspace_id: 'workspace-1',
    },
    allowed_conversations: [
      { kind: 'public_channel', current_id: 'channel-1' },
    ],
  })
}

function context(): TrustedHostContext {
  return {
    source: {
      kind: 'qm',
      installation_id: 'install-1',
      external_workspace_id: 'workspace-1',
    },
    conversation: {
      current_id: 'channel-1',
      ids: ['channel-1'],
      kind: 'public_channel',
      privacy_checked_at: now,
    },
    requester: {
      stable_id: 'person-1',
      verified_email: 'person@example.com',
    },
    request_id: 'request-1',
  }
}

function intent(bytes = new Uint8Array([1, 2, 3])): ShareIntent {
  return {
    operation: 'publish',
    requested_audience: 'workspace',
    content: {
      kind: 'file',
      file: { path: 'report.md', media_type: 'text/markdown', bytes },
    },
  }
}

function success(
  visibility: 'private' | 'workspace' = 'workspace',
): BridgeSuccess {
  return {
    ok: true,
    artifact: {
      id: 'artifact-1',
      url: 'https://artifactshare.com/artifacts/artifact-1',
      title: 'Report',
    },
    project: { id: 'project-1', name: 'Project' },
    visibility,
    version_id: 'version-1',
    replayed: false,
    mapping_created: true,
    project_created: true,
  }
}

describe('bridge orchestration', () => {
  it('allows stale public context to reach authoritative server narrowing', async () => {
    const value = context()
    value.conversation.privacy_checked_at = '2026-08-25T04:00:00.000Z'
    const client = createFakeBridgeClient(success('private'))
    const result = await publishTrusted({
      intent: intent(),
      context: value,
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: true, visibility: 'private' })
    expect(client.calls).toHaveLength(1)
  })

  it('rejects a future public privacy check before credential access', async () => {
    const value = context()
    value.conversation.privacy_checked_at = '2026-08-25T05:00:06.000Z'
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: intent(),
      context: value,
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_context' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('accepts a product-valid multibyte title across both result boundaries', async () => {
    const title = 'あ'.repeat(200)
    const value = intent()
    value.title = title
    const response = success()
    response.artifact.title = title
    const result = await publishTrusted({
      intent: value,
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(response),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: true, artifact: { title } })
  })

  it('rejects a malformed credential before calling the client', async () => {
    const client = createFakeBridgeClient(success())
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret\n' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'credential_unavailable',
      retryable: false,
    })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects a client bound to another origin before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const fetchMock = vi.fn()
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: new ArtifactShareBridgeClient({
        baseUrl: 'https://example.com',
        fetch: fetchMock as typeof fetch,
      }),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_context' })
    expect(credentialProvider).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('owns bytes synchronously and calls the credential and client once', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const client = createFakeBridgeClient(success())
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const pending = publishTrusted({
      intent: intent(bytes),
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider,
      clock: () => new Date(now),
    })
    bytes.fill(9)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(credentialProvider).toHaveBeenCalledOnce()
    expect(client.calls).toHaveLength(1)
    expect([...client.calls[0]!.request.files[0]!.bytes]).toEqual([1, 2, 3])
  })

  it('accepts a Node Buffer through the Uint8Array public type', async () => {
    const client = createFakeBridgeClient(success())
    const result = await publishTrusted({
      intent: intent(Buffer.from([1, 2, 3])),
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result.ok).toBe(true)
    expect([...client.calls[0]!.request.files[0]!.bytes]).toEqual([1, 2, 3])
  })

  it('rejects invalid intent before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const client = createFakeBridgeClient(success())
    const result = await publishTrusted({
      intent: { ...intent(), requested_audience: 'public' },
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
    expect(client.calls).toHaveLength(0)
  })

  it.each(['*/*', 'text/*'])(
    'rejects wildcard media type %s before credential access',
    async (media_type) => {
      const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
      const value = intent()
      if (value.content?.kind === 'file')
        value.content.file.media_type = media_type
      const result = await publishTrusted({
        intent: value,
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success()),
        credentialProvider,
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
      expect(credentialProvider).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['publish', undefined],
    ['update', 'artifact-1'],
  ] as const)(
    'rejects an unsupported standalone file for %s before credential access',
    async (operation, target_artifact_id) => {
      const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
      const result = await publishTrusted({
        intent: {
          operation,
          requested_audience: 'private',
          ...(target_artifact_id === undefined ? {} : { target_artifact_id }),
          content: {
            kind: 'file',
            file: {
              path: 'image.png',
              media_type: 'image/png',
              bytes: new Uint8Array([1]),
            },
          },
        },
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success('private')),
        credentialProvider,
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
      expect(credentialProvider).not.toHaveBeenCalled()
    },
  )

  it('rejects an empty append before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: {
        operation: 'append',
        requested_audience: 'private',
        target_artifact_id: 'artifact-1',
        content: {
          kind: 'file',
          file: {
            path: 'append.md',
            media_type: 'text/markdown',
            bytes: new Uint8Array(),
          },
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('rejects a non-UTF-8 append before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: {
        operation: 'append',
        requested_audience: 'private',
        target_artifact_id: 'artifact-1',
        content: {
          kind: 'file',
          file: {
            path: 'append.md',
            media_type: 'text/markdown',
            bytes: new Uint8Array([0xff]),
          },
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('rejects an invalid clock before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(Number.NaN),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_context' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('normalizes a verified email before sending the snapshot', async () => {
    const value = context()
    value.requester.verified_email = 'Jane.Doe@Example.org'
    const client = createFakeBridgeClient(success())
    const result = await publishTrusted({
      intent: intent(),
      context: value,
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result.ok).toBe(true)
    expect(client.calls[0]?.request.context.requester.verified_email).toBe(
      'jane.doe@example.org',
    )
  })

  it('rechecks the email byte bound after normalization', async () => {
    const value = context()
    value.requester.verified_email = `${'İ'.repeat(157)}@a.co`
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: intent(),
      context: value,
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_context' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('contains hostile exceptions thrown while reflecting untrusted input', async () => {
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('must not escape')
        },
      },
    )
    const hostileIntent = new Proxy(intent(), {
      ownKeys: () => {
        throw hostileError
      },
    })
    await expect(
      publishTrusted({
        intent: hostileIntent,
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success()),
        credentialProvider: async () => ({ bearer_token: 'secret' }),
        clock: () => new Date(now),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'internal_error' })
  })

  it('does not authorize with a former conversation id', async () => {
    const value = context()
    value.conversation.current_id = 'renamed-channel'
    value.conversation.ids = ['renamed-channel', 'channel-1']
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: intent(),
      context: value,
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'policy_denied' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('does not expose a mutable conversation allowlist', () => {
    const policy = createBridgePolicy(config())
    expect(Object.isFrozen(policy.allowed_conversations)).toBe(true)
    expect(() =>
      (policy.allowed_conversations as string[]).push(
        'private_channel:unauthorized',
      ),
    ).toThrow()
  })

  it('rejects shared and resizable byte sources before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const shared = new Uint8Array(new SharedArrayBuffer(3))
    Object.defineProperties(shared, {
      buffer: { value: new ArrayBuffer(0) },
      byteLength: { value: 0 },
    })
    const result = await publishTrusted({
      intent: intent(shared as unknown as Uint8Array<ArrayBuffer>),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('uses intrinsic byte length before copying untrusted input', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const bytes = new Uint8Array([1, 2])
    Object.defineProperty(bytes, 'byteLength', { value: 0 })
    const result = await publishTrusted({
      intent: intent(bytes),
      context: context(),
      policy: createBridgePolicy(
        validateBridgeConfig({ ...config(), max_payload_bytes: 1 }),
      ),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('rejects detached byte storage before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const buffer = new ArrayBuffer(3)
    const bytes = new Uint8Array(buffer)
    structuredClone(buffer, { transfer: [buffer] })
    const result = await publishTrusted({
      intent: intent(bytes),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success()),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('rejects an empty static site before credential access', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: { kind: 'static_site', files: [] },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing root entrypoint',
      [
        {
          path: 'about.html',
          media_type: 'text/html',
          bytes: new Uint8Array(),
        },
      ],
    ],
    [
      'unsupported member type',
      [
        {
          path: 'index.html',
          media_type: 'text/html',
          bytes: new Uint8Array(),
        },
        {
          path: 'archive.zip',
          media_type: 'application/zip',
          bytes: new Uint8Array(),
        },
      ],
    ],
  ])(
    'rejects a static site with %s before credential access',
    async (_name, files) => {
      const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
      const result = await publishTrusted({
        intent: {
          operation: 'publish',
          requested_audience: 'private',
          content: { kind: 'static_site', files },
        },
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success('private')),
        credentialProvider,
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
      expect(credentialProvider).not.toHaveBeenCalled()
    },
  )

  it('rejects an oversized static-site array before reading its elements', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const files = Array.from({ length: 51 }, (_, index) => ({
      path: `${index}.txt`,
      media_type: 'text/plain',
      bytes: new Uint8Array(),
    }))
    Object.defineProperty(files, '0', {
      get: () => {
        throw new Error('element must not be read')
      },
    })
    const result = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: { kind: 'static_site', files },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('allows a workspace request to return current private visibility', async () => {
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: true, visibility: 'private' })
  })

  it('accepts ten folder levels and rejects nonadjacent prefix collisions', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const deepResult = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            {
              path: 'index.html',
              media_type: 'text/html',
              bytes: new Uint8Array(),
            },
            {
              path: 'a/b/c/d/e/f/g/h/i/j/index.html',
              media_type: 'text/html',
              bytes: new Uint8Array(),
            },
          ],
        },
      },
      context: {
        ...context(),
        conversation: { ...context().conversation, kind: 'private_channel' },
      },
      policy: createBridgePolicy(
        validateBridgeConfig({
          ...config(),
          allowed_conversations: [
            { kind: 'private_channel', current_id: 'channel-1' },
          ],
        }),
      ),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
    })
    expect(deepResult.ok).toBe(true)

    const collisionResult = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            { path: 'docs', media_type: 'text/plain', bytes: new Uint8Array() },
            {
              path: 'docs ',
              media_type: 'text/plain',
              bytes: new Uint8Array(),
            },
            {
              path: 'docs/readme.md',
              media_type: 'text/markdown',
              bytes: new Uint8Array(),
            },
          ],
        },
      },
      context: {
        ...context(),
        conversation: { ...context().conversation, kind: 'private_channel' },
      },
      policy: createBridgePolicy(
        validateBridgeConfig({
          ...config(),
          allowed_conversations: [
            { kind: 'private_channel', current_id: 'channel-1' },
          ],
        }),
      ),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
    })
    expect(collisionResult).toMatchObject({ ok: false, code: 'invalid_intent' })
  })

  it('allows byte input reuse while owning each file snapshot', async () => {
    const shared = new Uint8Array([1, 2, 3])
    const client = createFakeBridgeClient(success('private'))
    const pending = publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            {
              path: 'index.html',
              media_type: 'text/html',
              bytes: new Uint8Array(),
            },
            { path: 'a.txt', media_type: 'text/plain', bytes: shared },
            { path: 'b.txt', media_type: 'text/plain', bytes: shared },
          ],
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    shared.fill(9)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(
      client.calls[0]?.request.files.map((file) => [...file.bytes]),
    ).toEqual([[1, 2, 3], [1, 2, 3], []])
  })

  it('rejects path segments that normalize to dot traversal', async () => {
    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            {
              path: 'a/ .. /secret.txt',
              media_type: 'text/plain',
              bytes: new Uint8Array(),
            },
          ],
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it.each([
    'report#draft.md',
    'search?query.html',
    'C:/index.html',
    'assets/ /index.html',
    'bin/run.sh',
  ])(
    'rejects a product-blocked path before credential access',
    async (path) => {
      const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
      const result = await publishTrusted({
        intent: {
          operation: 'publish',
          requested_audience: 'private',
          content: {
            kind: 'static_site',
            files: [
              {
                path,
                media_type: 'text/html',
                bytes: new Uint8Array([1]),
              },
            ],
          },
        },
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success('private')),
        credentialProvider,
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
      expect(credentialProvider).not.toHaveBeenCalled()
    },
  )

  it('accepts a multilingual static-site path within the character limit', async () => {
    const client = createFakeBridgeClient(success('private'))
    const path = `${'あ'.repeat(100)}.html`
    const result = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            {
              path: 'index.html',
              media_type: 'text/html',
              bytes: new Uint8Array(),
            },
            { path, media_type: 'text/html', bytes: new Uint8Array([1]) },
          ],
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client,
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result.ok).toBe(true)
    expect(client.calls[0]?.request.files[1]?.path).toBe(path)
  })

  it.each([
    ['case-folded', 'Index.html', 'index.html'],
    ['NFC-equivalent', 'café.html', 'cafe\u0301.html'],
  ])(
    'rejects %s static-site path collisions before credential access',
    async (_name, firstPath, secondPath) => {
      const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
      const result = await publishTrusted({
        intent: {
          operation: 'publish',
          requested_audience: 'private',
          content: {
            kind: 'static_site',
            files: [
              {
                path: firstPath,
                media_type: 'text/html',
                bytes: new Uint8Array([1]),
              },
              {
                path: secondPath,
                media_type: 'text/html',
                bytes: new Uint8Array([2]),
              },
            ],
          },
        },
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(success('private')),
        credentialProvider,
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
      expect(credentialProvider).not.toHaveBeenCalled()
    },
  )

  it('accounts for the stored leading slash in the static-site path limit', async () => {
    const acceptedPath = `${'a'.repeat(250)}.html`
    const acceptedClient = createFakeBridgeClient(success('private'))
    await expect(
      publishTrusted({
        intent: {
          operation: 'publish',
          requested_audience: 'private',
          content: {
            kind: 'static_site',
            files: [
              {
                path: 'index.html',
                media_type: 'text/html',
                bytes: new Uint8Array(),
              },
              {
                path: acceptedPath,
                media_type: 'text/html',
                bytes: new Uint8Array([1]),
              },
            ],
          },
        },
        context: context(),
        policy: createBridgePolicy(config()),
        client: acceptedClient,
        credentialProvider: async () => ({ bearer_token: 'secret' }),
        clock: () => new Date(now),
      }),
    ).resolves.toMatchObject({ ok: true })

    const credentialProvider = vi.fn(async () => ({ bearer_token: 'secret' }))
    const result = await publishTrusted({
      intent: {
        operation: 'publish',
        requested_audience: 'private',
        content: {
          kind: 'static_site',
          files: [
            {
              path: `${'a'.repeat(251)}.html`,
              media_type: 'text/html',
              bytes: new Uint8Array([1]),
            },
          ],
        },
      },
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(success('private')),
      credentialProvider,
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_intent' })
    expect(credentialProvider).not.toHaveBeenCalled()
  })

  it('rejects contradictory retry metadata from an injected client', async () => {
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: {
        credentialOrigin: 'https://artifactshare.com',
        request: async () =>
          ({
            ok: false,
            code: 'bridge_rejected',
            message: 'ignored',
            retryable: false,
            retry_after_ms: 500,
          }) as const,
      },
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })

  it('rejects an off-origin URL from an injected client', async () => {
    const value = success()
    value.artifact.url = 'https://example.com/artifacts/artifact-1'
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(value),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })

  it('rejects control characters in labels from an injected client', async () => {
    const value = success()
    value.project.name = 'Project\rforged'
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(value),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })

  it('rejects ill-formed Unicode in labels from an injected client', async () => {
    const value = success()
    value.project.name = '\ud800'
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(value),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })

  it('accepts a product-valid multibyte project name from an injected client', async () => {
    const value = success()
    value.project.name = '日'.repeat(120)
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(value),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({
      ok: true,
      project: { name: value.project.name },
    })
  })

  it.each([
    'https://artifactshare.com/\nforged',
    'https://user:pass@artifactshare.com/artifacts/artifact-1',
  ])(
    'rejects a malformed same-origin URL from an injected client',
    async (url) => {
      const value = success()
      value.artifact.url = url
      const result = await publishTrusted({
        intent: intent(),
        context: context(),
        policy: createBridgePolicy(config()),
        client: createFakeBridgeClient(value),
        credentialProvider: async () => ({ bearer_token: 'secret' }),
        clock: () => new Date(now),
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'invalid_server_response',
      })
    },
  )

  it('rejects an unbounded server code from an injected client', async () => {
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: {
        credentialOrigin: 'https://artifactshare.com',
        request: async () => ({
          ok: false,
          code: 'bridge_rejected',
          message: 'ignored',
          retryable: false,
          server_code: 'x'.repeat(201),
        }),
      },
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })

  it('enforces result field limits for an injected client', async () => {
    const value = success()
    value.project.name = 'p'.repeat(121)
    const result = await publishTrusted({
      intent: intent(),
      context: context(),
      policy: createBridgePolicy(config()),
      client: createFakeBridgeClient(value),
      credentialProvider: async () => ({ bearer_token: 'secret' }),
      clock: () => new Date(now),
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_server_response' })
  })
})

describe('configuration', () => {
  it('rejects unknown keys and non-loopback plain HTTP', () => {
    expect(() =>
      validateBridgeConfig({
        ...config(),
        base_url: 'http://example.com',
        extra: true,
      }),
    ).toThrow()
  })

  it('rejects IDs that runtime context cannot represent', () => {
    for (const current_id of ['chan\nnel', '\ud800', '\u0085channel']) {
      expect(() =>
        validateBridgeConfig({
          ...config(),
          allowed_conversations: [{ kind: 'public_channel', current_id }],
        }),
      ).toThrow()
    }
  })

  it('snapshots the conversation array without invoking getters', () => {
    const value: Record<string, unknown> = { ...config() }
    const get = vi.fn(() => [
      { kind: 'public_channel', current_id: 'channel-1' },
    ])
    Object.defineProperty(value, 'allowed_conversations', {
      enumerable: true,
      get,
    })
    expect(() => validateBridgeConfig(value)).toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  it('snapshots conversation fields without invoking getters', () => {
    const entry = { current_id: 'channel-1' } as Record<string, unknown>
    const get = vi.fn(() => 'public_channel')
    Object.defineProperty(entry, 'kind', {
      enumerable: true,
      get,
    })
    expect(() =>
      validateBridgeConfig({
        ...config(),
        allowed_conversations: [entry],
      }),
    ).toThrow()
    expect(get).not.toHaveBeenCalled()
  })
})
