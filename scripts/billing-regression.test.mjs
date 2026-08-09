import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertRequiredEnv,
  assertTestStripeKey,
  cleanupStripeResources,
  parseArgs,
  redact,
  registerSecretValues,
  selectScenarios,
} from './billing-regression.mjs'
import { parseVarsFile } from './lib/vars.mjs'

test('parseArgs accepts confirmation and selected scenarios', () => {
  assert.deepEqual(parseArgs(['--yes', '--only', '1, 4,6']), {
    yes: true,
    only: [1, 4, 6],
  })
  assert.throws(() => parseArgs(['--only']), /Missing value/)
  assert.throws(() => parseArgs(['--only', '0']), /Invalid --only value/)
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/)
})

test('Stripe key safety accepts test mode and rejects every other mode', () => {
  assert.doesNotThrow(() => assertTestStripeKey('sk_test_example'))
  assert.doesNotThrow(() => assertTestStripeKey('rk_test_example'))
  assert.throws(
    () => assertTestStripeKey(['sk', 'live', 'examplevalue'].join('_')),
    /test mode/,
  )
  assert.throws(() => assertTestStripeKey('unknown'), /test mode/)
})

test('required variables fail before any process or network work', () => {
  assert.throws(() => assertRequiredEnv({}), /missing required keys/i)
  assert.doesNotThrow(() =>
    assertRequiredEnv({
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_plus',
      STRIPE_PRICE_PLUS_YEARLY: 'price_plus_yearly',
      STRIPE_PRICE_TEAM_MONTHLY: 'price_team',
      STRIPE_PRICE_TEAM_YEARLY: 'price_team_yearly',
      STRIPE_PRODUCT_STORAGE_OVERAGE: 'product_overage',
      STRIPE_PORTAL_CONFIGURATION: 'portal_configuration',
    }),
  )
})

test('redaction removes registered and recognizable secret values', () => {
  registerSecretValues({
    [['BETTER', 'AUTH_SECRET'].join('_')]: 'local-auth-secret-value',
    STRIPE_SECRET_KEY: 'sk_test_redactionfixture',
  })
  const webhookSecret = ['whsec', 'anotherfixture'].join('_')
  const output = redact(
    `local-auth-secret-value sk_test_redactionfixture ${webhookSecret}`,
  )
  assert.equal(output.includes('local-auth-secret-value'), false)
  assert.equal(output.includes('sk_test_redactionfixture'), false)
  assert.equal(output.includes(webhookSecret), false)
})

test('redaction removes Stripe resource identifiers from process logs', () => {
  assert.equal(
    redact(
      'invoice.payment_succeeded received evt_1234567890 for customer cus_abcdefghij',
    ),
    'invoice.payment_succeeded received ***stripe-id*** for customer ***stripe-id***',
  )
})

test('cleanup removes customers before clocks and reports failures', async () => {
  const calls = []
  const stripe = {
    customers: {
      del(id) {
        calls.push(`customer:${id}`)
        return Promise.resolve()
      },
    },
    testHelpers: {
      testClocks: {
        del(id) {
          calls.push(`clock:${id}`)
          if (id === 'clock-fail')
            return Promise.reject(new Error('synthetic failure'))
          return Promise.resolve()
        },
      },
    },
  }
  const resources = {
    customers: new Set(['customer-one']),
    testClocks: new Set(['clock-fail']),
  }
  assert.deepEqual(await cleanupStripeResources(stripe, resources), {
    attempted: 2,
    failures: 1,
  })
  assert.deepEqual(calls, ['customer:customer-one', 'clock:clock-fail'])
  assert.equal(resources.customers.size, 0)
  assert.equal(resources.testClocks.size, 0)
})

test('scenario selection is fail-closed', () => {
  assert.equal(selectScenarios([]).length, 6)
  assert.deepEqual(
    selectScenarios([2, 5]).map(({ id }) => id),
    [2, 5],
  )
  assert.throws(() => selectScenarios([7]), /Unknown scenario/)
})

test('vars parser supports quotes, equals signs, and inline comments', () => {
  assert.deepEqual(
    parseVarsFile("A='one two'\nB=value=with=equals\nC=value # note\n"),
    { A: 'one two', B: 'value=with=equals', C: 'value' },
  )
})
