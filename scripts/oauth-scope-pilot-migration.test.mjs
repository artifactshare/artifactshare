import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  PRODUCT_SCOPE,
  applyMigration,
  createD1MigrationRepository,
  createD1RestAdapter,
  digestPlan,
  parseStoredScopes,
  parseTargets,
  planMigration,
} from './oauth-scope-pilot-migration.mjs'

const cutoff = '2026-09-18T00:00:00.000Z'
const applyTime = '2026-09-18T01:00:00.000Z'
const verifyTime = '2026-09-18T01:00:01.000Z'
const legacy = JSON.stringify(['openid', 'profile', 'offline_access'])
const migrated = JSON.stringify([
  'openid',
  'profile',
  'offline_access',
  PRODUCT_SCOPE,
])
const targets = [{ clientId: 'client-synthetic', userId: 'user-synthetic' }]

function baseState() {
  return {
    clients: [
      {
        id: 'client-row-synthetic',
        clientId: 'client-synthetic',
        scopes: legacy,
      },
    ],
    consents: [
      {
        id: 'consent-row-synthetic',
        clientId: 'client-synthetic',
        userId: 'user-synthetic',
        scopes: legacy,
      },
    ],
    refreshTokens: [
      {
        id: 'refresh-row-active',
        clientId: 'client-synthetic',
        userId: 'user-synthetic',
        scopes: legacy,
        expiresAt: '2026-10-18T00:00:00.000Z',
        revoked: null,
      },
    ],
  }
}

function clone(value) {
  return structuredClone(value)
}

class MemoryRepository {
  constructor(state = baseState()) {
    this.state = clone(state)
    this.reads = 0
    this.writes = 0
    this.conflictIds = new Set()
    this.onRead = undefined
    this.afterMutate = undefined
  }

  readSnapshot(selectedTargets, operationCutoff) {
    this.reads += 1
    this.onRead?.(this, this.reads)
    const pairs = new Set(
      selectedTargets.map(
        ({ clientId, userId }) => `${clientId}\u0000${userId}`,
      ),
    )
    const clientIds = new Set(selectedTargets.map(({ clientId }) => clientId))
    const activeOutside = this.state.refreshTokens.filter(
      (row) =>
        clientIds.has(row.clientId) &&
        !pairs.has(`${row.clientId}\u0000${row.userId}`) &&
        row.revoked === null &&
        row.expiresAt !== null &&
        row.expiresAt > operationCutoff,
    )
    return clone({
      clients: this.state.clients.filter((row) => clientIds.has(row.clientId)),
      consents: this.state.consents.filter((row) =>
        pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
      refreshTokens: this.state.refreshTokens.filter((row) =>
        pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
      sharedImpact: [...clientIds].map((clientId) => ({
        clientId,
        externalConsentCount: this.state.consents.filter(
          (row) =>
            row.clientId === clientId &&
            !pairs.has(`${row.clientId}\u0000${row.userId}`),
        ).length,
        externalActiveRefreshTokenCount: activeOutside.filter(
          (row) => row.clientId === clientId,
        ).length,
      })),
    })
  }

  applyMutations(mutations, operationTime) {
    const changes = mutations.map((mutation) => {
      if (this.conflictIds.has(mutation.id)) return 0
      const collection =
        mutation.kind === 'client'
          ? this.state.clients
          : mutation.kind === 'consent'
            ? this.state.consents
            : this.state.refreshTokens
      const row = collection.find((candidate) => candidate.id === mutation.id)
      if (!row || row.scopes !== mutation.oldScopes) return 0
      if (
        mutation.kind === 'refreshToken' &&
        (row.revoked !== null ||
          row.expiresAt === null ||
          row.expiresAt <= operationTime)
      )
        return 0
      row.scopes = mutation.nextScopes
      this.writes += 1
      return 1
    })
    this.afterMutate?.(this)
    return changes
  }
}

function clock(...values) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

function fixedPlan(repository) {
  return planMigration({ repository, targets, planningCutoff: cutoff })
}

test('target input is strict, unique, and canonicalized', () => {
  assert.deepEqual(
    parseTargets(
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          { userId: 'user-z', clientId: 'client-z' },
          { userId: 'user-a', clientId: 'client-a' },
        ],
      }),
    ),
    [
      { clientId: 'client-a', userId: 'user-a' },
      { clientId: 'client-z', userId: 'user-z' },
    ],
  )
  assert.throws(
    () =>
      parseTargets(
        JSON.stringify({
          schemaVersion: 1,
          targets: [targets[0], targets[0]],
        }),
      ),
    /TARGETS_INVALID/u,
  )
  assert.throws(
    () =>
      parseTargets(
        JSON.stringify({
          schemaVersion: 1,
          targets,
          unexpected: true,
        }),
      ),
    /TARGETS_INVALID/u,
  )
})

test('scope parsing preserves order and rejects malformed encodings', () => {
  assert.deepEqual(parseStoredScopes(legacy), [
    'openid',
    'profile',
    'offline_access',
  ])
  for (const value of ['not-json', '{}', '["openid","openid"]', '[""]'])
    assert.equal(parseStoredScopes(value), null)
})

test('planning selects active rows and reports revoked, expired, and null expiry safely', async () => {
  const state = baseState()
  state.refreshTokens.push(
    {
      ...state.refreshTokens[0],
      id: 'refresh-row-revoked',
      revoked: cutoff,
    },
    {
      ...state.refreshTokens[0],
      id: 'refresh-row-expired',
      expiresAt: cutoff,
    },
    {
      ...state.refreshTokens[0],
      id: 'refresh-row-null-expiry',
      expiresAt: null,
    },
    {
      ...state.refreshTokens[0],
      id: 'refresh-row-unselected',
      userId: 'user-unselected',
    },
  )
  const result = await fixedPlan(new MemoryRepository(state))

  assert.equal(result.summary.status, 'blocked')
  assert.equal(result.summary.counts.activeRefreshTokens, 1)
  assert.equal(result.summary.counts.revokedRefreshTokens, 1)
  assert.equal(result.summary.counts.expiredRefreshTokens, 1)
  assert.equal(result.summary.counts.nullExpiryAnomalies, 1)
  assert.deepEqual(result.internalPlan.refreshTokens[0].nextScopes, migrated)
})

test('missing consent, null client scope, and malformed mutable scopes block planning', async () => {
  const state = baseState()
  state.consents = []
  state.clients[0].scopes = null
  state.refreshTokens[0].scopes = '{bad-json'
  state.refreshTokens.push({
    ...state.refreshTokens[0],
    id: 'refresh-row-revoked-malformed',
    revoked: cutoff,
  })
  const result = await fixedPlan(new MemoryRepository(state))

  assert.equal(result.summary.status, 'blocked')
  assert.equal(result.summary.counts.missingConsents, 1)
  assert.equal(result.summary.counts.nullClientScopes, 1)
  assert.equal(result.summary.counts.malformedScopes, 3)
})

test('a missing client or consent blocks apply without inserting rows', async () => {
  for (const missing of ['client', 'consent']) {
    const state = baseState()
    if (missing === 'client') state.clients = []
    else state.consents = []
    const repository = new MemoryRepository(state)
    const planned = await fixedPlan(repository)
    const result = await applyMigration({
      repository,
      targets,
      planningCutoff: cutoff,
      expectedDigest: planned.summary.planDigest,
    })

    assert.equal(result.status, 'incomplete')
    assert.equal(repository.writes, 0)
    assert.equal(repository.state.clients.length, state.clients.length)
    assert.equal(repository.state.consents.length, state.consents.length)
  }
})

test('apply appends once, preserves order, and a fresh second run writes nothing', async () => {
  const repository = new MemoryRepository()
  const planned = await fixedPlan(repository)
  const first = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })

  assert.equal(first.status, 'complete')
  assert.equal(first.counts.mutationsChanged, 3)
  assert.equal(repository.state.clients[0].scopes, migrated)
  assert.equal(repository.state.consents[0].scopes, migrated)
  assert.equal(repository.state.refreshTokens[0].scopes, migrated)

  const nextPlan = await fixedPlan(repository)
  const second = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: nextPlan.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(second.status, 'complete')
  assert.equal(second.counts.mutationsAttempted, 0)
  assert.equal(repository.writes, 3)
})

test('shared client impact refuses writes unless the digest-bound override is explicit', async () => {
  const state = baseState()
  state.consents.push({
    id: 'consent-row-other-user',
    clientId: 'client-synthetic',
    userId: 'user-other',
    scopes: legacy,
  })
  const repository = new MemoryRepository(state)
  const planned = await fixedPlan(repository)
  assert.equal(planned.summary.counts.sharedClients, 1)

  const refused = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
  })
  assert.equal(refused.status, 'incomplete')
  assert.equal(repository.writes, 0)

  const approved = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    allowSharedClientImpact: true,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(approved.status, 'complete')
})

test('digest drift fails before writes', async () => {
  const repository = new MemoryRepository()
  const planned = await fixedPlan(repository)
  repository.state.consents[0].scopes = JSON.stringify(['openid'])

  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
  })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.counts.digestMismatches, 1)
  assert.equal(repository.writes, 0)
})

test('optimistic conflicts are incomplete and post-verification observes the legacy row', async () => {
  const repository = new MemoryRepository()
  const planned = await fixedPlan(repository)
  repository.conflictIds.add('consent-row-synthetic')

  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.counts.conditionalUpdateConflicts, 1)
  assert.equal(result.counts.eligibleRowsMissingProductScope, 1)
})

for (const transition of ['revoked', 'expired']) {
  test(`a planned token becoming ${transition} before apply is omitted and requires a fresh plan`, async () => {
    const repository = new MemoryRepository()
    const planned = await fixedPlan(repository)
    repository.onRead = (current, reads) => {
      if (reads !== 3) return
      if (transition === 'revoked')
        current.state.refreshTokens[0].revoked = applyTime
      else current.state.refreshTokens[0].expiresAt = applyTime
    }

    const result = await applyMigration({
      repository,
      targets,
      planningCutoff: cutoff,
      expectedDigest: planned.summary.planDigest,
      now: clock(applyTime, verifyTime),
    })
    assert.equal(result.status, 'incomplete')
    assert.equal(result.counts.rowsBecameIneligible, 1)
    assert.equal(result.counts.mutationsAttempted, 2)
    assert.equal(repository.state.refreshTokens[0].scopes, legacy)
  })
}

test('a concurrently appearing active token is detected after conditional updates', async () => {
  const repository = new MemoryRepository()
  const planned = await fixedPlan(repository)
  repository.afterMutate = (current) => {
    current.state.refreshTokens.push({
      ...current.state.refreshTokens[0],
      id: 'refresh-row-concurrent',
      scopes: legacy,
    })
  }

  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.counts.newlyActiveRefreshTokens, 1)
  assert.equal(result.counts.eligibleRowsMissingProductScope, 1)
})

test('safe summaries omit target identifiers and exact stored scope values', async () => {
  const result = await fixedPlan(new MemoryRepository())
  const serialized = JSON.stringify(result.summary)
  assert.doesNotMatch(serialized, /client-synthetic|user-synthetic/u)
  assert.doesNotMatch(serialized, /offline_access|artifactshare:access/u)
  assert.match(result.summary.planDigest, /^[0-9a-f]{64}$/u)
  assert.equal(result.summary.planDigest, digestPlan(result.internalPlan))
})

test('D1 REST adapter sends parameterized batches and reads per-query changes', async () => {
  let request
  const adapter = createD1RestAdapter({
    accountId: 'account-synthetic',
    databaseId: 'database-synthetic',
    apiToken: 'token-synthetic',
    fetchImpl: (url, init) => {
      request = { url, init }
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: [{ value: 1 }],
              meta: { changes: 1, served_by_primary: true },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const statements = [{ sql: 'SELECT ? AS value', params: ['1'] }]
  const result = await adapter.execute(statements)

  assert.equal(request.init.method, 'POST')
  assert.match(request.url, /\/accounts\/account-synthetic\/d1\/database\//u)
  assert.deepEqual(JSON.parse(request.init.body), { batch: statements })
  assert.equal(request.init.headers.authorization, 'Bearer token-synthetic')
  assert.deepEqual(result, [{ rows: [{ value: 1 }], changes: 1 }])
})

test('D1 REST adapter refuses results not confirmed as primary', async () => {
  const adapter = createD1RestAdapter({
    accountId: 'account-synthetic',
    databaseId: 'database-synthetic',
    apiToken: 'token-synthetic',
    fetchImpl: () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: [],
              meta: { changes: 0, served_by_primary: false },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  await assert.rejects(
    adapter.execute([{ sql: 'SELECT 1', params: [] }]),
    /D1_RESPONSE_INVALID/u,
  )
})

test('D1 repository SQL plans and conditionally updates only intended tables', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE oauthClient (id TEXT PRIMARY KEY, clientId TEXT, scopes TEXT);
    CREATE TABLE oauthConsent (
      id TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT
    );
    CREATE TABLE oauthRefreshToken (
      id TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT,
      expiresAt TEXT, revoked TEXT
    );
    CREATE TABLE oauthAccessToken (
      id TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT
    );
  `)
  sqlite
    .prepare('INSERT INTO oauthClient VALUES (?, ?, ?)')
    .run('client-row-synthetic', 'client-synthetic', legacy)
  sqlite
    .prepare('INSERT INTO oauthConsent VALUES (?, ?, ?, ?)')
    .run('consent-row-synthetic', 'client-synthetic', 'user-synthetic', legacy)
  sqlite
    .prepare('INSERT INTO oauthRefreshToken VALUES (?, ?, ?, ?, ?, NULL)')
    .run(
      'refresh-row-active',
      'client-synthetic',
      'user-synthetic',
      legacy,
      '2026-10-18T00:00:00.000Z',
    )
  sqlite
    .prepare('INSERT INTO oauthAccessToken VALUES (?, ?, ?, ?)')
    .run('access-row-untouched', 'client-synthetic', 'user-synthetic', legacy)
  const repository = createD1MigrationRepository({
    execute(statements) {
      return statements.map(({ sql, params }) => {
        const statement = sqlite.prepare(sql)
        if (/^\s*UPDATE/u.test(sql)) {
          const result = statement.run(...params)
          return { rows: [], changes: Number(result.changes) }
        }
        return { rows: statement.all(...params), changes: 0 }
      })
    },
  })

  const planned = await planMigration({
    repository,
    targets,
    planningCutoff: cutoff,
  })
  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })

  assert.equal(result.status, 'complete')
  assert.equal(
    sqlite.prepare('SELECT scopes FROM oauthClient').get().scopes,
    migrated,
  )
  assert.equal(
    sqlite.prepare('SELECT scopes FROM oauthConsent').get().scopes,
    migrated,
  )
  assert.equal(
    sqlite.prepare('SELECT scopes FROM oauthRefreshToken').get().scopes,
    migrated,
  )
  assert.equal(
    sqlite.prepare('SELECT scopes FROM oauthAccessToken').get().scopes,
    legacy,
  )
  sqlite.close()
})
