import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflowPath = [
  'config/public-ci.yml',
  '.github/workflows/public-ci.yml',
].find((file) => fs.existsSync(file))
assert.ok(workflowPath)
const workflow = fs.readFileSync(workflowPath, 'utf8')

const publicPackagePaths = [
  fs.existsSync('config/package.public.json')
    ? 'config/package.public.json'
    : 'package.json',
  fs.existsSync('config/package.web.public.json')
    ? 'config/package.web.public.json'
    : 'apps/web/package.json',
  'packages/cli/package.json',
  'tools/static-site-fixtures/package.json',
]

export function assertPublicPackageScriptsAreSafe(packages) {
  for (const [packagePath, packageJson] of packages)
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      const label = `${packagePath}#${name}`
      assert.doesNotMatch(
        command,
        /pull_request_target|self-hosted|secrets\./i,
        label,
      )
      for (const segment of command.split(/&&|\|\||;/u)) {
        assert.doesNotMatch(segment, /\bwrangler\s+secret\b/i, label)
        assert.doesNotMatch(
          segment,
          /\bpnpm\s+(?!exec\b)[^&;|]*\b(?:deploy|publish)\b/i,
          label,
        )
        assert.doesNotMatch(segment, /\bnpm\s+publish\b/i, label)
        if (/\bwrangler\s+deploy\b/i.test(segment))
          assert.match(segment, /(?:^|\s)--dry-run(?:\s|$)/u, label)
      }
    }
}

test('public CI is valid YAML', () => {
  assert.deepEqual(YAML.parseDocument(workflow).errors, [])
})

test('YAML parser rejects malformed workflow syntax', () => {
  assert.notEqual(YAML.parseDocument('jobs:\n\tvalidate: bad').errors.length, 0)
})

test('public CI is hosted and credential-free', () => {
  assert.match(workflow, /runs-on:\s*ubuntu-latest/)
  assert.doesNotMatch(
    workflow,
    /pull_request_target|self-hosted|secrets\.|wrangler\s+(deploy|secret)|pnpm\s+(deploy|publish)|npm\s+publish/i,
  )
})

test('PRs run only the install-free boundary guard', () => {
  assert.match(workflow, /pull-request-guard:/)
  assert.match(workflow, /if: github\.event_name == 'pull_request'/)
  assert.doesNotMatch(
    workflow.split('  validate:')[0],
    /pnpm install|pnpm validate|test:runtime/,
  )
  assert.match(workflow, /--base\s+"\$PUBLIC_PR_BASE"/)
  assert.match(workflow, /--head\s+"\$PUBLIC_PR_HEAD"/)
  assert.match(
    workflow,
    /git -C "\$GITHUB_WORKSPACE\/head" fetch --no-tags "\$GITHUB_WORKSPACE\/trusted" "\$PUBLIC_PR_BASE"/,
  )
})

test('public full CI is merge-queue-only with a stable check-run name', () => {
  assert.match(workflow, /validate:\n\s+name: Public full validation/)
  assert.match(workflow, /merge_group:\s*\n\s+types: \[checks_requested\]/)
  assert.match(
    workflow,
    /validate:\s*\n\s+name: Public full validation\s*\n\s+if: github\.event_name == 'merge_group'/,
  )
  assert.doesNotMatch(workflow, /^\s+push:/m)
  assert.doesNotMatch(workflow, /merge_group_head_sha|merge_method/)
})

test('public CI checks out the merge-group SHA', () => {
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/)
  assert.match(workflow, /fetch-depth:\s*0/)
})

test('public CI installs Playwright from the web workspace', () => {
  assert.match(
    workflow,
    /run:\s*pnpm --filter @artifactshare\/web exec playwright install --with-deps chrome/,
  )
  assert.doesNotMatch(
    workflow,
    /run:\s*pnpm exec playwright install --with-deps chrome/,
  )
})

test('all exported package scripts are credential-free and non-publishing', () => {
  assertPublicPackageScriptsAreSafe(
    publicPackagePaths.map((packagePath) => [
      packagePath,
      JSON.parse(fs.readFileSync(packagePath, 'utf8')),
    ]),
  )
})

test('package script reachability rejects deploy, publish, and credentials', () => {
  for (const command of [
    'wrangler deploy',
    'wrangler secret put TOKEN',
    'pnpm --filter app deploy',
    'pnpm publish',
    'npm publish',
    'node task.mjs secrets.DEPLOY_TOKEN',
  ])
    assert.throws(() =>
      assertPublicPackageScriptsAreSafe([
        ['package.json', { scripts: { validate: command } }],
      ]),
    )
})

test('package script reachability allows Wrangler dry-run builds', () => {
  assert.doesNotThrow(() =>
    assertPublicPackageScriptsAreSafe([
      [
        'package.json',
        {
          scripts: {
            build: 'wrangler deploy -c wrangler.jsonc --dry-run --outdir build',
          },
        },
      ],
    ]),
  )
})
