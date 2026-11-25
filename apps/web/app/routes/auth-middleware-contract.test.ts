import { describe, expect, test } from 'vitest'

type AuthMiddleware =
  | 'requireUserMiddleware'
  | 'requireUserApiMiddleware'
  | 'requireUserApiWithBearerMiddleware'
  | 'requireBridgeBearerMiddleware'

const expectedMiddleware: Record<string, AuthMiddleware> = {
  '_home/_protected/_layout.tsx': 'requireUserMiddleware',
  '_protected/_layout.tsx': 'requireUserMiddleware',
  // Fetched only by Settings confirmations: an expired session is a 401 the
  // confirmation handles, not a sign-in redirect to the resource itself.
  '_protected/settings/billing-preview.tsx': 'requireUserApiMiddleware',
  '_protected/settings/recipients.tsx': 'requireUserApiMiddleware',
  'api.access-requests.$id.tsx': 'requireUserApiMiddleware',
  'api.access-requests.count.tsx': 'requireUserApiMiddleware',
  'api.access-requests.tsx': 'requireUserApiMiddleware',
  'api.artifacts.$id.sharing-context.tsx': 'requireUserApiMiddleware',
  'api.artifacts.$id.tsx': 'requireUserApiMiddleware',
  'api.bridge.v1.health.ts': 'requireBridgeBearerMiddleware',
  'api.bridge.v1.requests.ts': 'requireBridgeBearerMiddleware',
  'api.cli.artifacts.$id.append.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.comments.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.download.$.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.download.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.versions.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.$id.adopt.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.artifacts.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.auth.refresh-credentials.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.device-approval.tsx': 'requireUserApiMiddleware',
  'api.cli.doctor.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.projects.$id.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.projects.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.resolve.tsx': 'requireUserApiWithBearerMiddleware',
  'api.shareables.$id.retention.tsx': 'requireUserApiMiddleware',
  'api.cli.shareables.$id.edit.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.shareables.$id.move.tsx': 'requireUserApiWithBearerMiddleware',
  'api.cli.whoami.tsx': 'requireUserApiWithBearerMiddleware',
  'api.project-candidates.tsx': 'requireUserApiMiddleware',
  'api.projects.$id.share-defaults.tsx': 'requireUserApiMiddleware',
  'api.projects.$id.tsx': 'requireUserApiMiddleware',
  'api.search-groups.tsx': 'requireUserApiMiddleware',
  'api.search.tsx': 'requireUserApiMiddleware',
  'api.search-suggestions.tsx': 'requireUserApiMiddleware',
  'api.search-logs.tsx': 'requireUserApiMiddleware',
  'api.search-logs.$id.opens.tsx': 'requireUserApiMiddleware',
  'api.search-palette.tsx': 'requireUserApiMiddleware',
  'api.share-recipient-candidates.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.abuse-check.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.access-request.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.comments.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.export-asset.$.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.export-source.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.grants.lookup.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.move.tsx': 'requireUserApiMiddleware',
  'api.shareables.$id.appeal.tsx': 'requireUserApiMiddleware',
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

// One level of `const alias = someMiddleware`, so that naming a list entry
// locally is not a contract change.
function aliasTarget(source: string, name: string): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const assignment = source.match(
    new RegExp(
      `\\bconst\\s+${name}\\s*(?::[^=\\n]+)?=\\s*([A-Za-z_$][\\w$]*)[\\s,;\\n]`,
    ),
  )
  return assignment?.[1] ?? null
}

// Whether a route registers its middleware directly, behind other middleware
// in the list, or through a local alias is its own business. What must hold is
// that the list it exports leads to the middleware the contract assigns it:
// a non-empty list is not enough, because a route can export a list that
// authenticates nobody.
function registersMiddleware(
  source: string,
  assigned: AuthMiddleware,
): boolean {
  const list = source.match(
    /export\s+const\s+middleware\s*=\s*\[([^\]]*)\]/,
  )?.[1]
  if (list === undefined) return false
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .some(
      (entry) => entry === assigned || aliasTarget(source, entry) === assigned,
    )
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

  test.each([
    {
      case: 'registers it directly',
      body: 'export const middleware = [requireUserApiMiddleware]',
      registers: true,
    },
    {
      case: 'registers it after another middleware',
      body: 'export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]',
      registers: true,
    },
    {
      case: 'registers it through a local alias',
      body: [
        'const authed = requireUserApiMiddleware',
        'export const middleware = [authed]',
      ].join('\n'),
      registers: true,
    },
    {
      case: 'registers a different auth middleware',
      body: 'export const middleware = [requireUserMiddleware]',
      registers: false,
    },
    {
      case: 'registers a local pass-through instead',
      body: [
        'const saveMiddleware = (_args, next) => next()',
        'export const middleware = [saveMiddleware]',
      ].join('\n'),
      registers: false,
    },
    {
      case: 'exports an empty list',
      body: 'export const middleware = []',
      registers: false,
    },
    {
      case: 'exports no list at all',
      body: 'export const loader = () => null',
      registers: false,
    },
  ])('a route that $case', ({ body, registers }) => {
    const source = [
      "import { requireUserApiMiddleware, requireUserMiddleware } from '~/middleware/auth'",
      body,
    ].join('\n')

    expect(registersMiddleware(source, 'requireUserApiMiddleware')).toBe(
      registers,
    )
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

  test('each contracted route imports its assigned middleware and registers one', () => {
    for (const [path, middleware] of Object.entries(expectedMiddleware)) {
      const source = routeSources[`./${path}`]
      expect(importedAuthMiddleware(source), path).toBe(middleware)
      expect(registersMiddleware(source, middleware), path).toBe(true)
    }
  })
})
