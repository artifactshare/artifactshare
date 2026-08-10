import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { unstable_readConfig } from 'wrangler'
import YAML from 'yaml'

function config(file, env) {
  return unstable_readConfig(
    { config: `apps/web/${file}`, ...(env ? { env } : {}) },
    { hideWarnings: true },
  )
}

const app = config('wrangler.production.jsonc')
const alerts = config('wrangler.alerts.jsonc', 'production')
const ogImage = config('wrangler.og-image.jsonc', 'production')
const sandbox = config('wrangler.sandbox.jsonc', 'production')
const webPackage = JSON.parse(fs.readFileSync('apps/web/package.json', 'utf8'))
const workflowSource = fs.readFileSync(
  '.github/workflows/deploy-production.yml',
  'utf8',
)
const workflow = YAML.parse(workflowSource)

test('production configs preserve the four public Worker entrypoints', () => {
  assert.match(app.main, /\/workers\/app\.ts$/u)
  assert.match(alerts.main, /\/workers\/alerts\.ts$/u)
  assert.match(ogImage.main, /\/workers\/og-image\.ts$/u)
  assert.match(sandbox.main, /\/workers\/sandbox\.ts$/u)
  for (const worker of [app, alerts, ogImage, sandbox]) {
    assert.equal(worker.vars.APP_ENV, 'production')
    assert.ok(worker.name)
  }
})

test('production app and sandbox share D1 and artifact storage', () => {
  assert.equal(app.d1_databases[0].binding, 'DB')
  assert.equal(sandbox.d1_databases[0].binding, 'DB')
  assert.equal(
    app.d1_databases[0].database_id,
    sandbox.d1_databases[0].database_id,
  )
  assert.equal(app.r2_buckets[0].binding, 'BUCKET')
  assert.equal(app.r2_buckets[0].bucket_name, sandbox.r2_buckets[0].bucket_name)
  assert.equal(app.services[0].service, ogImage.name)
  assert.equal(app.tail_consumers[0].service, alerts.name)
})

test('production deployment keeps migration and Workers in one order', () => {
  const command = webPackage.scripts['deploy:production']
  const expectedOrder = [
    'build:production',
    'build:alerts:production',
    'build:og-image:production',
    'build:sandbox:production',
    'db:apply:remote:production',
    'wrangler.alerts.jsonc --env production',
    'wrangler.og-image.jsonc --env production',
    'wrangler.sandbox.jsonc --env production',
  ]
  let cursor = -1
  for (const marker of expectedOrder) {
    const next = command.indexOf(marker, cursor + 1)
    assert.ok(next > cursor, `deployment marker out of order: ${marker}`)
    cursor = next
  }
  assert.match(
    command,
    /WRANGLER_LOG_PATH=\.\.\/\.\.\/\.wrangler\/logs pnpm exec wrangler deploy$/u,
  )
  assert.doesNotMatch(
    command,
    /wrangler deploy -c wrangler\.production\.jsonc/u,
  )
})

test('production workflow deploys only production inputs from main', () => {
  assert.ok(workflow.on.workflow_dispatch)
  assert.deepEqual(workflow.on.push, {
    branches: ['main'],
    paths: [
      'apps/web/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
  })
  assert.equal(workflow.on.pull_request, undefined)
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'shadow')
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.type, 'string')
  assert.doesNotMatch(
    JSON.stringify(workflow.jobs.shadow),
    /secrets\.|environment/u,
  )
  assert.match(
    workflowSource,
    /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}[\s\S]*test "\$EXPECTED_SHA" = "\$GITHUB_SHA"[\s\S]*Verify the exact merge-queue validated SHA/u,
  )
  assert.match(
    workflowSource,
    /GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*verify-validated-sha\.mjs "\$\{\{ github\.sha \}\}"/u,
  )
  for (const jobName of ['shadow', 'deploy']) {
    const setup = workflow.jobs[jobName].steps.find((step) =>
      step.uses?.startsWith('pnpm/action-setup@'),
    )
    assert.ok(setup)
    assert.equal(setup.with?.version, undefined)
  }
})

test('production workflow exposes readable run, job, and result summaries', () => {
  assert.equal(workflow.name, 'Deploy production')
  assert.match(workflow['run-name'], /^Production /u)
  assert.equal(workflow.jobs.shadow.name, 'Validate production build')
  assert.equal(workflow.jobs.deploy.name, 'Deploy and verify production')
  assert.match(workflowSource, /GITHUB_STEP_SUMMARY/gu)
  assert.match(workflowSource, /Production build validated/u)
  assert.match(workflowSource, /Production deployment verified/u)
})

test('production writes require the protected environment', () => {
  assert.deepEqual(workflow.jobs.deploy.environment, {
    name: 'production',
    url: 'https://artifactshare.com',
  })
  assert.equal(workflow.jobs.deploy.needs, 'shadow')
  assert.equal(
    workflow.jobs.deploy.if,
    "github.event_name == 'push' || inputs.mode == 'deploy'",
  )
  assert.match(
    JSON.stringify(workflow.jobs.deploy),
    /secrets\.CLOUDFLARE_API_TOKEN/u,
  )
  assert.deepEqual(
    [...workflowSource.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(
      (match) => match[1],
    ),
    ['CLOUDFLARE_API_TOKEN'],
  )
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})

test('production deploy verifies the complete public origin with retries', () => {
  const deploy = JSON.stringify(workflow.jobs.deploy)
  assert.match(
    deploy,
    /node scripts\/verify-production-origin\.mjs --retries 2 --retry-delay-ms 15000/u,
  )
  assert.doesNotMatch(deploy, /curl|sleep 30/u)
})
