import { describe, expect, test } from 'vitest'

type AuthMiddleware =
  | 'requireUserMiddleware'
  | 'requireUserApiMiddleware'
  | 'requireUserApiWithBearerMiddleware'
  | 'requireBridgeBearerMiddleware'

const expectedMiddleware: Record<string, AuthMiddleware> = {
  '_home/_protected/_layout.tsx': 'requireUserMiddleware',
  '_protected/_layout.tsx': 'requireUserMiddleware',
  'api.artifacts.$id.sharing-context.tsx': 'requireUserApiMiddleware',
  'api.artifacts.$id.tsx': 'requireUserApiMiddleware',
  'api.bridge.v1.health.ts': 'requireBridgeBearerMiddleware',
  'api.bridge.v1.requests.ts': 'requireBridgeBearerMiddleware',
  'api.cli.artifacts.$id.append.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.comments.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.download.$.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.download.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.auth.refresh-credentials.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.device-approval.tsx': 'requireUserApiMiddleware',
  'api.cli.doctor.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.projects.$id.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.projects.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.resolve.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.shareables.$id.edit.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.shareables.$id.move.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.whoami.tsx': 'requireUserApiWithBearerMiddleware',
  'api.project-candidates.tsx': 'requireUserApiMiddleware',
  'api.projects.$id.share-defaults.tsx': 'requireUserApiMiddleware',
  'api.projects.$id.tsx': 'requireUserApiMiddleware',
  'api.search-palette.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.comments.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.export-asset.$.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.export-source.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.grants.lookup.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.move.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.reopen.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.save.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.versions.tsx': 'requireUserApiWithBearerMiddleware',
  'api.shareables.$id.viewers.tsx': 'requireUserApiMiddleware',
  'api.shareables.uploads.tsx': 'requireUserApiWithBearerMiddleware',
  // Slack notify callback は cookie セッションのブラウザ遷移で戻るため
  // bearer なしの requireUserMiddleware を使う。
  'api.slack.notify.callback.tsx': 'requireUserMiddleware',
}

const routeSources = import.meta.glob(
  [
    './**/*.{ts,tsx}',
    '!./**/*.test.{ts,tsx}',
    '!./**/+components/**',
    '!./**/+hooks/**',
    '!./**/+lib/**',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

function routeName(path: string) {
  return path.replace('./', '')
}

function importedAuthMiddleware(source: string): AuthMiddleware | null {
  const namedImport = source.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]~\/middleware\/auth['"]/,
  )?.[1]
  const middlewareMatch = namedImport?.match(
    /\b(requireUserMiddleware|requireUserApiMiddleware|requireUserApiWithBearerMiddleware|requireBridgeBearerMiddleware)\b/,
  )
  return (middlewareMatch?.[1] as AuthMiddleware | undefined) ?? null
}

function declaredMiddleware(source: string): AuthMiddleware | null {
  const exportMatch = source.match(
    /export\s+const\s+middleware\s*=\s*\[\s*(requireUserMiddleware|requireUserApiMiddleware|requireUserApiWithBearerMiddleware|requireBridgeBearerMiddleware)\s*\]/,
  )
  return (exportMatch?.[1] as AuthMiddleware | undefined) ?? null
}

describe('route modules declare their required authentication middleware', () => {
  test('finds auth middleware among multiple named imports', () => {
    const source = `
      import {
        requireUser,
        requireUserApiMiddleware,
      } from '~/middleware/auth'
    `

    expect(importedAuthMiddleware(source)).toBe('requireUserApiMiddleware')
  })

  test('the explicit contract covers every route source with a direct auth declaration', () => {
    const actual = Object.fromEntries(
      Object.entries(routeSources)
        .map(([path, source]) => [
          routeName(path),
          importedAuthMiddleware(source),
        ])
        .filter(
          (entry): entry is [string, AuthMiddleware] => entry[1] !== null,
        ),
    )

    expect(actual).toEqual(expectedMiddleware)
  })

  test('each contracted route directly imports and exports its assigned middleware', () => {
    for (const [path, middleware] of Object.entries(expectedMiddleware)) {
      const source = routeSources[`./${path}`]
      expect(importedAuthMiddleware(source), path).toBe(middleware)
      expect(declaredMiddleware(source), path).toBe(middleware)
    }
  })
})
