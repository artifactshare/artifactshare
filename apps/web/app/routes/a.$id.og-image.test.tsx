import { beforeEach, describe, expect, test, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  selectFrom: vi.fn(),
}))
const fetchShareOgImageMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/db.server', () => ({
  createDb: () => dbMock,
}))
vi.mock('~/services/og-image-worker.server', () => ({
  fetchShareOgImage: fetchShareOgImageMock,
}))

import { loader } from './a.$id.og-image'

const pngResponse = new Response(new Uint8Array([137, 80, 78, 71]), {
  headers: { 'content-type': 'image/png' },
})

beforeEach(() => {
  vi.clearAllMocks()
  fetchShareOgImageMock.mockResolvedValue(pngResponse)
})

describe('/a/:id/og-image loader', () => {
  test('renders an Open Graph image for link shares', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'link123abc',
        workspace_id: 'workspace123',
        owner_user_id: 'owner123',
        name: 'demo.html',
        derived_title: 'Demo Report',
        title_override: null,
        visibility: 'link',
        plan: 'plus',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
        owner_email: 'owner@example.com',
        owner_name: 'Owner',
        owner_image: 'https://artifactshare.com/api/avatar/owner123',
        r2_key: 'artifacts/link123abc/v1/index.html',
      }),
    )

    const response = await loader({
      params: { id: 'link123abc' },
      request: new Request(
        'https://artifactshare.com/a/link123abc/og-image?v=2026-06-29',
      ),
    })

    expect(response).toBe(pngResponse)
    expect(fetchShareOgImageMock).toHaveBeenCalledWith({
      title: 'Demo Report',
      ownerLabel: 'Owner',
      ownerAvatarUrl: 'https://artifactshare.com/api/avatar/owner123',
      urlLabel: 'artifactshare.com/a/link123abc',
    })
  })

  test('falls back to owner email when the owner name is empty', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'link123abc',
        workspace_id: 'workspace123',
        owner_user_id: 'owner123',
        name: 'demo.html',
        derived_title: 'Demo Report',
        title_override: null,
        visibility: 'link',
        plan: 'plus',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
        owner_email: 'owner@example.com',
        owner_name: '',
        owner_image: 'https://images.example.com/remote-avatar.png',
        r2_key: 'artifacts/link123abc/v1/index.html',
      }),
    )

    await loader({
      params: { id: 'link123abc' },
      request: new Request('https://artifactshare.com/a/link123abc/og-image'),
    })

    expect(fetchShareOgImageMock).toHaveBeenCalledWith({
      title: 'Demo Report',
      ownerLabel: 'owner@example.com',
      ownerAvatarUrl: null,
      urlLabel: 'artifactshare.com/a/link123abc',
    })
  })

  test('rejects a same-origin URL that only resembles the avatar route', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'link123abc',
        workspace_id: 'workspace123',
        owner_user_id: 'owner123',
        name: 'demo.html',
        derived_title: 'Demo Report',
        title_override: null,
        visibility: 'link',
        plan: 'plus',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
        owner_email: 'owner@example.com',
        owner_name: 'Owner',
        owner_image:
          'https://artifactshare.com/api/avatar/owner123/untrusted.png',
        r2_key: 'artifacts/link123abc/v1/index.html',
      }),
    )

    await loader({
      params: { id: 'link123abc' },
      request: new Request('https://artifactshare.com/a/link123abc/og-image'),
    })

    expect(fetchShareOgImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAvatarUrl: null }),
    )
  })

  test('hides non-link shares', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'private123',
        name: 'demo.html',
        derived_title: null,
        title_override: null,
        visibility: 'private',
        owner_email: 'owner@example.com',
        owner_name: 'Owner',
        r2_key: 'artifacts/private123/v1/index.html',
      }),
    )

    await expect(
      loader({
        params: { id: 'private123' },
        request: new Request('https://artifactshare.com/a/private123/og-image'),
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fetchShareOgImageMock).not.toHaveBeenCalled()
  })

  test('hides link shares when the workspace policy denies anonymous access', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'disabled123',
        workspace_id: 'workspace123',
        owner_user_id: 'owner123',
        name: 'demo.html',
        derived_title: 'Demo Report',
        title_override: null,
        visibility: 'link',
        plan: 'team',
        link_sharing_enabled: 0,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
        owner_email: 'owner@example.com',
        owner_name: 'Owner',
        r2_key: 'artifacts/disabled123/v1/index.html',
      }),
    )

    await expect(
      loader({
        params: { id: 'disabled123' },
        request: new Request(
          'https://artifactshare.com/a/disabled123/og-image',
        ),
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fetchShareOgImageMock).not.toHaveBeenCalled()
  })

  test('hides link shares without a current file', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'missing123',
        workspace_id: 'workspace123',
        owner_user_id: 'owner123',
        name: 'demo.html',
        derived_title: null,
        title_override: null,
        visibility: 'link',
        plan: 'plus',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
        owner_email: 'owner@example.com',
        owner_name: 'Owner',
        r2_key: null,
      }),
    )

    await expect(
      loader({
        params: { id: 'missing123' },
        request: new Request('https://artifactshare.com/a/missing123/og-image'),
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fetchShareOgImageMock).not.toHaveBeenCalled()
  })
})

function shareableQuery(row: unknown) {
  return chain({
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  })
}

function chain<T extends Record<string, unknown>>(terminal: T): T {
  const target: Record<string, unknown> = { ...terminal }
  for (const method of ['innerJoin', 'leftJoin', 'select', 'where']) {
    target[method] = vi.fn(() => target)
  }
  return target as T
}
