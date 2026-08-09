#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as readline from 'node:readline/promises'
import { parseVarsFile } from './lib/vars.mjs'
import { cookieHeader, cookiesFromHeaders } from './lib/dev-sign-in.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolvePath(__dirname, '..')
const WEB_DIR = join(REPO_ROOT, 'apps/web')
const DEV_VARS_PATH = join(REPO_ROOT, '.dev.vars')
const APP_ORIGIN = 'https://localhost:5173'
const READINESS_TIMEOUT_MS = 60_000

const REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PLUS_MONTHLY',
  'STRIPE_PRICE_PLUS_YEARLY',
  'STRIPE_PRICE_TEAM_MONTHLY',
  'STRIPE_PRICE_TEAM_YEARLY',
  'STRIPE_PRODUCT_STORAGE_OVERAGE',
  'STRIPE_PORTAL_CONFIGURATION',
]

const QUOTA_PLUS_BYTES = 10_737_418_240
const QUOTA_TEAM_BYTES = 107_374_182_400
const QUOTA_FREE_BYTES = 104_857_600
const PLUS_PROJECT_LIMIT = 20
const OVERAGE_INVOICE_POLL_TIMEOUT_MS = 120_000
const TEST_CLOCK_POLL_TIMEOUT_MS = 120_000
const EXPECTED_OVERAGE_UNIT_AMOUNTS = new Set([10, 16])

const SECRET_PATTERN = /\b(?:sk|rk|whsec)_[A-Za-z0-9_]+\b/g
const STRIPE_IDENTIFIER_PATTERN =
  /\b(?:acct|ch|clock|cs|cus|evt|ii|in|inv|pi|pm|price|prod|py|seti|si|src|sub|sub_sched|tok)_[A-Za-z0-9_]{8,}\b/gi

const SECRET_VALUE_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  'MCP_DEV_TOKEN',
  'D1_REST_API_TOKEN',
  'CLOUDFLARE_API_TOKEN',
]

let secretValuesToRedact = []
const stripeResources = {
  customers: new Set(),
  testClocks: new Set(),
}

const require = createRequire(join(REPO_ROOT, 'packages/cli/package.json'))
const { Agent, fetch: undiciFetch, FormData } = require('undici')
const { File } = require('node:buffer')
const Stripe = createRequire(join(WEB_DIR, 'package.json'))('stripe')

const localFetchDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
})

function registerSecretValues(vars) {
  secretValuesToRedact = SECRET_VALUE_NAMES.map((name) => vars[name]).filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
}

function redact(text) {
  let result = String(text)
    .replace(SECRET_PATTERN, '***redacted***')
    .replace(STRIPE_IDENTIFIER_PATTERN, '***stripe-id***')
  for (const secret of secretValuesToRedact) {
    result = result.split(secret).join('***redacted***')
  }
  return result
}

function writeStream(stream, message) {
  stream.write(`${redact(message)}\n`)
}

const log = {
  info(message) {
    writeStream(process.stdout, message)
  },
  error(message) {
    writeStream(process.stderr, message)
  },
}

function usage() {
  return `Usage: pnpm billing:regression [options]

Stripe test mode billing regression harness.

Options:
  --yes           Skip the Stripe test-resource confirmation
  --only <n[,n...]>  Run only the listed scenario numbers (1-6)
  -h, --help      Show this help`
}

function parseArgs(argv) {
  const options = {
    yes: false,
    only: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') {
      return { ...options, help: true }
    }
    if (arg === '--yes') {
      options.yes = true
      continue
    }
    if (arg === '--only') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}\n\n${usage()}`)
      }
      index += 1
      options.only = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => Number(part))
      continue
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
  }

  if (options.only.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error(
      `Invalid --only value. Use comma-separated scenario numbers.\n\n${usage()}`,
    )
  }

  return options
}

async function loadDevVars() {
  const content = await readFile(DEV_VARS_PATH, 'utf8')
  return parseVarsFile(content)
}

function assertTestStripeKey(stripeKey) {
  if (stripeKey.startsWith('sk_test_') || stripeKey.startsWith('rk_test_')) {
    return
  }
  throw new Error(
    'STRIPE_SECRET_KEY must be a Stripe test mode key. Live or unknown keys are rejected.',
  )
}

function assertRequiredEnv(vars) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !vars[name])
  if (missing.length === 0) return

  throw new Error(
    `Missing required keys in the repository root .dev.vars: ${missing.join(', ')}`,
  )
}

function checkCommand(command, args = ['--version']) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', () => done({ ok: false, stdout, stderr }))
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }))
  })
}

async function assertPrerequisites() {
  const pnpmCheck = await checkCommand('pnpm', ['--version'])
  if (!pnpmCheck.ok) {
    log.error('Error: pnpm is required but was not found on PATH.')
    process.exit(1)
  }

  const stripeCheck = await checkCommand('stripe', ['--version'])
  if (!stripeCheck.ok) {
    log.error('Error: stripe CLI is required but was not found on PATH.')
    process.exit(1)
  }
}

async function verifyWebhookSecret(stripeKey, expectedSecret) {
  const result = await runCommand(
    'stripe',
    ['listen', '--print-secret', '--api-key', stripeKey],
    { logOutput: false },
  )
  if (result.exitCode !== 0) {
    log.error(
      'Error: failed to read webhook secret from stripe listen --print-secret.',
    )
    if (result.stderr) log.error(result.stderr.trim())
    process.exit(1)
  }

  const printedSecret = result.stdout.trim()
  if (printedSecret === expectedSecret) return

  log.error(
    'Error: STRIPE_WEBHOOK_SECRET in the repository root .dev.vars does not match the value from stripe listen --print-secret.',
  )
  log.error(
    'Update STRIPE_WEBHOOK_SECRET in the repository root .dev.vars to the value from stripe listen --print-secret, then re-run.',
  )
  process.exit(1)
}

async function confirmRun(skipConfirm) {
  log.info('')
  log.info(
    'This creates temporary Stripe test resources and uses an isolated local D1 state.',
  )
  if (skipConfirm) return

  if (!process.stdin.isTTY) {
    log.error(
      'Error: Stripe test-resource creation requires confirmation. Re-run with --yes in non-interactive mode.',
    )
    process.exit(1)
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const answer = await rl.question('Run the billing regression? [y/N] ')
  rl.close()

  if (answer.trim().toLowerCase() !== 'y') {
    log.info('Aborted.')
    process.exit(0)
  }
}

function createLineProcessor(onLine) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        onLine(line)
      }
    },
    flush(lineHandler) {
      if (buffer.length > 0) {
        lineHandler(buffer)
        buffer = ''
      }
    },
  }
}

function runCommand(
  command,
  args,
  { cwd = REPO_ROOT, logOutput = true, env = process.env } = {},
) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const stdoutProcessor = createLineProcessor((line) => {
      if (logOutput) log.info(`[${command}] ${line}`)
    })
    const stderrProcessor = createLineProcessor((line) => {
      if (logOutput) log.error(`[${command}] ${line}`)
    })

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (logOutput) stdoutProcessor.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (logOutput) stderrProcessor.push(chunk)
    })

    child.on('close', (exitCode) => {
      if (logOutput) {
        stdoutProcessor.flush((line) => log.info(`[${command}] ${line}`))
        stderrProcessor.flush((line) => log.error(`[${command}] ${line}`))
      }
      done({ exitCode: exitCode ?? 1, stdout, stderr })
    })

    child.on('error', (error) => {
      done({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      })
    })
  })
}

async function resetLocalDb(persistPath) {
  const result = await runCommand('pnpm', [
    'dev:setup',
    '--reset',
    '--target',
    'app',
    '--persist-to',
    persistPath,
  ])
  if (result.exitCode !== 0) {
    throw new Error('Failed to prepare isolated local dev DB.')
  }
}

class ManagedProcesses {
  constructor() {
    this.children = new Map()
    this.shuttingDown = false
    this.unexpectedExit = null
  }

  spawn(name, command, args, options = {}) {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.set(name, child)

    const stdoutProcessor = createLineProcessor((line) => {
      log.info(`[${name}] ${line}`)
      options.onStdoutLine?.(line)
    })
    const stderrProcessor = createLineProcessor((line) => {
      log.error(`[${name}] ${line}`)
      options.onStderrLine?.(line)
    })

    child.stdout?.on('data', (chunk) => {
      stdoutProcessor.push(chunk)
      options.onStdout?.(chunk.toString())
    })
    child.stderr?.on('data', (chunk) => {
      stderrProcessor.push(chunk)
      options.onStderr?.(chunk.toString())
    })

    child.on('close', (code, signal) => {
      stdoutProcessor.flush((line) => log.info(`[${name}] ${line}`))
      stderrProcessor.flush((line) => log.error(`[${name}] ${line}`))
      this.children.delete(name)
      if (this.shuttingDown) return
      this.unexpectedExit = {
        name,
        code: code ?? 1,
        signal: signal ?? null,
      }
    })

    child.on('error', (error) => {
      if (this.shuttingDown) return
      this.unexpectedExit = {
        name,
        code: 1,
        signal: null,
        error: error.message,
      }
    })

    return child
  }

  assertRunning() {
    if (!this.unexpectedExit) return
    const { name, code, signal, error } = this.unexpectedExit
    if (error) {
      throw new Error(`${name} failed to stay running: ${error}`)
    }
    if (signal) {
      throw new Error(`${name} exited unexpectedly with signal ${signal}`)
    }
    throw new Error(`${name} exited unexpectedly with code ${code}`)
  }

  async stop() {
    if (this.shuttingDown) {
      await this.waitForExit()
      return
    }
    this.shuttingDown = true
    this.stopChildren()
    await this.waitForExit()
  }

  stopChildren() {
    this.sigtermSentAt = Date.now()
    for (const child of this.children.values()) {
      if (child.killed) continue
      child.kill('SIGTERM')
    }
  }

  async waitForExit() {
    while (this.children.size > 0) {
      if (this.sigtermSentAt && Date.now() - this.sigtermSentAt >= 10_000) {
        for (const child of this.children.values()) {
          if (!child.killed) child.kill('SIGKILL')
        }
        this.sigtermSentAt = null
      }
      await delay(50)
    }
  }

  installSignalHandlers(onSignal) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        void (async () => {
          await this.stop()
          await onSignal()
          process.exit(signal === 'SIGINT' ? 130 : 143)
        })().catch(() => process.exit(1))
      })
    }
  }
}

async function waitForDevServerReady() {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await undiciFetch(`${APP_ORIGIN}/`, {
        dispatcher: localFetchDispatcher,
      })
      if (response.ok) {
        return
      }
    } catch {
      // keep polling
    }
    await delay(500)
  }
  throw new Error(`Timed out waiting for dev server at ${APP_ORIGIN}`)
}

async function waitForStripeListenReady(onReady) {
  if (onReady.seen) return
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (onReady.seen) return
    await delay(100)
  }
  throw new Error('Timed out waiting for stripe listen readiness (Ready!)')
}

async function startProcesses(stripeKey, persistPath, onSignal) {
  const manager = new ManagedProcesses()
  manager.installSignalHandlers(onSignal)

  const reconcileDoneCount = { value: 0 }
  const stripeReady = { seen: false }
  manager.spawn(
    'dev-app',
    'pnpm',
    ['--filter', '@artifactshare/web', 'dev:app'],
    {
      env: { ...process.env, ARTIFACTSHARE_DEV_PERSIST_PATH: persistPath },
      onStdoutLine(line) {
        if (line.includes('"event":"reconcile_done"')) {
          reconcileDoneCount.value += 1
        }
      },
    },
  )
  manager.spawn(
    'stripe-listen',
    'stripe',
    [
      'listen',
      '--api-key',
      stripeKey,
      '--forward-to',
      `${APP_ORIGIN}/api/stripe/webhook`,
      '--skip-verify',
    ],
    {
      onStdoutLine(line) {
        if (line.includes('Ready!')) stripeReady.seen = true
      },
      onStderrLine(line) {
        if (line.includes('Ready!')) stripeReady.seen = true
      },
    },
  )

  try {
    await Promise.all([
      waitForDevServerReady(),
      waitForStripeListenReady(stripeReady),
    ])
    manager.assertRunning()
  } catch (error) {
    await manager.stop()
    throw error
  }

  return { manager, reconcileDoneCount }
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function pollUntil(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await delay(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}

async function d1(sql) {
  const result = await runCommand(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      harnessContext.persistPath,
      '-c',
      'wrangler.jsonc',
      '--json',
      '--command',
      sql,
    ],
    {
      cwd: WEB_DIR,
      logOutput: false,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(REPO_ROOT, '.wrangler/logs'),
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(`d1 query failed with exit code ${result.exitCode}`)
  }

  const parsed = JSON.parse(result.stdout)
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  return first?.results ?? []
}

async function triggerScheduled() {
  const response = await undiciFetch(`${APP_ORIGIN}/__scheduled`, {
    dispatcher: localFetchDispatcher,
  })
  if (!response.ok) {
    throw new Error(
      `triggerScheduled failed: expected ok response, got ${response.status}`,
    )
  }
  return response
}

function createStripeClient(apiKey) {
  return new Stripe(apiKey)
}

function nowIso() {
  return new Date().toISOString()
}

function brId(label) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = randomBytes(12)
  let suffix = ''
  for (let index = 0; index < 12; index += 1) {
    suffix += alphabet[bytes[index] % alphabet.length]
  }
  return `br-${label}-${suffix}`
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message)
}

async function mintSessionCookie({ persona, workspaceId, role }) {
  const response = await appFetch('/api/auth/dev/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  })
  if (!response.ok) {
    throw new Error(
      `mintSessionCookie: dev sign-in failed with ${response.status}`,
    )
  }

  const body = await response.json().catch(() => null)
  if (!body?.userId) {
    throw new Error('mintSessionCookie: dev sign-in returned no user id')
  }
  const cookies = cookiesFromHeaders(response.headers)
  if (!cookies.length) {
    throw new Error(
      'mintSessionCookie: no session cookie in dev sign-in response',
    )
  }
  const now = nowIso()
  await d1(
    `UPDATE users SET workspace_id='${workspaceId}', updated_at='${now}' WHERE id='${body.userId}'`,
  )
  await d1(
    `INSERT INTO workspace_members (
      workspace_id, user_id, role, status, created_at, updated_at
    ) VALUES (
      '${workspaceId}', '${body.userId}', '${role}', 'active', '${now}', '${now}'
    ) ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      role='${role}', status='active', updated_at='${now}'`,
  )
  const users = await d1(`SELECT email FROM users WHERE id='${body.userId}'`)
  return {
    cookie: cookieHeader(cookies),
    email: users[0]?.email,
    userId: body.userId,
  }
}

function appFetch(
  path,
  { cookie, method = 'GET', headers = {}, body, redirect = 'follow' } = {},
) {
  const url = path.startsWith('http') ? path : `${APP_ORIGIN}${path}`
  const init = {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    redirect,
    dispatcher: localFetchDispatcher,
  }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body
  }
  return undiciFetch(url, init)
}

function pollWorkspaceBilling(workspaceId, expected, pollOptions = {}) {
  return pollUntil(async () => {
    const rows = await d1(
      `SELECT plan, storage_quota_bytes, stripe_subscription_status, stripe_subscription_id FROM workspaces WHERE id='${workspaceId}'`,
    )
    const row = rows[0]
    if (!row) return null
    if (expected.plan !== undefined && row.plan !== expected.plan) return null
    if (
      expected.storage_quota_bytes !== undefined &&
      row.storage_quota_bytes !== expected.storage_quota_bytes
    ) {
      return null
    }
    if (
      expected.stripe_subscription_status !== undefined &&
      row.stripe_subscription_status !== expected.stripe_subscription_status
    ) {
      return null
    }
    return row
  }, pollOptions)
}

function countSubscriptionItems(subscription) {
  return subscription.items.data.length
}

function overageDescription(month) {
  // Keep in sync with apps/web/app/services/billing-usage.server.ts (not importable from .mjs).
  return `Storage overage for ${month}`
}

async function attachDefaultPaymentMethod(stripe, customerId) {
  const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', {
    customer: customerId,
  })
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  })
  return paymentMethod.id
}

async function createSubscription(
  stripe,
  { customerId, workspaceId, priceId },
) {
  const paymentMethodId = await attachDefaultPaymentMethod(stripe, customerId)
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    metadata: { workspace_id: workspaceId },
    default_payment_method: paymentMethodId,
  })
}

function previousUtcMonth(now = new Date()) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  if (month === 0) return `${year - 1}-12`
  return `${year}-${String(month).padStart(2, '0')}`
}

function previousMonthUtcDates(count = 4) {
  const month = previousUtcMonth()
  const [yearStr, monthStr] = month.split('-')
  const year = Number(yearStr)
  const monthNum = Number(monthStr)
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const dates = []
  for (let index = 0; index < count; index += 1) {
    const day = Math.min(index + 1, daysInMonth)
    dates.push(`${month}-${String(day).padStart(2, '0')}`)
  }
  return dates
}

async function advanceTestClockTo(stripe, clockId, unixSeconds) {
  await stripe.testHelpers.testClocks.advance(clockId, {
    frozen_time: unixSeconds,
  })
  return pollUntil(
    async () => {
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
      return clock.status === 'ready' ? clock : null
    },
    { timeoutMs: TEST_CLOCK_POLL_TIMEOUT_MS, intervalMs: 1000 },
  )
}

async function seedDailyOverageUsage(workspaceId, dates, overageGbValues) {
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index]
    const overageGb = overageGbValues[index]
    await d1(
      `INSERT INTO workspace_storage_daily_usage (
        workspace_id, date, used_bytes, included_bytes, billable_overage_gb
      ) VALUES (
        '${workspaceId}', '${date}', 0, 0, ${overageGb}
      )`,
    )
  }
}

function pollOverageCharge(workspaceId, month, expected) {
  return pollUntil(async () => {
    const rows = await d1(
      `SELECT overage_gb_month, status, stripe_invoice_item_id FROM billing_overage_charges WHERE workspace_id='${workspaceId}' AND month='${month}'`,
    )
    const row = rows[0]
    if (!row) return null
    if (
      expected.overage_gb_month !== undefined &&
      row.overage_gb_month !== expected.overage_gb_month
    ) {
      return null
    }
    if (expected.status !== undefined && row.status !== expected.status) {
      return null
    }
    if (expected.has_invoice_item === true && !row.stripe_invoice_item_id) {
      return null
    }
    if (expected.has_invoice_item === false && row.stripe_invoice_item_id) {
      return null
    }
    return row
  })
}

async function countOverageCharges(workspaceId, month) {
  const rows = await d1(
    `SELECT COUNT(*) AS c FROM billing_overage_charges WHERE workspace_id='${workspaceId}' AND month='${month}'`,
  )
  return Number(rows[0]?.c ?? 0)
}

async function countPendingInvoiceItems(stripe, customerId) {
  const items = await stripe.invoiceItems.list({
    customer: customerId,
    pending: true,
    limit: 100,
  })
  return items.data.length
}

function getOverageInvoiceLinePriceId(line) {
  return (
    line.pricing?.price_details?.price ??
    (typeof line.price === 'string' ? line.price : line.price?.id) ??
    null
  )
}

function getOverageInvoiceLineUnitAmount(line) {
  const decimal = line.pricing?.unit_amount_decimal
  if (decimal != null && decimal !== '') {
    const parsed = Number(decimal)
    if (Number.isFinite(parsed)) return parsed
  }
  return line.price?.unit_amount ?? null
}

function getOverageInvoiceLineProductId(line) {
  return (
    line.pricing?.price_details?.product ??
    (typeof line.price === 'object' && line.price?.product
      ? typeof line.price.product === 'string'
        ? line.price.product
        : line.price.product?.id
      : null) ??
    null
  )
}

function findOverageInvoiceLine(invoice, targetMonth) {
  const expectedDescription = overageDescription(targetMonth)
  for (const line of invoice.lines?.data ?? []) {
    if (line.description !== expectedDescription) continue
    if (!getOverageInvoiceLinePriceId(line)) continue
    return line
  }
  return null
}

async function pollOverageInvoice(
  stripe,
  customerId,
  targetMonth,
  expectedQuantity,
  { overageProductId } = {},
) {
  const deadline = Date.now() + OVERAGE_INVOICE_POLL_TIMEOUT_MS
  let lastSeenInvoiceId = null
  let lastSeenLines = null

  while (Date.now() < deadline) {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 5,
      expand: ['data.lines.data.price'],
    })
    for (const invoice of invoices.data) {
      lastSeenInvoiceId = invoice.id
      lastSeenLines = invoice.lines?.data ?? []
      const line = findOverageInvoiceLine(invoice, targetMonth)
      if (!line) continue
      if (line.quantity !== expectedQuantity) continue
      const unitAmount = getOverageInvoiceLineUnitAmount(line)
      if (!EXPECTED_OVERAGE_UNIT_AMOUNTS.has(unitAmount)) continue
      if (
        overageProductId &&
        getOverageInvoiceLineProductId(line) !== overageProductId
      ) {
        continue
      }
      return { invoice, line }
    }
    await delay(2000)
  }

  const diagnostic = JSON.stringify({
    invoiceId: lastSeenInvoiceId,
    lines: lastSeenLines,
  })
  throw new Error(
    `pollOverageInvoice timed out after ${OVERAGE_INVOICE_POLL_TIMEOUT_MS}ms; last seen invoice lines: ${diagnostic}`,
  )
}

async function pollRenewalInvoiceWithoutOverage(
  stripe,
  customerId,
  targetMonth,
) {
  const deadline = Date.now() + OVERAGE_INVOICE_POLL_TIMEOUT_MS
  let lastSeenInvoiceId = null

  while (Date.now() < deadline) {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 5,
      expand: ['data.lines.data.price'],
    })
    for (const invoice of invoices.data) {
      if (invoice.billing_reason !== 'subscription_cycle') continue
      lastSeenInvoiceId = invoice.id
      const overageLine = findOverageInvoiceLine(invoice, targetMonth)
      if (!overageLine) return invoice
    }
    await delay(2000)
  }

  throw new Error(
    `pollRenewalInvoiceWithoutOverage timed out after ${OVERAGE_INVOICE_POLL_TIMEOUT_MS}ms; last seen renewal invoice id: ${lastSeenInvoiceId ?? 'none'}`,
  )
}

async function attachFailingPaymentMethod(stripe, customerId, subscriptionId) {
  const paymentMethod = await stripe.paymentMethods.attach(
    'pm_card_chargeCustomerFail',
    { customer: customerId },
  )
  const paymentMethodId = paymentMethod.id
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  })
  await stripe.subscriptions.update(subscriptionId, {
    default_payment_method: paymentMethodId,
  })
}

async function seedWorkspaceWithAdmin(stripe, scenarioNum, options = {}) {
  const now = nowIso()
  const workspaceId = brId(`ws${scenarioNum}`)
  const email = `billing-regression+${scenarioNum}@example.com`

  let testClockId = null
  let customer
  if (options.testClock) {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
    })
    testClockId = clock.id
    stripeResources.testClocks.add(clock.id)
    customer = await stripe.customers.create({
      email,
      test_clock: clock.id,
      metadata: {
        harness: 'billing-regression',
        scenario: String(scenarioNum),
      },
    })
  } else {
    customer = await stripe.customers.create({
      email,
      metadata: {
        harness: 'billing-regression',
        scenario: String(scenarioNum),
      },
    })
  }
  stripeResources.customers.add(customer.id)

  await d1(
    `INSERT INTO workspaces (
      id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
      storage_updated_at, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_status
    ) VALUES (
      '${workspaceId}', NULL, 'Billing regression ${scenarioNum}', '${now}',
      'free', ${QUOTA_FREE_BYTES}, 0, '${now}', '${customer.id}', NULL, 'none'
    )`,
  )
  const session = await mintSessionCookie({
    persona: 'free-owner',
    workspaceId,
    role: 'owner',
  })

  return {
    workspaceId,
    userId: session.userId,
    email: session.email,
    customerId: customer.id,
    testClockId,
    cookie: session.cookie,
  }
}

async function seedExternalContributor({
  scenarioNum,
  targetProjectId,
  targetAdminUserId,
}) {
  const now = nowIso()
  const workspaceId = brId(`ext-ws${scenarioNum}`)
  const shareDefaultId = brId(`psd${scenarioNum}`)

  await d1(
    `INSERT INTO workspaces (
      id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
      storage_updated_at, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_status
    ) VALUES (
      '${workspaceId}', NULL, 'External workspace ${scenarioNum}', '${now}',
      'free', ${QUOTA_FREE_BYTES}, 0, '${now}', NULL, NULL, 'none'
    )`,
  )
  const session = await mintSessionCookie({
    persona: 'team-member',
    workspaceId,
    role: 'member',
  })
  await d1(
    `INSERT INTO project_share_defaults (
      id, project_container_id, email, role, display_name, created_by_id,
      created_at, updated_at
    ) VALUES (
      '${shareDefaultId}', '${targetProjectId}', '${session.email}', 'contributor',
      NULL, '${targetAdminUserId}', '${now}', '${now}'
    )`,
  )

  return {
    workspaceId,
    userId: session.userId,
    email: session.email,
    cookie: session.cookie,
  }
}

async function createProject(cookie, name) {
  const response = await appFetch('/api/cli/projects', {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

async function uploadToProject(
  cookie,
  containerId,
  html = '<html><body>ok</body></html>',
) {
  const form = new FormData()
  form.append(
    'file',
    new File([html], 'billing-regression.html', { type: 'text/html' }),
  )
  form.append('visibility', 'project')
  form.append('container_id', containerId)

  const response = await appFetch('/api/shareables/uploads', {
    method: 'POST',
    cookie,
    body: form,
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

async function postBillingAction(cookie, fields) {
  const response = await appFetch('/settings/billing', {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  })
  return response
}

function extractCheckoutSessionId(location) {
  if (!location) return null
  const match = location.match(/(cs_test_[A-Za-z0-9]+)/)
  return match?.[1] ?? null
}

function pollSubscriptionItemCount(stripe, subscriptionId, expectedCount = 1) {
  return pollUntil(async () => {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    })
    const itemCount = countSubscriptionItems(subscription)
    return itemCount === expectedCount ? subscription : null
  })
}

let harnessContext = null

async function runScenario1() {
  const { stripe, vars } = harnessContext
  const seed = await seedWorkspaceWithAdmin(stripe, 1)

  await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_PLUS_MONTHLY,
  })

  const workspace = await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'plus',
    storage_quota_bytes: QUOTA_PLUS_BYTES,
    stripe_subscription_status: 'active',
  })
  assertOk(
    workspace.plan === 'plus',
    `expected workspace plan 'plus' after webhook sync, got '${workspace.plan}'`,
  )
  assertOk(
    workspace.storage_quota_bytes === QUOTA_PLUS_BYTES,
    `expected storage_quota_bytes ${QUOTA_PLUS_BYTES}, got ${workspace.storage_quota_bytes}`,
  )

  let firstProjectId = null
  for (let index = 1; index <= PLUS_PROJECT_LIMIT; index += 1) {
    const { response, body } = await createProject(
      seed.cookie,
      `Project ${index}`,
    )
    assertOk(
      response.status === 200,
      `expected project ${index} creation to return 200, got ${response.status}: ${JSON.stringify(body)}`,
    )
    assertOk(
      body?.project?.id,
      `expected project ${index} response to include project.id, got ${JSON.stringify(body)}`,
    )
    if (index === 1) firstProjectId = body.project.id
  }

  const blocked = await createProject(seed.cookie, 'Project 21')
  assertOk(
    blocked.response.status === 403,
    `expected 21st project to be rejected with 403, got ${blocked.response.status}`,
  )
  assertOk(
    blocked.body?.error?.code === 'project-limit-reached',
    `expected project-limit-reached error, got ${JSON.stringify(blocked.body)}`,
  )

  assertOk(
    firstProjectId,
    'expected first project id for external posting test',
  )

  const external = await seedExternalContributor({
    scenarioNum: 1,
    targetProjectId: firstProjectId,
    targetAdminUserId: seed.userId,
  })
  const upload = await uploadToProject(external.cookie, firstProjectId)
  assertOk(
    upload.response.status === 200,
    `expected external contributor upload to return 200 on plus plan, got ${upload.response.status}: ${JSON.stringify(upload.body)}`,
  )
  assertOk(
    upload.body?.id,
    `expected upload response to include shareable id, got ${JSON.stringify(upload.body)}`,
  )
}

async function runScenario2() {
  const { stripe, vars } = harnessContext
  const seed = await seedWorkspaceWithAdmin(stripe, 2)

  await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_PLUS_MONTHLY,
  })
  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'plus',
    storage_quota_bytes: QUOTA_PLUS_BYTES,
    stripe_subscription_status: 'active',
  })

  const changePlanResponse = await postBillingAction(seed.cookie, {
    intent: 'change-plan',
    plan: 'team',
    interval: 'monthly',
  })
  assertOk(
    changePlanResponse.status === 302,
    `expected change-plan to redirect with 302, got ${changePlanResponse.status}`,
  )

  const workspace = await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'team',
    storage_quota_bytes: QUOTA_TEAM_BYTES,
    stripe_subscription_status: 'active',
  })
  assertOk(
    workspace.stripe_subscription_id,
    'expected stripe_subscription_id on workspace after team upgrade',
  )

  const subscription = await stripe.subscriptions.retrieve(
    workspace.stripe_subscription_id,
    { expand: ['items.data.price'] },
  )
  const itemCount = countSubscriptionItems(subscription)
  assertOk(
    itemCount === 1,
    `expected exactly 1 fixed-price subscription item after plus→team change (no overage metered item), got ${itemCount}`,
  )
}

async function runScenario3() {
  const { stripe, vars } = harnessContext

  const checkoutSeed = await seedWorkspaceWithAdmin(stripe, 31)
  const checkoutResponse = await postBillingAction(checkoutSeed.cookie, {
    intent: 'checkout',
    plan: 'team',
    interval: 'monthly',
    currency: 'usd',
  })
  assertOk(
    checkoutResponse.status === 302,
    `expected team checkout to redirect with 302, got ${checkoutResponse.status}`,
  )
  const checkoutLocation = checkoutResponse.headers.get('Location')
  const checkoutSessionId = extractCheckoutSessionId(checkoutLocation)
  assertOk(
    checkoutSessionId,
    `expected checkout redirect Location to include cs_test session id, got '${checkoutLocation ?? ''}'`,
  )

  const lineItems = await stripe.checkout.sessions.listLineItems(
    checkoutSessionId,
    { limit: 10 },
  )
  assertOk(
    lineItems.data.length === 1,
    `expected team checkout session to have exactly 1 line item, got ${lineItems.data.length}`,
  )
  const lineItemPriceId = lineItems.data[0]?.price?.id
  assertOk(
    lineItemPriceId === vars.STRIPE_PRICE_TEAM_MONTHLY,
    `expected checkout line item price ${vars.STRIPE_PRICE_TEAM_MONTHLY}, got ${lineItemPriceId ?? 'none'}`,
  )

  const directSeed = await seedWorkspaceWithAdmin(stripe, 32)
  const subscription = await createSubscription(stripe, {
    customerId: directSeed.customerId,
    workspaceId: directSeed.workspaceId,
    priceId: vars.STRIPE_PRICE_TEAM_MONTHLY,
  })

  await pollWorkspaceBilling(directSeed.workspaceId, {
    plan: 'team',
    storage_quota_bytes: QUOTA_TEAM_BYTES,
    stripe_subscription_status: 'active',
  })

  await pollSubscriptionItemCount(stripe, subscription.id, 1)

  const resyncBaselineRows = await d1(
    `SELECT COUNT(*) AS c FROM billing_webhook_events WHERE event_type='customer.subscription.updated' AND processed_at IS NOT NULL`,
  )
  const resyncBaseline = Number(resyncBaselineRows[0]?.c ?? 0)

  await stripe.subscriptions.update(subscription.id, {
    metadata: {
      workspace_id: directSeed.workspaceId,
      harness_resync: String(Date.now()),
    },
  })

  await pollUntil(async () => {
    const rows = await d1(
      `SELECT COUNT(*) AS c FROM billing_webhook_events WHERE event_type='customer.subscription.updated' AND processed_at IS NOT NULL`,
    )
    const count = Number(rows[0]?.c ?? 0)
    return count > resyncBaseline ? count : null
  })

  const afterResync = await stripe.subscriptions.retrieve(subscription.id, {
    expand: ['items.data.price'],
  })
  const itemCountAfterResync = countSubscriptionItems(afterResync)
  assertOk(
    itemCountAfterResync === 1,
    `expected subscription item count to stay at 1 after re-sync (no overage metered item added), got ${itemCountAfterResync}`,
  )
}

function waitForReconcileDone(afterCount) {
  return pollUntil(() => {
    const count = harnessContext.reconcileDoneCount.value
    return count > afterCount ? count : null
  })
}

async function runScenario4OverageBilling(stripe, vars, scenarioNum) {
  const seed = await seedWorkspaceWithAdmin(stripe, scenarioNum, {
    testClock: true,
  })
  assertOk(
    seed.testClockId,
    `expected test clock id for scenario 4 (${scenarioNum})`,
  )

  const subscription = await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_TEAM_MONTHLY,
  })

  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'team',
    storage_quota_bytes: QUOTA_TEAM_BYTES,
    stripe_subscription_status: 'active',
  })

  await pollSubscriptionItemCount(stripe, subscription.id, 1)

  const targetMonth = previousUtcMonth()
  const usageDates = previousMonthUtcDates(4)
  await seedDailyOverageUsage(
    seed.workspaceId,
    usageDates,
    [12.0, 12.4, 12.8, 12.4],
  )

  let reconcileDoneBaseline = harnessContext.reconcileDoneCount.value
  await triggerScheduled()
  await waitForReconcileDone(reconcileDoneBaseline)
  await pollOverageCharge(seed.workspaceId, targetMonth, {
    overage_gb_month: 12,
    status: 'completed',
    has_invoice_item: true,
  })

  reconcileDoneBaseline = harnessContext.reconcileDoneCount.value
  await triggerScheduled()
  await waitForReconcileDone(reconcileDoneBaseline)
  const overageChargeCount = await countOverageCharges(
    seed.workspaceId,
    targetMonth,
  )
  assertOk(
    overageChargeCount === 1,
    `expected billing_overage_charges to stay at 1 row after idempotent re-run, got ${overageChargeCount}`,
  )

  const syncedSubscription = await stripe.subscriptions.retrieve(
    subscription.id,
  )
  const currentPeriodEnd =
    syncedSubscription.items?.data?.[0]?.current_period_end
  assertOk(
    typeof currentPeriodEnd === 'number' && Number.isFinite(currentPeriodEnd),
    'expected subscription items.data[0].current_period_end to be set',
  )
  const advanceTarget = currentPeriodEnd + 2 * 60 * 60
  await advanceTestClockTo(stripe, seed.testClockId, advanceTarget)

  const { line } = await pollOverageInvoice(
    stripe,
    seed.customerId,
    targetMonth,
    12,
    { overageProductId: vars.STRIPE_PRODUCT_STORAGE_OVERAGE },
  )
  assertOk(
    line.description === overageDescription(targetMonth),
    `expected overage invoice line description '${overageDescription(targetMonth)}', got '${line.description ?? ''}'`,
  )
}

async function runScenario4ZeroOverage(stripe, vars) {
  const seed = await seedWorkspaceWithAdmin(stripe, 41, { testClock: true })
  assertOk(
    seed.testClockId,
    'expected test clock id for scenario 4 zero overage',
  )

  const subscription = await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_TEAM_MONTHLY,
  })

  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'team',
    storage_quota_bytes: QUOTA_TEAM_BYTES,
    stripe_subscription_status: 'active',
  })

  await pollSubscriptionItemCount(stripe, subscription.id, 1)

  const targetMonth = previousUtcMonth()
  const usageDates = previousMonthUtcDates(4)
  await seedDailyOverageUsage(seed.workspaceId, usageDates, [0, 0, 0, 0])

  const reconcileDoneBaseline = harnessContext.reconcileDoneCount.value
  await triggerScheduled()
  await waitForReconcileDone(reconcileDoneBaseline)
  await pollOverageCharge(seed.workspaceId, targetMonth, {
    overage_gb_month: 0,
    status: 'completed',
    has_invoice_item: false,
  })

  const pendingItems = await countPendingInvoiceItems(stripe, seed.customerId)
  assertOk(
    pendingItems === 0,
    `expected zero pending invoice items after zero overage processing, got ${pendingItems}`,
  )

  const syncedSubscription = await stripe.subscriptions.retrieve(
    subscription.id,
  )
  const currentPeriodEnd =
    syncedSubscription.items?.data?.[0]?.current_period_end
  assertOk(
    typeof currentPeriodEnd === 'number' && Number.isFinite(currentPeriodEnd),
    'expected subscription items.data[0].current_period_end to be set',
  )
  const advanceTarget = currentPeriodEnd + 2 * 60 * 60
  await advanceTestClockTo(stripe, seed.testClockId, advanceTarget)

  await pollRenewalInvoiceWithoutOverage(stripe, seed.customerId, targetMonth)
}

async function runScenario4() {
  const { stripe, vars } = harnessContext
  await runScenario4OverageBilling(stripe, vars, 4)
  await runScenario4ZeroOverage(stripe, vars)
}

async function runScenario5() {
  const { stripe, vars } = harnessContext
  const seed = await seedWorkspaceWithAdmin(stripe, 5, { testClock: true })
  assertOk(seed.testClockId, 'expected test clock id for scenario 5')

  const subscription = await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_PLUS_MONTHLY,
  })

  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'plus',
    storage_quota_bytes: QUOTA_PLUS_BYTES,
    stripe_subscription_status: 'active',
  })

  await attachFailingPaymentMethod(stripe, seed.customerId, subscription.id)

  const syncedSubscription = await stripe.subscriptions.retrieve(
    subscription.id,
  )
  const currentPeriodEnd =
    syncedSubscription.items?.data?.[0]?.current_period_end
  assertOk(
    typeof currentPeriodEnd === 'number' && Number.isFinite(currentPeriodEnd),
    'expected subscription items.data[0].current_period_end to be set',
  )
  const advanceTarget = currentPeriodEnd + 60 * 60
  await advanceTestClockTo(stripe, seed.testClockId, advanceTarget)

  const workspace = await pollWorkspaceBilling(
    seed.workspaceId,
    { stripe_subscription_status: 'past_due' },
    { timeoutMs: TEST_CLOCK_POLL_TIMEOUT_MS },
  )
  assertOk(
    workspace.plan === 'plus',
    `expected workspace plan to remain 'plus' after payment failure, got '${workspace.plan}'`,
  )
}

async function runScenario6() {
  const { stripe, vars } = harnessContext
  const seed = await seedWorkspaceWithAdmin(stripe, 6)

  const subscription = await createSubscription(stripe, {
    customerId: seed.customerId,
    workspaceId: seed.workspaceId,
    priceId: vars.STRIPE_PRICE_PLUS_MONTHLY,
  })

  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'plus',
    storage_quota_bytes: QUOTA_PLUS_BYTES,
    stripe_subscription_status: 'active',
  })

  const { response: projectResponse, body: projectBody } = await createProject(
    seed.cookie,
    'Cancellation test project',
  )
  assertOk(
    projectResponse.status === 200,
    `expected project creation to return 200, got ${projectResponse.status}: ${JSON.stringify(projectBody)}`,
  )
  assertOk(
    projectBody?.project?.id,
    `expected project response to include project.id, got ${JSON.stringify(projectBody)}`,
  )
  const projectId = projectBody.project.id

  const external = await seedExternalContributor({
    scenarioNum: 6,
    targetProjectId: projectId,
    targetAdminUserId: seed.userId,
  })
  const upload = await uploadToProject(external.cookie, projectId)
  assertOk(
    upload.response.status === 200,
    `expected external contributor upload to return 200 on plus plan, got ${upload.response.status}: ${JSON.stringify(upload.body)}`,
  )
  assertOk(
    upload.body?.id,
    `expected upload response to include shareable id, got ${JSON.stringify(upload.body)}`,
  )
  const shareableId = upload.body.id

  await stripe.subscriptions.cancel(subscription.id)

  await pollWorkspaceBilling(seed.workspaceId, {
    plan: 'free',
    storage_quota_bytes: QUOTA_FREE_BYTES,
    stripe_subscription_status: 'canceled',
  })

  const viewResponse = await appFetch(`/a/${shareableId}`, {
    cookie: seed.cookie,
  })
  assertOk(
    viewResponse.status === 200,
    `expected existing shareable view to return 200 after cancellation, got ${viewResponse.status}`,
  )

  const blockedUpload = await uploadToProject(external.cookie, projectId)
  assertOk(
    blockedUpload.response.status === 400,
    `expected external contributor upload to be rejected with 400 on free plan, got ${blockedUpload.response.status}`,
  )
  assertOk(
    blockedUpload.body?.error?.code === 'invalid-container',
    `expected invalid-container error after cancellation, got ${JSON.stringify(blockedUpload.body)}`,
  )
}

const SCENARIOS = [
  { id: 1, name: 'Plus subscription', run: runScenario1 },
  { id: 2, name: 'Plus to Team plan change', run: runScenario2 },
  { id: 3, name: 'Team direct subscription', run: runScenario3 },
  { id: 4, name: 'Team overage charge billing', run: runScenario4 },
  { id: 5, name: 'Payment failure', run: runScenario5 },
  { id: 6, name: 'Cancellation', run: runScenario6 },
]

function selectScenarios(only) {
  if (only.length === 0) return SCENARIOS
  const selected = SCENARIOS.filter((scenario) => only.includes(scenario.id))
  const missing = only.filter(
    (id) => !selected.some((scenario) => scenario.id === id),
  )
  if (missing.length > 0) {
    throw new Error(`Unknown scenario number(s): ${missing.join(', ')}`)
  }
  return selected
}

async function runScenarios(scenarios) {
  const results = []
  for (const scenario of scenarios) {
    log.info(`\n--- Scenario ${scenario.id}: ${scenario.name} ---`)
    try {
      await scenario.run()
      results.push({ id: scenario.id, name: scenario.name, ok: true })
      log.info(`ok scenario ${scenario.id}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        id: scenario.id,
        name: scenario.name,
        ok: false,
        error: message,
      })
      log.error(`fail scenario ${scenario.id}: ${message}`)
    }
  }
  return results
}

function printSummary(results) {
  log.info('\n=== Billing regression summary ===')
  for (const result of results) {
    const status = result.ok ? 'ok' : 'fail'
    log.info(`${status} ${result.id}. ${result.name}`)
    if (result.error) {
      log.error(`  ${result.error}`)
    }
  }
}

async function cleanupStripeResources(stripe, resources = stripeResources) {
  let failures = 0
  for (const customerId of [...resources.customers].reverse()) {
    try {
      await stripe.customers.del(customerId)
    } catch {
      failures += 1
    }
  }
  for (const clockId of [...resources.testClocks].reverse()) {
    try {
      await stripe.testHelpers.testClocks.del(clockId)
    } catch {
      failures += 1
    }
  }
  const attempted = resources.customers.size + resources.testClocks.size
  resources.customers.clear()
  resources.testClocks.clear()
  log.info(
    `Stripe test resource cleanup: ${attempted - failures}/${attempted} removed.`,
  )
  return { attempted, failures }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    log.info(usage())
    return
  }

  await assertPrerequisites()

  const vars = await loadDevVars()
  registerSecretValues(vars)
  assertRequiredEnv(vars)
  assertTestStripeKey(vars.STRIPE_SECRET_KEY)
  await verifyWebhookSecret(vars.STRIPE_SECRET_KEY, vars.STRIPE_WEBHOOK_SECRET)

  const scenarios = selectScenarios(options.only)

  await confirmRun(options.yes)
  const persistPath = await mkdtemp(join(tmpdir(), 'artifactshare-billing-'))
  const stripe = createStripeClient(vars.STRIPE_SECRET_KEY)
  let manager = null
  let exitCode = 0

  try {
    await resetLocalDb(persistPath)
    const processes = await startProcesses(
      vars.STRIPE_SECRET_KEY,
      persistPath,
      async () => {
        await cleanupStripeResources(stripe)
        await rm(persistPath, { recursive: true, force: true })
      },
    )
    manager = processes.manager
    harnessContext = {
      stripe,
      vars,
      reconcileDoneCount: processes.reconcileDoneCount,
      persistPath,
    }
    manager.assertRunning()
    const results = await runScenarios(scenarios)
    manager.assertRunning()
    printSummary(results)
    if (results.some((result) => !result.ok)) {
      exitCode = 1
    }
  } catch (error) {
    exitCode = 1
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
  } finally {
    await manager?.stop()
    const cleanup = await cleanupStripeResources(stripe)
    if (cleanup.failures > 0) exitCode = 1
    await rm(persistPath, { recursive: true, force: true })
  }

  process.exitCode = exitCode
}

export {
  assertRequiredEnv,
  assertTestStripeKey,
  cleanupStripeResources,
  parseArgs,
  redact,
  registerSecretValues,
  selectScenarios,
  usage,
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    process.exitCode = 1
  })
}
