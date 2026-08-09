import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflowPath = '.github/workflows/public-ci.yml'
const workflow = fs.readFileSync(workflowPath, 'utf8')
const visualConfig = fs.readFileSync(
  'apps/web/vitest.visual.browser.config.ts',
  'utf8',
)
const visualCompose = fs.readFileSync('compose.playwright.yml', 'utf8')

const publicPackagePaths = [
  'package.json',
  'apps/web/package.json',
  'packages/cli/package.json',
  'tools/static-site-fixtures/package.json',
]

export function assertPublicPackageScriptsAreSafe(packages) {
  for (const [packagePath, packageJson] of packages)
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      const label = `${packagePath}#${name}`
      if (label === 'apps/web/package.json#deploy:production') {
        assert.match(
          command,
          /^pnpm build:production && pnpm build:alerts:production && pnpm build:og-image:production && pnpm build:sandbox:production && pnpm db:apply:remote:production && .+wrangler deploy -c wrangler\.alerts\.jsonc --env production && .+wrangler deploy -c wrangler\.og-image\.jsonc --env production && .+wrangler deploy -c wrangler\.sandbox\.jsonc --env production && .+wrangler deploy$/u,
          label,
        )
        continue
      }
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

test('public CI pins external actions and disables install scripts', () => {
  const actionRefs = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1],
  )
  assert.ok(actionRefs.length > 0)
  for (const actionRef of actionRefs) {
    if (actionRef.startsWith('./')) continue
    assert.match(actionRef, /^[^@\s]+@[0-9a-f]{40}$/u, actionRef)
  }
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/)
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
    /--author-association\s+"\$PUBLIC_PR_AUTHOR_ASSOCIATION"/,
  )
  assert.match(workflow, /--head-repo-fork\s+"\$PUBLIC_PR_HEAD_REPO_FORK"/)
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

test('unique browser and local-state checks run after validation', () => {
  const validateIndex = workflow.indexOf('run: pnpm validate')
  const devSetupIndex = workflow.indexOf('run: pnpm check:dev-setup')
  const navigationIndex = workflow.indexOf('run: pnpm check:in-app-navigation')
  const runtimeIndex = workflow.indexOf('run: pnpm test:runtime')
  assert.ok(validateIndex >= 0)
  assert.ok(validateIndex < devSetupIndex)
  assert.ok(devSetupIndex < navigationIndex)
  assert.ok(navigationIndex < runtimeIndex)
  assert.match(workflow, /PLAYWRIGHT_CHANNEL:\s*chrome/u)
})

test('CLI release is tag-only, current-main-only, preflighted, and OIDC-only', () => {
  const releaseWorkflow = YAML.parse(
    fs.readFileSync('.github/workflows/release-cli.yml', 'utf8'),
  )
  assert.deepEqual(releaseWorkflow.on.push.tags, ['cli-v*'])
  assert.equal(releaseWorkflow.permissions.contents, 'read')
  assert.equal(releaseWorkflow.permissions['id-token'], 'write')
  const release = releaseWorkflow.jobs.release
  assert.equal(release['runs-on'], 'ubuntu-latest')
  const text = JSON.stringify(release)
  const runs = release.steps.map((step) => step.run ?? '').join('\n')
  assert.match(runs, /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/)
  assert.match(runs, /pnpm check:cli-release/)
  assert.match(runs, /npm view.*PKG_NAME.*PKG_VERSION.*version/)
  assert.match(runs, /pnpm check:cli-reference/)
  assert.match(
    text,
    /pnpm publish --no-git-checks --access public --provenance/,
  )
  assert.doesNotMatch(text, /secrets\./)
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

test('visual gate uses exact Linux Compose baselines', () => {
  assert.doesNotMatch(visualConfig, /allowedMismatchedPixelRatio/u)
  assert.match(visualConfig, /VISUAL_FAULT/u)
  assert.deepEqual(YAML.parseDocument(visualCompose).errors, [])
  assert.match(visualCompose, /platform: linux\/amd64/u)
  assert.match(
    visualCompose,
    /mcr\.microsoft\.com\/playwright:[^\s]+@sha256:[0-9a-f]{64}/u,
  )
  assert.match(visualCompose, /CI: 'true'/u)
  assert.match(visualCompose, /--frozen-lockfile --ignore-scripts/u)
  assert.match(
    visualCompose,
    /vitest\.visual\.browser\.config\.ts --run --update/u,
  )
  const webPackage = JSON.parse(
    fs.readFileSync('apps/web/package.json', 'utf8'),
  )
  assert.match(webPackage.scripts['test:visual-browser'], /docker compose/u)
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
