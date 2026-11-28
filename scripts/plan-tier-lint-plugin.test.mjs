import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import plugin, { isPlanTierScope } from './plan-tier-lint-plugin.mjs'
import { lintFixturePrefix } from './lib/lint-fixture-paths.mjs'

const root = resolve(import.meta.dirname, '..')

function violations(file, text) {
  const reports = []
  const visitor = plugin.rules['no-plan-name-comparison'].create({
    filename: join(root, file),
    sourceCode: {
      text,
      getLocFromIndex: (index) => ({ line: 1, column: index }),
    },
    report: (report) => reports.push(report),
  })
  visitor.Program?.()
  return reports
}

const APP_FILE = 'apps/web/app/services/example.server.ts'

test('rejects matching a plan by a paid plan name in TS and SQL', () => {
  for (const text of [
    `if (workspace.plan === 'team') {}`,
    `if (workspace?.plan !== 'team') {}`,
    `const x = row.workspace_plan === "plus"`,
    `const x = observedPlan === 'plus'`,
    `const x = 'team' === workspace.plan`,
    "sql`AND w.plan = 'team'`",
    "sql`AND w.plan='team'`",
    "sql`AND w.plan <> 'plus'`",
    "sql`AND posting_workspace.plan IN ('plus', 'team')`",
    "sql`AND plan in ('free')`",
    `db.selectFrom('workspaces').where('workspaces.plan', '=', 'team')`,
    `db.selectFrom('workspaces').where('workspaces.plan', 'in', ['plus', 'team'])`,
  ]) {
    assert.equal(violations(APP_FILE, text).length, 1, text)
  }
})

test('allows tier checks and matching the free plan', () => {
  for (const text of [
    `if (planTier(workspace.plan) === 'team') {}`,
    `if (planTier(policy.plan) === 'individual') {}`,
    `if (workspace.plan === 'free') {}`,
    `if (workspace.plan !== 'free') {}`,
    "sql`AND w.plan = 'free'`",
    "sql`AND w.plan != 'free'`",
    "sql`AND ${planInTierSql('w.plan', ['team'])}`",
    `db.selectFrom('workspaces').where('plan', '=', 'free')`,
    `const planLabel = kind === 'team'`,
  ]) {
    assert.deepEqual(violations(APP_FILE, text), [], text)
  }
})

test('scopes the rule to app code outside billing and tests', () => {
  for (const file of [
    'apps/web/app/services/access.server.ts',
    'apps/web/app/routes/_protected/settings/+components/external-access-page.tsx',
    'apps/web/workers/app.ts',
  ]) {
    assert.equal(isPlanTierScope(file), true, file)
  }
  for (const file of [
    'apps/web/app/lib/plan-tier.ts',
    'apps/web/app/lib/billing-prices.ts',
    'apps/web/app/lib/pricing-content.ts',
    'apps/web/app/services/billing-sync.server.ts',
    'apps/web/app/services/upgrade-request.server.ts',
    'apps/web/app/components/app/plan-card.tsx',
    'apps/web/app/routes/_protected/settings/+components/billing-page.tsx',
    'apps/web/app/services/access.server.test.ts',
    'apps/web/app/test/sqlite-fixture.ts',
    'apps/web/app/d1-tests/access.test.ts',
    'apps/web/db/migrations/0097_access_request_handler.sql',
    'packages/cli/src/index.ts',
  ]) {
    assert.equal(isPlanTierScope(file), false, file)
  }
})

test('the configured lint reports a plan name comparison in app code', () => {
  const directory = mkdtempSync(join(root, lintFixturePrefix('plan-tier')))
  try {
    const file = join(directory, 'example.server.ts')
    writeFileSync(
      file,
      `export const team = (plan: string) => plan === 'team'\n`,
    )
    const result = spawnSync(
      'pnpm',
      ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', '-f', 'json', file],
      { cwd: root, encoding: 'utf8' },
    )
    const output = result.stdout + result.stderr
    assert.ok([0, 1].includes(result.status), output)
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    const codes = report.diagnostics
      .filter((diagnostic) => diagnostic.filename === relative(root, file))
      .map((diagnostic) => diagnostic.code)
    assert.ok(
      codes.some((code) =>
        /plan-tier\(no-plan-name-comparison\)|plan-tier\/no-plan-name-comparison/.test(
          code,
        ),
      ),
      output,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
