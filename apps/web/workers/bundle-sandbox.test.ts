import type { Kysely } from 'kysely'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '../app/test/sqlite-fixture'
import { loadStaticSiteFixture } from '../app/test/static-site-fixtures'
import type { DB } from '../app/types/db'

const dbRef = vi.hoisted(() => ({
  current: null as Kysely<DB> | null,
}))

const storageMock = vi.hoisted(() => ({
  getArtifact: vi.fn(),
}))

const consumeJtiMock = vi.hoisted(() => vi.fn())

const envMock = vi.hoisted(() => ({
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: 'test-secret',
  BUCKET: {},
}))

vi.mock('cloudflare:workers', () => ({
  env: envMock,
}))

vi.mock('../app/services/db.server', () => ({
  createDb: () => {
    if (!dbRef.current) throw new Error('db not bound')
    return dbRef.current
  },
}))

vi.mock('../app/services/storage.server', () => storageMock)
vi.mock('../app/services/sandbox-jti.server', () => ({
  consumeJti: consumeJtiMock,
}))

import { signSandboxToken } from '../app/lib/sandbox-token'
import { sandboxVersionLabel } from '../app/lib/hosts'
import {
  VIOLATION_REPORTER_SHA256,
  VIOLATION_REPORTER_TAG,
} from '../app/lib/csp-reporter'
import {
  createViolationReporterHandler,
  handleArtifactSandboxRequest,
  injectReadyReporter,
} from './bundle-sandbox'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '../app/lib/sandbox-block-report'

interface DocumentEndStub {
  append: ReturnType<typeof vi.fn>
}

class HtmlRewriterStub {
  static instances: HtmlRewriterStub[] = []
  static noElementsNext = false
  readonly onCalls: string[] = []
  readonly documentEnd: DocumentEndStub = { append: vi.fn() }
  documentHandler: { end?: (documentEnd: DocumentEndStub) => void } | undefined
  readonly elementHandler = { before: vi.fn() }
  readonly transform = vi.fn((response: Response) => {
    if (this.emitElements) {
      this.handlers.get('*')?.element?.(this.elementHandler)
    }
    this.documentHandler?.end?.(this.documentEnd)
    return response
  })
  private readonly handlers = new Map<
    string,
    { element?: (element: unknown) => void }
  >()
  private emitElements = !HtmlRewriterStub.noElementsNext

  constructor() {
    HtmlRewriterStub.instances.push(this)
  }

  on(selector: string, handler: { element?: (element: unknown) => void }) {
    this.onCalls.push(selector)
    this.handlers.set(selector, handler)
    return this
  }

  onDocument(handler: { end?: (documentEnd: unknown) => void }) {
    this.documentHandler = handler as {
      end?: (documentEnd: DocumentEndStub) => void
    }
    return this
  }
}

function useHtmlRewriterStub() {
  HtmlRewriterStub.instances = []
  HtmlRewriterStub.noElementsNext = false
  vi.stubGlobal('HTMLRewriter', HtmlRewriterStub)
}

function cspDirective(header: string, name: string) {
  return header
    .split('; ')
    .find((directive) => directive.startsWith(`${name} `))
}

const externalCspSources =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com'
const youtubeFrameCspSources =
  'https://www.youtube-nocookie.com https://www.youtube.com'
const expectedPermissionsPolicy =
  'fullscreen=(self "https://www.youtube-nocookie.com" "https://www.youtube.com"), clipboard-write=(self), camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), midi=()'

function sandboxOrigin(
  versionId = 'v-bundle',
  shareableId = 'abc123def4',
): string {
  return `https://${sandboxVersionLabel(shareableId, versionId)}.sandbox.localhost:5174`
}

describe('sandbox probe', () => {
  test('returns the fixed response without touching storage, DB, or JTI', async () => {
    dbRef.current = null
    const requests = [
      new Request(`${sandboxOrigin()}${SANDBOX_PROBE_PATH}`, {
        headers: {
          Origin: 'https://artifactshare.com',
          Cookie: 'as_bnd=secret',
          authorization: 'Bearer secret',
        },
      }),
      new Request(
        `https://not-an-id.sandbox.artifactshare.com${SANDBOX_PROBE_PATH}`,
        {
          headers: { Origin: 'https://www.artifactshare.com' },
        },
      ),
    ]
    const responses = await Promise.all(
      requests.map((request) => handleArtifactSandboxRequest(request)),
    )
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe(
        'private, no-store, no-transform',
      )
      expect(response.headers.get('Content-Type')).toBe(
        'text/plain; charset=utf-8',
      )
      expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
        'same-origin',
      )
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe(
        'same-site',
      )
      expect(response.headers.get('Permissions-Policy')).toContain('camera=()')
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin')
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('X-ArtifactShare-Sandbox-Probe')).toBe(
        SANDBOX_PROBE_MARKER,
      )
      expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
        'X-ArtifactShare-Sandbox-Probe',
      )
      expect(response.headers.get('Vary')).toBe('Origin')
      await expect(response.text()).resolves.toBe(SANDBOX_PROBE_MARKER)
      expect(response.headers.has('access-control-allow-credentials')).toBe(
        false,
      )
    }
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test.each([
    ['https://artifactshare.com', 'https://artifactshare.com'],
    ['https://www.artifactshare.com', 'https://www.artifactshare.com'],
    ['https://localhost:5173', 'https://localhost:5173'],
  ])('allows only the app origin %s', async (origin, expected) => {
    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}${SANDBOX_PROBE_PATH}`, {
        headers: { Origin: origin },
      }),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(expected)
  })

  test('omits ACAO for disallowed origins and normal responses', async () => {
    const probe = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}${SANDBOX_PROBE_PATH}`, {
        headers: { Origin: 'https://evil.example' },
      }),
    )
    expect(probe.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect(probe.headers.has('Access-Control-Expose-Headers')).toBe(false)
    envMock.APP_ENV = 'production'
    const normal = await handleArtifactSandboxRequest(
      new Request(
        'https://unrecognized.sandbox.artifactshare.com/not-a-bundle-path',
        {
          headers: { Origin: 'https://artifactshare.com' },
        },
      ),
    )
    envMock.APP_ENV = 'development'
    expect(normal.headers.has('Access-Control-Allow-Origin')).toBe(false)
  })
})

describe('violation reporter injection handler', () => {
  test.each([
    '<!doctype html><html></html>',
    '\uFEFF<!doctype html><html></html>',
    '<!-- generated --><!doctype html><html></html>',
    '\uFEFF \n<!-- generated -->\n<!doctype html><html></html>',
  ])('keeps the doctype ahead of fallback injection for %j', (html) => {
    const injected = injectReadyReporter(html)
    expect(injected.indexOf('<!doctype html>')).toBeLessThan(
      injected.indexOf(VIOLATION_REPORTER_TAG),
    )
    expect(injected.indexOf(VIOLATION_REPORTER_TAG)).toBeLessThan(
      injected.indexOf('<html>'),
    )
  })

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    dbRef.current = fixture.db
    await seedStaticSite(fixture.db)
    consumeJtiMock.mockReset().mockResolvedValue(true)
    storageMock.getArtifact.mockReset()
  })

  test('injects before the first element only', () => {
    const handler = createViolationReporterHandler()
    const first = { before: vi.fn() }
    const second = { before: vi.fn() }

    handler.element(first)
    handler.element(second)

    expect(first.before).toHaveBeenCalledTimes(1)
    expect(first.before).toHaveBeenCalledWith(VIOLATION_REPORTER_TAG, {
      html: true,
    })
    expect(second.before).not.toHaveBeenCalled()
  })

  test('does not append at document end after element injection', () => {
    const handler = createViolationReporterHandler()
    const first = { before: vi.fn() }
    const documentEnd = { append: vi.fn() }

    handler.element(first)
    handler.end(documentEnd)

    expect(documentEnd.append).not.toHaveBeenCalled()
  })

  test('appends at document end when there are no elements', () => {
    const handler = createViolationReporterHandler()
    const documentEnd = { append: vi.fn() }

    handler.end(documentEnd)

    expect(documentEnd.append).toHaveBeenCalledTimes(1)
    expect(documentEnd.append).toHaveBeenCalledWith(VIOLATION_REPORTER_TAG, {
      html: true,
    })
  })

  test('uses the real documentResponse wiring for HTML and registers one handler', async () => {
    useHtmlRewriterStub()
    try {
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      const token = await entrypointToken()
      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin()}/index.html?t=${token}`),
      )

      expect(response.status).toBe(200)
      const rewriter = HtmlRewriterStub.instances.at(-1)!
      expect(rewriter.onCalls).toEqual(['*'])
      expect(rewriter.transform).toHaveBeenCalledTimes(1)
      expect(rewriter.elementHandler.before).toHaveBeenCalledTimes(1)
      expect(rewriter.documentHandler).toBeDefined()
      expect(rewriter.documentEnd.append).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('keeps the Node fallback instrumentation path working', async () => {
    vi.stubGlobal('HTMLRewriter', undefined)
    try {
      await seedStaticSiteVersion(dbRef.current!, {
        versionId: 'v-node-md',
        entrypointPath: '/index.md',
        entrypointR2Key: 'ws-a/abc123def4/v-node-md/index.md',
        files: [
          {
            id: 'vf-node-md',
            path: '/index.md',
            r2Key: 'ws-a/abc123def4/v-node-md/index.md',
            mimeType: 'text/markdown; charset=utf-8',
          },
        ],
      })
      await dbRef
        .current!.updateTable('shareables')
        .set({ current_version_id: 'v-node-md' })
        .where('id', '=', 'abc123def4')
        .execute()
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact('# Hello', 'text/markdown'),
      )
      const token = await staticSiteToken({
        versionId: 'v-node-md',
        r2Key: 'ws-a/abc123def4/v-node-md/index.md',
        jti: 'j-node-md',
      })
      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin('v-node-md')}/index.md?t=${token}`),
      )

      const body = await response.text()
      expect(body.split(VIOLATION_REPORTER_TAG)).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('places fallback reporter before the first authored script', async () => {
    vi.stubGlobal('HTMLRewriter', undefined)
    try {
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact(
          '<!doctype html><script>window.authored = true</script>',
          'text/html',
        ),
      )
      const token = await entrypointToken()
      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin()}/index.html?t=${token}`),
      )
      const body = await response.text()
      expect(body.indexOf(VIOLATION_REPORTER_TAG)).toBeLessThan(
        body.indexOf('<script>window.authored'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('uses document fallback wiring when HTML has no elements', async () => {
    useHtmlRewriterStub()
    try {
      HtmlRewriterStub.noElementsNext = true
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact('<!doctype html>', 'text/html'),
      )
      const token = await entrypointToken()
      await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin()}/index.html?t=${token}`),
      )

      const rewriter = HtmlRewriterStub.instances.at(-1)!
      expect(rewriter.documentHandler).toBeDefined()
      expect(rewriter.documentEnd.append).toHaveBeenCalledTimes(1)
      expect(rewriter.documentEnd.append).toHaveBeenCalledWith(
        VIOLATION_REPORTER_TAG,
        { html: true },
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('uses the same instrumentation path once for Markdown responses', async () => {
    useHtmlRewriterStub()
    try {
      await dbRef
        .current!.insertInto('shareables')
        .values({
          id: 'mdsingle01',
          workspace_id: 'ws-a',
          owner_user_id: 'owner-1',
          slug: null,
          name: 'readme.md',
          derived_title: null,
          title_override: null,
          description: null,
          artifact_kind: 'markdown_page',
          visibility: 'private',
          current_version_id: 'v-md-single',
          container_id: 'owner-inbox',
          created_at: '2026-05-22T00:00:00.000Z',
          updated_at: '2026-05-22T00:00:00.000Z',
          last_accessed_at: null,
        })
        .execute()
      await dbRef
        .current!.insertInto('versions')
        .values({
          id: 'v-md-single',
          shareable_id: 'mdsingle01',
          artifact_kind: 'markdown_page',
          status: 'published',
          entrypoint_path: '/readme.md',
          r2_key: 'md-key',
          size_bytes: 10,
          sha256: 'sha-md-single',
          created_by_id: 'owner-1',
          created_at: '2026-05-22T00:00:00.000Z',
          published_at: '2026-05-22T00:00:00.000Z',
        })
        .execute()
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact('# Readme', 'text/markdown'),
      )
      const token = await singleFileToken({
        id: 'mdsingle01',
        versionId: 'v-md-single',
        r2Key: 'md-key',
        renderType: 'md',
      })
      const response = await handleArtifactSandboxRequest(
        new Request(
          `${sandboxOrigin('v-md-single', 'mdsingle01')}/readme.md?t=${token}`,
        ),
      )
      expect(response.status).toBe(200)
      expect(HtmlRewriterStub.instances).toHaveLength(1)
      expect(HtmlRewriterStub.instances[0].transform).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

async function seedOwnerInbox(db: Kysely<DB>) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'owner-1',
      created_by_id: 'owner-1',
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function seedStaticSite(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Workspace',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: 'plus',
      link_sharing_enabled: 1,
      external_posting_enabled: 1,
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'owner-1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
  await seedOwnerInbox(db)
  await db
    .insertInto('shareables')
    .values({
      id: 'abc123def4',
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: 'index.html',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'static_site',
      visibility: 'private',
      current_version_id: 'v-bundle',
      container_id: 'owner-inbox',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v-bundle',
      shareable_id: 'abc123def4',
      artifact_kind: 'static_site',
      status: 'published',
      entrypoint_path: '/index.html',
      r2_key: 'ws-a/abc123def4/v-bundle/index.html',
      size_bytes: 20,
      sha256: 'sha-bundle',
      created_by_id: 'owner-1',
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('version_files')
    .values([
      {
        id: 'vf-index',
        version_id: 'v-bundle',
        path: '/index.html',
        r2_key: 'ws-a/abc123def4/v-bundle/index.html',
        mime_type: 'text/html; charset=utf-8',
        size_bytes: 20,
        sha256: 'sha-index',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      },
      {
        id: 'vf-css',
        version_id: 'v-bundle',
        path: '/style.css',
        r2_key: 'ws-a/abc123def4/v-bundle/style.css',
        mime_type: 'text/css; charset=utf-8',
        size_bytes: 6,
        sha256: 'sha-css',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      },
      {
        id: 'vf-video',
        version_id: 'v-bundle',
        path: '/demo.mp4',
        r2_key: 'ws-a/abc123def4/v-bundle/demo.mp4',
        mime_type: 'video/mp4',
        size_bytes: 10,
        sha256: 'sha-video',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      },
      {
        id: 'vf-other-md',
        version_id: 'v-bundle',
        path: '/other.md',
        r2_key: 'ws-a/abc123def4/v-bundle/other.md',
        mime_type: 'text/markdown; charset=utf-8',
        size_bytes: 20,
        sha256: 'sha-other-md',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      },
      {
        id: 'vf-logo',
        version_id: 'v-bundle',
        path: '/logo.png',
        r2_key: 'ws-a/abc123def4/v-bundle/logo.png',
        mime_type: 'image/png',
        size_bytes: 8,
        sha256: 'sha-logo',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      },
    ])
    .execute()
}

async function seedStaticSiteVersion(
  db: Kysely<DB>,
  args: {
    versionId: string
    entrypointPath: string
    entrypointR2Key: string
    fallbackToIndex?: boolean
    files: Array<{ id: string; path: string; r2Key: string; mimeType: string }>
  },
) {
  await db
    .insertInto('versions')
    .values({
      id: args.versionId,
      shareable_id: 'abc123def4',
      artifact_kind: 'static_site',
      status: 'published',
      entrypoint_path: args.entrypointPath,
      r2_key: args.entrypointR2Key,
      size_bytes: 20,
      sha256: `sha-${args.versionId}`,
      fallback_to_index: args.fallbackToIndex ? 1 : 0,
      created_by_id: 'owner-1',
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('version_files')
    .values(
      args.files.map((file) => ({
        id: file.id,
        version_id: args.versionId,
        path: file.path,
        r2_key: file.r2Key,
        mime_type: file.mimeType,
        size_bytes: 20,
        sha256: `sha-${file.id}`,
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      })),
    )
    .execute()
}

async function seedStaticSiteFixtureVersion(
  db: Kysely<DB>,
  args: {
    fixtureName: string
    versionId: string
    fallbackToIndex?: boolean
  },
) {
  const files = await loadStaticSiteFixture(args.fixtureName)
  const entrypoint = files.find((file) => file.path === '/index.html')
  if (!entrypoint) throw new Error('fixture must include /index.html')
  await seedStaticSiteVersion(db, {
    versionId: args.versionId,
    entrypointPath: entrypoint.path,
    entrypointR2Key: `ws-a/abc123def4/${args.versionId}/index.html`,
    fallbackToIndex: args.fallbackToIndex,
    files: files.map((file, index) => ({
      id: `vf-${args.versionId}-${index}`,
      path: file.path,
      r2Key: `ws-a/abc123def4/${args.versionId}${file.path}`,
      mimeType: file.mimeType,
    })),
  })
  return files
}

async function seedSingleFile(
  db: Kysely<DB>,
  args: {
    id: string
    versionId: string
    artifactKind: 'html_page' | 'markdown_page'
    entrypointPath: string
    r2Key: string
  },
) {
  await seedOwnerInbox(db)
  await db
    .insertInto('shareables')
    .values({
      id: args.id,
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: args.entrypointPath.slice(1),
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: args.artifactKind,
      visibility: 'private',
      current_version_id: args.versionId,
      container_id: 'owner-inbox',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: args.versionId,
      shareable_id: args.id,
      artifact_kind: args.artifactKind,
      status: 'published',
      entrypoint_path: args.entrypointPath,
      r2_key: args.r2Key,
      size_bytes: 20,
      sha256: `sha-${args.versionId}`,
      created_by_id: 'owner-1',
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

function storedArtifact(body: string, contentType: string) {
  return {
    body: new Blob([body]).stream(),
    text: async () => body,
    httpMetadata: { contentType },
    size: body.length,
    uploaded: new Date('2026-05-22T00:00:00.000Z'),
  }
}

function storedBinaryArtifact(body: Uint8Array, contentType: string) {
  return {
    body: new Blob([arrayBufferFromBytes(body)]).stream(),
    text: async () => new TextDecoder().decode(body),
    httpMetadata: { contentType },
    size: body.byteLength,
    uploaded: new Date('2026-05-22T00:00:00.000Z'),
  }
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function mockFixtureArtifacts(
  versionId: string,
  files: ReadonlyArray<{ path: string; body: Uint8Array; mimeType: string }>,
) {
  const byKey = new Map(
    files.map((file) => [
      `ws-a/abc123def4/${versionId}${file.path}`,
      { body: file.body, mimeType: file.mimeType },
    ]),
  )
  storageMock.getArtifact.mockImplementation(async (_bucket, key: string) => {
    const file = byKey.get(key)
    return file ? storedBinaryArtifact(file.body, file.mimeType) : null
  })
}

async function entrypointToken() {
  return await signSandboxToken(
    {
      uid: 'viewer-1',
      wid: 'ws-a',
      aid: 'abc123def4',
      vid: 'v-bundle',
      fid: 'ws-a/abc123def4/v-bundle/index.html',
      mt: null,
      t: 'static_site',
      jti: 'j1',
    },
    'test-secret',
  )
}

async function anonymousEntrypointToken() {
  return await signSandboxToken(
    {
      uid: null,
      wid: 'ws-a',
      aid: 'abc123def4',
      vid: 'v-bundle',
      fid: 'ws-a/abc123def4/v-bundle/index.html',
      mt: null,
      t: 'static_site',
      jti: 'j-anon',
    },
    'test-secret',
  )
}

async function staticSiteToken(args: {
  versionId: string
  r2Key: string
  jti: string
}) {
  return await signSandboxToken(
    {
      uid: 'viewer-1',
      wid: 'ws-a',
      aid: 'abc123def4',
      vid: args.versionId,
      fid: args.r2Key,
      mt: null,
      t: 'static_site',
      jti: args.jti,
    },
    'test-secret',
  )
}

async function singleFileToken(args: {
  id: string
  versionId: string
  r2Key: string
  renderType: 'html' | 'md'
}) {
  return await signSandboxToken(
    {
      uid: 'viewer-1',
      wid: 'ws-a',
      aid: args.id,
      vid: args.versionId,
      fid: args.r2Key,
      mt: null,
      t: args.renderType,
      jti: `j-${args.id}`,
    },
    'test-secret',
  )
}

describe('handleArtifactSandboxRequest', () => {
  beforeEach(async () => {
    envMock.APP_ENV = 'development'
    const fixture = createMigratedInMemoryDb()
    dbRef.current = fixture.db
    await seedStaticSite(fixture.db)
    consumeJtiMock.mockReset().mockResolvedValue(true)
    storageMock.getArtifact.mockReset()
  })

  test('serves a token-authorized entrypoint and issues a bundle cookie', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Hello')
    expect(response.headers.get('Set-Cookie')).toContain('as_bnd=')
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'frame-ancestors https://localhost:5173',
    )
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "script-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com",
    )
    expect(response.headers.get('Content-Security-Policy')).not.toContain(
      `script-src-elem 'self' 'unsafe-inline' 'sha256-${VIOLATION_REPORTER_SHA256}'`,
    )
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    )
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "font-src 'self' data: https://fonts.gstatic.com",
    )
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "media-src 'self'",
    )
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/index.html',
    )
  })

  test('serves byte ranges for static-site video assets', async () => {
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce({
        ...storedBinaryArtifact(new Uint8Array([2, 3, 4, 5]), 'video/mp4'),
        range: { offset: 2, length: 4 },
        size: 10,
      })
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/demo.mp4`, {
        headers: { Cookie: cookie ?? '', Range: 'bytes=2-5' },
      }),
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    const rangeHeaders = storageMock.getArtifact.mock.calls.at(-1)?.[2]
      ?.range as Headers
    expect(rangeHeaders.get('Range')).toBe('bytes=2-5')
  })

  test('ignores byte ranges for transformed static-site documents', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`, {
        headers: { Range: 'bytes=2-5' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Hello')
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/index.html',
    )
  })

  test('rejects unsatisfiable static-site byte ranges', async () => {
    storageMock.getArtifact.mockResolvedValueOnce(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/demo.mp4`, {
        headers: { Cookie: cookie ?? '', Range: 'bytes=10-20' },
      }),
    )

    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
    expect(storageMock.getArtifact).toHaveBeenCalledTimes(1)
  })

  test('ignores unsupported static-site byte range formats', async () => {
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedBinaryArtifact(new Uint8Array(10), 'video/mp4'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/demo.mp4`, {
        headers: { Cookie: cookie ?? '', Range: 'bytes=0-1,4-5' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(storageMock.getArtifact).toHaveBeenLastCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/demo.mp4',
    )
  })

  test.each(['private'] as const)(
    'rejects an anonymous %s entrypoint token',
    async (visibility) => {
      await dbRef
        .current!.updateTable('shareables')
        .set({ visibility })
        .where('id', '=', 'abc123def4')
        .execute()
      storageMock.getArtifact.mockResolvedValue(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      const token = await anonymousEntrypointToken()

      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin()}/index.html?t=${token}`),
      )

      expect(response.status).toBe(401)
      await expect(response.text()).resolves.toBe('Invalid token')
      expect(storageMock.getArtifact).not.toHaveBeenCalled()
      expect(consumeJtiMock).not.toHaveBeenCalled()
    },
  )

  test('rejects an anonymous token on a static-site asset path', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('body{}', 'text/css; charset=utf-8'),
    )
    const token = await anonymousEntrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css?t=${token}`),
    )

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('Invalid token')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test('serves dev sandbox requests when Vite normalizes request URL to localhost', async () => {
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('body{}', 'text/css; charset=utf-8'),
      )
    const token = await entrypointToken()

    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`https://localhost:5173/index.html?t=${token}`, {
        headers: {
          host: `${sandboxVersionLabel('abc123def4', 'v-bundle')}.sandbox.localhost:5174`,
        },
      }),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    expect(entrypoint.status).toBe(200)
    await expect(entrypoint.text()).resolves.toContain('Hello')
    expect(cookie).toContain('as_bnd=')

    const asset = await handleArtifactSandboxRequest(
      new Request('https://localhost:5173/style.css', {
        headers: {
          Cookie: cookie ?? '',
          host: `${sandboxVersionLabel('abc123def4', 'v-bundle')}.sandbox.localhost:5174`,
        },
      }),
    )

    expect(asset.status).toBe(200)
    await expect(asset.text()).resolves.toBe('body{}')
  })

  test('serves bundle assets from the issued host-only cookie', async () => {
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('body{}', 'text/css; charset=utf-8'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    expect(
      cspDirective(
        entrypoint.headers.get('Content-Security-Policy') ?? '',
        'frame-src',
      ),
    ).toBe(`frame-src ${youtubeFrameCspSources}`)
    expect(entrypoint.headers.get('Referrer-Policy')).toBe('strict-origin')
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('body{}')
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin')
    expect(consumeJtiMock).toHaveBeenCalledTimes(1)
  })

  test('refreshes the bundle cookie and redirects to a same-origin path', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin()}/index.html?t=${token}&as_next=%2Fdocs%2Fintro.html%3Ftab%3Done%23top`,
      ),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(
      '/docs/intro.html?tab=one#top',
    )
    expect(response.headers.get('Set-Cookie')).toContain('as_bnd=')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('encodes non-ASCII redirect paths for the Location header', async () => {
    await dbRef
      .current!.insertInto('version_files')
      .values({
        id: 'vf-japanese',
        version_id: 'v-bundle',
        path: '/概要.html',
        r2_key: 'ws-a/abc123def4/v-bundle/概要.html',
        mime_type: 'text/html; charset=utf-8',
        size_bytes: 20,
        sha256: 'sha-japanese',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin()}/index.html?t=${token}&as_next=%2F%E6%A6%82%E8%A6%81.html`,
      ),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/%E6%A6%82%E8%A6%81.html')
    expect(response.headers.get('Set-Cookie')).toContain('as_bnd=')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('does not redirect to an external as_next target', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin()}/index.html?t=${token}&as_next=https%3A%2F%2Fevil.example%2F`,
      ),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Location')).toBeNull()
    await expect(response.text()).resolves.toContain('Hello')
    expect(response.headers.get('Set-Cookie')).toContain('as_bnd=')
  })

  test('serves index.html for extensionless static-site history paths when fallback is enabled', async () => {
    await dbRef
      .current!.updateTable('versions')
      .set({ fallback_to_index: 1 })
      .where('id', '=', 'v-bundle')
      .execute()
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Entry</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Fallback</body>', 'text/html'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/projects/alpha`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Fallback')
    expect(storageMock.getArtifact).toHaveBeenLastCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/index.html',
    )
  })

  test('keeps missing asset-shaped paths as 404 when fallback is enabled', async () => {
    await dbRef
      .current!.updateTable('versions')
      .set({ fallback_to_index: 1 })
      .where('id', '=', 'v-bundle')
      .execute()
    storageMock.getArtifact.mockResolvedValueOnce(
      storedArtifact('<!doctype html><body>Entry</body>', 'text/html'),
    )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/assets/missing.js`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('This artifact is unavailable.')
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin')
    expect(storageMock.getArtifact).toHaveBeenCalledTimes(1)
  })

  test('keeps extensionless misses as 404 when fallback is disabled', async () => {
    storageMock.getArtifact.mockResolvedValueOnce(
      storedArtifact('<!doctype html><body>Entry</body>', 'text/html'),
    )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/projects/alpha`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('This artifact is unavailable.')
    expect(storageMock.getArtifact).toHaveBeenCalledTimes(1)
  })

  test.each([
    {
      fixtureName: 'react-spa',
      versionId: 'v-sample-spa',
      requestPath: '/settings',
      expectedBody: 'Vite + React',
      expectedContentType: 'text/html; charset=utf-8',
    },
    {
      fixtureName: 'react-router-prerender',
      versionId: 'v-sample-router',
      requestPath: '/blog.data',
      expectedBody: 'Prerendered blog page',
      expectedContentType: 'application/octet-stream',
    },
    {
      fixtureName: 'next-export',
      versionId: 'v-sample-next',
      requestPath: '/about.html',
      expectedBody: 'Create Next App',
      expectedContentType: 'text/html; charset=utf-8',
    },
  ])(
    'serves the $fixtureName sample fixture through the sandbox',
    async (sample) => {
      const files = await seedStaticSiteFixtureVersion(dbRef.current!, {
        fixtureName: sample.fixtureName,
        versionId: sample.versionId,
        fallbackToIndex: true,
      })
      await dbRef
        .current!.updateTable('shareables')
        .set({ current_version_id: sample.versionId })
        .where('id', '=', 'abc123def4')
        .execute()
      mockFixtureArtifacts(sample.versionId, files)
      const token = await staticSiteToken({
        versionId: sample.versionId,
        r2Key: `ws-a/abc123def4/${sample.versionId}/index.html`,
        jti: `j-${sample.versionId}`,
      })
      const entrypoint = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin(sample.versionId)}/index.html?t=${token}`),
      )
      const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin(sample.versionId)}${sample.requestPath}`, {
          headers: { Cookie: cookie ?? '' },
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe(
        sample.expectedContentType,
      )
      if (sample.fixtureName === 'next-export') {
        expect(response.headers.get('Content-Security-Policy')).toContain(
          "script-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        )
      }
      await expect(response.text()).resolves.toContain(sample.expectedBody)
    },
  )

  test('allows reloading a consumed static-site entrypoint when its bundle cookie is already present', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()
    const first = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = first.headers.get('Set-Cookie')?.split(';')[0]
    consumeJtiMock.mockResolvedValueOnce(false)

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Hello')
    expect(consumeJtiMock).toHaveBeenCalledTimes(2)
  })

  test('rejects a consumed static-site entrypoint token without the matching bundle cookie', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()
    consumeJtiMock.mockResolvedValue(false)

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('Invalid token')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('logs sandbox_denied with reason jti_replayed for a consumed token', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const token = await entrypointToken()
    consumeJtiMock.mockResolvedValue(false)

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )

    expect(response.status).toBe(401)
    expect(warnSpy).toHaveBeenCalledWith(
      'sandbox_denied',
      expect.objectContaining({
        reason: 'jti_replayed',
        status: 401,
        aid: 'abc123def4',
        hasBundleCookie: false,
      }),
    )
    warnSpy.mockRestore()
  })

  test('logs sandbox_denied with reason token_expired for an expired token', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const token = await signSandboxToken(
      {
        uid: 'viewer-1',
        wid: 'ws-a',
        aid: 'abc123def4',
        vid: 'v-bundle',
        fid: 'ws-a/abc123def4/v-bundle/index.html',
        mt: null,
        t: 'static_site',
        jti: 'j-expired',
      },
      'test-secret',
      -10,
    )

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )

    expect(response.status).toBe(401)
    expect(consumeJtiMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      'sandbox_denied',
      expect.objectContaining({
        reason: 'token_expired',
        status: 401,
        expiredBySeconds: expect.any(Number),
      }),
    )
    warnSpy.mockRestore()
  })

  test('normalizes static-site request paths to NFC before asset lookup', async () => {
    await dbRef
      .current!.insertInto('version_files')
      .values({
        id: 'vf-cafe',
        version_id: 'v-bundle',
        path: '/assets/café.html',
        r2_key: 'ws-a/abc123def4/v-bundle/assets/café.html',
        mime_type: 'text/html; charset=utf-8',
        size_bytes: 20,
        sha256: 'sha-cafe',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Cafe</body>', 'text/html'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/assets/cafe%CC%81.html`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Cafe')
    expect(storageMock.getArtifact).toHaveBeenLastCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/assets/café.html',
    )
  })

  test('renders a static-site markdown entrypoint as html', async () => {
    await seedStaticSiteVersion(dbRef.current!, {
      versionId: 'v-md-entry',
      entrypointPath: '/index.md',
      entrypointR2Key: 'ws-a/abc123def4/v-md-entry/index.md',
      files: [
        {
          id: 'vf-md-entry',
          path: '/index.md',
          r2Key: 'ws-a/abc123def4/v-md-entry/index.md',
          mimeType: 'text/markdown; charset=utf-8',
        },
      ],
    })
    await dbRef
      .current!.updateTable('shareables')
      .set({ current_version_id: 'v-md-entry' })
      .where('id', '=', 'abc123def4')
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('# Bundle docs', 'text/markdown; charset=utf-8'),
    )
    const token = await staticSiteToken({
      versionId: 'v-md-entry',
      r2Key: 'ws-a/abc123def4/v-md-entry/index.md',
      jti: 'j-md-entry',
    })

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-md-entry')}/index.md?t=${token}`),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    )
    await expect(response.text()).resolves.toContain(
      '<h1 id="bundle-docs">Bundle docs</h1>',
    )
  })

  test('keeps markdown links and image references usable inside the bundle', async () => {
    await seedStaticSiteVersion(dbRef.current!, {
      versionId: 'v-md-links',
      entrypointPath: '/index.md',
      entrypointR2Key: 'ws-a/abc123def4/v-md-links/index.md',
      files: [
        {
          id: 'vf-md-links-index',
          path: '/index.md',
          r2Key: 'ws-a/abc123def4/v-md-links/index.md',
          mimeType: 'text/markdown; charset=utf-8',
        },
        {
          id: 'vf-md-links-other',
          path: '/other.md',
          r2Key: 'ws-a/abc123def4/v-md-links/other.md',
          mimeType: 'text/markdown; charset=utf-8',
        },
        {
          id: 'vf-md-links-logo',
          path: '/logo.png',
          r2Key: 'ws-a/abc123def4/v-md-links/logo.png',
          mimeType: 'image/png',
        },
      ],
    })
    await dbRef
      .current!.updateTable('shareables')
      .set({ current_version_id: 'v-md-links' })
      .where('id', '=', 'abc123def4')
      .execute()
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact(
          '# Bundle docs\n\n[Next](./other.md)\n\n![Logo](./logo.png)',
          'text/markdown; charset=utf-8',
        ),
      )
      .mockResolvedValueOnce(
        storedArtifact('# Other page', 'text/markdown; charset=utf-8'),
      )
      .mockResolvedValueOnce(storedArtifact('png-data', 'image/png'))
    const token = await staticSiteToken({
      versionId: 'v-md-links',
      r2Key: 'ws-a/abc123def4/v-md-links/index.md',
      jti: 'j-md-links',
    })

    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-md-links')}/index.md?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]
    const entrypointBody = await entrypoint.text()

    expect(entrypoint.status).toBe(200)
    expect(entrypointBody).toContain('href="./other.md"')
    expect(entrypointBody).toContain('src="./logo.png"')
    expect(cookie).toContain('as_bnd=')

    const linkedPage = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-md-links')}/other.md`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )
    expect(linkedPage.status).toBe(200)
    expect(linkedPage.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    )
    const linkedPageCsp =
      linkedPage.headers.get('Content-Security-Policy') ?? ''
    const linkedPageConnectSrc = cspDirective(linkedPageCsp, 'connect-src')
    expect(cspDirective(linkedPageCsp, 'frame-src')).toBe(
      `frame-src ${youtubeFrameCspSources}`,
    )
    expect(linkedPageConnectSrc).toBe(
      `connect-src 'self' ${externalCspSources}`,
    )
    expect(cspDirective(linkedPageCsp, 'script-src-elem')).toBe(
      `script-src-elem 'self' 'unsafe-inline' ${externalCspSources}`,
    )
    expect(linkedPageConnectSrc?.slice("connect-src 'self' ".length)).toBe(
      cspDirective(linkedPageCsp, 'script-src-elem')?.slice(
        "script-src-elem 'self' 'unsafe-inline' ".length,
      ),
    )
    await expect(linkedPage.text()).resolves.toContain(
      '<h1 id="other-page">Other page</h1>',
    )

    const image = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-md-links')}/logo.png`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Content-Security-Policy')).toBeNull()
    await expect(image.text()).resolves.toBe('png-data')
  })

  test('serves bundle assets for the cookie version after current version changes', async () => {
    await seedStaticSiteVersion(dbRef.current!, {
      versionId: 'v-next',
      entrypointPath: '/index.html',
      entrypointR2Key: 'ws-a/abc123def4/v-next/index.html',
      files: [
        {
          id: 'vf-next',
          path: '/index.html',
          r2Key: 'ws-a/abc123def4/v-next/index.html',
          mimeType: 'text/html; charset=utf-8',
        },
      ],
    })
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('body{}', 'text/css; charset=utf-8'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]
    await dbRef
      .current!.updateTable('shareables')
      .set({ current_version_id: 'v-next' })
      .where('id', '=', 'abc123def4')
      .execute()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('body{}')
    expect(storageMock.getArtifact).toHaveBeenLastCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/style.css',
    )
  })

  test('serves a published historical static-site entrypoint on its own origin', async () => {
    await seedStaticSiteVersion(dbRef.current!, {
      versionId: 'v-next',
      entrypointPath: '/index.html',
      entrypointR2Key: 'ws-a/abc123def4/v-next/index.html',
      files: [
        {
          id: 'vf-next-index',
          path: '/index.html',
          r2Key: 'ws-a/abc123def4/v-next/index.html',
          mimeType: 'text/html; charset=utf-8',
        },
      ],
    })
    await dbRef
      .current!.updateTable('shareables')
      .set({ current_version_id: 'v-next' })
      .where('id', '=', 'abc123def4')
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Historical</body>', 'text/html'),
    )
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-bundle')}/?t=${token}`),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Historical')
  })

  test('rejects a valid token presented on a different version origin', async () => {
    const token = await entrypointToken()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-other')}/?t=${token}`),
    )

    expect(response.status).toBe(401)
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('serves a single html file from the version-scoped sandbox origin without a bundle cookie', async () => {
    await seedSingleFile(dbRef.current!, {
      id: 'html123abc',
      versionId: 'v-html',
      artifactKind: 'html_page',
      entrypointPath: '/demo.html',
      r2Key: 'artifacts/html123abc/v-html/index.html',
    })
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await singleFileToken({
      id: 'html123abc',
      versionId: 'v-html',
      r2Key: 'artifacts/html123abc/v-html/index.html',
      renderType: 'html',
    })

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin('v-html', 'html123abc')}/demo.html?t=${token}`,
      ),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads',
    )
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(cspDirective(csp, 'connect-src')).toBe(
      `connect-src ${externalCspSources}`,
    )
    expect(cspDirective(csp, 'frame-src')).toBe(
      `frame-src ${youtubeFrameCspSources}`,
    )
    expect(cspDirective(csp, 'script-src')).toBe(
      `script-src 'unsafe-inline' 'unsafe-eval' ${externalCspSources}`,
    )
    expect(cspDirective(csp, 'connect-src')?.slice('connect-src '.length)).toBe(
      cspDirective(csp, 'script-src')?.slice(
        "script-src 'unsafe-inline' 'unsafe-eval' ".length,
      ),
    )
    expect(response.headers.get('Content-Security-Policy')).not.toContain(
      'webrtc',
    )
    expect(response.headers.get('Permissions-Policy')).toBe(
      expectedPermissionsPolicy,
    )
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
      'same-origin',
    )
    await expect(response.text()).resolves.toContain('Hello')
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'artifacts/html123abc/v-html/index.html',
    )
  })

  test('an embed token widens frame-ancestors to the MCP host and is reusable', async () => {
    await seedSingleFile(dbRef.current!, {
      id: 'embed12345',
      versionId: 'v-embed',
      artifactKind: 'html_page',
      entrypointPath: '/index.html',
      r2Key: 'artifacts/embed12345/v-embed/index.html',
    })
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Report</body>', 'text/html'),
    )
    const token = await signSandboxToken(
      {
        uid: 'viewer-1',
        wid: 'ws-a',
        aid: 'embed12345',
        vid: 'v-embed',
        fid: 'artifacts/embed12345/v-embed/index.html',
        mt: null,
        t: 'html',
        jti: 'j-embed',
        emb: true,
      },
      'test-secret',
      1800,
    )
    const url = `${sandboxOrigin('v-embed', 'embed12345')}/index.html?t=${token}`

    const first = await handleArtifactSandboxRequest(new Request(url))
    expect(first.status).toBe(200)
    const embedCsp = first.headers.get('Content-Security-Policy') ?? ''
    expect(embedCsp).toContain('https://*.web-sandbox.oaiusercontent.com')
    // Cursor / VS Code desktop hosts frame from the app's own origin.
    expect(embedCsp).toContain('vscode-file://vscode-app')
    // Embed tokens skip the one-time nonce so the host can re-render the widget.
    expect(consumeJtiMock).not.toHaveBeenCalled()

    // The same token works again (reusable within its TTL).
    const second = await handleArtifactSandboxRequest(new Request(url))
    expect(second.status).toBe(200)
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test('a normal single-file token keeps frame-ancestors locked to our origin', async () => {
    await seedSingleFile(dbRef.current!, {
      id: 'locked1234',
      versionId: 'v-locked',
      artifactKind: 'html_page',
      entrypointPath: '/index.html',
      r2Key: 'artifacts/locked1234/v-locked/index.html',
    })
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Report</body>', 'text/html'),
    )
    const token = await singleFileToken({
      id: 'locked1234',
      versionId: 'v-locked',
      r2Key: 'artifacts/locked1234/v-locked/index.html',
      renderType: 'html',
    })

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin('v-locked', 'locked1234')}/index.html?t=${token}`,
      ),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).not.toContain(
      'web-sandbox.oaiusercontent.com',
    )
    expect(consumeJtiMock).toHaveBeenCalledTimes(1)
  })

  test('renders markdown single-file entrypoints as html and escapes raw html', async () => {
    await seedSingleFile(dbRef.current!, {
      id: 'md123abcde',
      versionId: 'v-md',
      artifactKind: 'markdown_page',
      entrypointPath: '/notes.md',
      r2Key: 'artifacts/md123abcde/v-md/index.md',
    })
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact(
        '# Hello\n\n<iframe src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ" allow="fullscreen"></iframe>\n\n<script>globalThis.untrusted = true</script>',
        'text/markdown',
      ),
    )
    const token = await singleFileToken({
      id: 'md123abcde',
      versionId: 'v-md',
      r2Key: 'artifacts/md123abcde/v-md/index.md',
      renderType: 'md',
    })

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-md', 'md123abcde')}/notes.md?t=${token}`),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    )
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(cspDirective(csp, 'connect-src')).toBe("connect-src 'none'")
    expect(cspDirective(csp, 'frame-src')).toBe(
      `frame-src ${youtubeFrameCspSources}`,
    )
    expect(cspDirective(csp, 'script-src')).toBe(
      `script-src 'sha256-${VIOLATION_REPORTER_SHA256}'`,
    )
    expect(response.headers.get('Permissions-Policy')).toBe(
      expectedPermissionsPolicy,
    )
    const body = await response.text()
    expect(body).toContain('<h1 id="hello">Hello</h1>')
    expect(body).toContain(
      '&lt;iframe src=&quot;https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ&quot; allow=&quot;fullscreen&quot;&gt;&lt;/iframe&gt;',
    )
    expect(body).toContain(
      '&lt;script&gt;globalThis.untrusted = true&lt;/script&gt;',
    )
  })

  test('renders utf-8 markdown without mojibake', async () => {
    await seedSingleFile(dbRef.current!, {
      id: 'mdutf8abcd',
      versionId: 'v-md-utf8',
      artifactKind: 'markdown_page',
      entrypointPath: '/notes.md',
      r2Key: 'artifacts/mdutf8abcd/v-md-utf8/index.md',
    })
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('# 日本語\n\n`pnpm validate` を通す', 'text/markdown'),
    )
    const token = await singleFileToken({
      id: 'mdutf8abcd',
      versionId: 'v-md-utf8',
      r2Key: 'artifacts/mdutf8abcd/v-md-utf8/index.md',
      renderType: 'md',
    })

    const response = await handleArtifactSandboxRequest(
      new Request(
        `${sandboxOrigin('v-md-utf8', 'mdutf8abcd')}/notes.md?t=${token}`,
      ),
    )

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<h1 id="日本語">日本語</h1>')
    expect(body).toContain('を通す')
    expect(body).not.toContain('譌')
    expect(body).not.toContain('繧')
  })

  test('does not send document CSP on static-site assets', async () => {
    storageMock.getArtifact
      .mockResolvedValueOnce(
        storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
      )
      .mockResolvedValueOnce(
        storedArtifact('body{}', 'text/css; charset=utf-8'),
      )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()')
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
      'same-origin',
    )
  })

  test('rejects static-site asset requests without a bundle cookie', async () => {
    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`),
    )

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('Invalid token')
  })

  test('serves anonymous link static-site assets without a bundle cookie', async () => {
    await dbRef
      .current!.updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'abc123def4')
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('body{}', 'text/css; charset=utf-8'),
    )

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('body{}')
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/style.css',
    )
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test('serves anonymous link static-site assets when the bundle cookie is invalid', async () => {
    await dbRef
      .current!.updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'abc123def4')
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('body{}', 'text/css; charset=utf-8'),
    )

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`, {
        headers: { Cookie: 'as_bnd=invalid' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('body{}')
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/style.css',
    )
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test('rechecks the workspace link policy for anonymous assets without a cookie', async () => {
    await dbRef
      .current!.updateTable('workspaces')
      .set({
        plan: 'team',
        link_sharing_enabled: 0,
      })
      .where('id', '=', 'ws-a')
      .execute()
    await dbRef
      .current!.updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'abc123def4')
      .execute()

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/style.css`),
    )

    expect(response.status).toBe(401)
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('serves anonymous link static-site fallback paths without a bundle cookie', async () => {
    await dbRef
      .current!.updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'abc123def4')
      .execute()
    await dbRef
      .current!.updateTable('versions')
      .set({ fallback_to_index: 1 })
      .where('id', '=', 'v-bundle')
      .execute()
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Fallback</body>', 'text/html'),
    )

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/projects/alpha`),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Fallback')
    expect(storageMock.getArtifact).toHaveBeenCalledWith(
      {},
      'ws-a/abc123def4/v-bundle/index.html',
    )
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test.each(['private', 'workspace', 'project'] as const)(
    'rejects anonymous %s static-site assets without a bundle cookie',
    async (visibility) => {
      await dbRef
        .current!.updateTable('shareables')
        .set({ visibility })
        .where('id', '=', 'abc123def4')
        .execute()

      const response = await handleArtifactSandboxRequest(
        new Request(`${sandboxOrigin()}/style.css`),
      )

      expect(response.status).toBe(401)
      await expect(response.text()).resolves.toBe('Invalid token')
      expect(storageMock.getArtifact).not.toHaveBeenCalled()
      expect(consumeJtiMock).not.toHaveBeenCalled()
    },
  )

  test('rejects anonymous link static-site assets that are not in the current version', async () => {
    await dbRef
      .current!.updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'abc123def4')
      .execute()
    await seedStaticSiteVersion(dbRef.current!, {
      versionId: 'v-old',
      entrypointPath: '/index.html',
      entrypointR2Key: 'ws-a/abc123def4/v-old/index.html',
      files: [
        {
          id: 'vf-old-only',
          path: '/old-only.css',
          r2Key: 'ws-a/abc123def4/v-old/old-only.css',
          mimeType: 'text/css; charset=utf-8',
        },
      ],
    })

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-old')}/old-only.css`),
    )

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('Invalid token')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
    expect(consumeJtiMock).not.toHaveBeenCalled()
  })

  test('rejects a bundle cookie on a different bundle subdomain', async () => {
    storageMock.getArtifact.mockResolvedValue(
      storedArtifact('<!doctype html><body>Hello</body>', 'text/html'),
    )
    const token = await entrypointToken()
    const entrypoint = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin()}/index.html?t=${token}`),
    )
    const cookie = entrypoint.headers.get('Set-Cookie')?.split(';')[0]

    const response = await handleArtifactSandboxRequest(
      new Request(`${sandboxOrigin('v-bundle', 'zzz123def4')}/style.css`, {
        headers: { Cookie: cookie ?? '' },
      }),
    )

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('Invalid token')
  })
})
