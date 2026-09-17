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

  readSnapshot(selectedTargets) {
    this.reads += 1
    this.onRead?.(this, this.reads)
    const pairs = new Set(
      selectedTargets.map(
        ({ clientId, userId }) => `${clientId}\u0000${userId}`,
      ),
    )
    const clientIds = new Set(selectedTargets.map(({ clientId }) => clientId))
    return clone({
      clients: this.state.clients.filter((row) => clientIds.has(row.clientId)),
      consents: this.state.consents.filter((row) =>
        pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
      refreshTokens: this.state.refreshTokens.filter((row) =>
        pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
      externalConsents: this.state.consents.filter(
        (row) =>
          clientIds.has(row.clientId) &&
          !pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
      externalRefreshTokens: this.state.refreshTokens.filter(
        (row) =>
          clientIds.has(row.clientId) &&
          !pairs.has(`${row.clientId}\u0000${row.userId}`),
      ),
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
  assert.equal(result.summary.counts.malformedScopes, 2)
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
    assert.equal(result.counts.mutationsAttempted, 0)
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
  // Exercise actual SQL selection, including offsets whose lexical ordering
  // disagrees with their instant, and external anomalous expiry values.
  const insertExternal = sqlite.prepare(
    'INSERT INTO oauthRefreshToken VALUES (?, ?, ?, ?, ?, NULL)',
  )
  for (const [id, expiry] of [
    ['external-offset', '2026-09-17T23:30:00-02:00'],
    ['external-noncanonical', '2026-09-18 00:30:00Z'],
    ['external-null', null],
    ['external-invalid', 'invalid'],
  ])
    insertExternal.run(id, 'client-synthetic', 'external-user', legacy, expiry)
  const externalPlan = await fixedPlan(repository)
  assert.equal(externalPlan.summary.status, 'blocked')
  assert.equal(externalPlan.summary.counts.sharedActiveRefreshTokens, 2)
  assert.equal(externalPlan.summary.counts.externalNullExpiryAnomalies, 1)
  assert.equal(externalPlan.summary.counts.externalInvalidExpiryAnomalies, 1)
  sqlite
    .prepare(
      "DELETE FROM oauthRefreshToken WHERE id IN ('external-null', 'external-invalid')",
    )
    .run()
  const approvedPlan = await fixedPlan(repository)
  const approved = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: approvedPlan.summary.planDigest,
    allowSharedClientImpact: true,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(approved.status, 'complete')
  assert.equal(approved.counts.sharedClientImpactChanges, 0)
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) AS total FROM oauthRefreshToken WHERE userId = 'external-user' AND scopes = ?",
      )
      .get(legacy).total,
    2,
  )
  sqlite.close()
})

for (const collection of ['clients', 'consents', 'refreshTokens']) {
  for (const changedScopes of [
    JSON.stringify([PRODUCT_SCOPE]),
    JSON.stringify([PRODUCT_SCOPE, 'offline_access', 'profile', 'openid']),
    `[ "openid", "profile", "offline_access", "${PRODUCT_SCOPE}" ]`,
  ]) {
    test(`preflight checks exact scopes of already migrated ${collection}: ${changedScopes}`, async () => {
      const repository = new MemoryRepository()
      repository.state[collection][0].scopes = migrated
      const planned = await fixedPlan(repository)
      repository.onRead = (current, reads) => {
        if (reads === 3) current.state[collection][0].scopes = changedScopes
      }
      const result = await applyMigration({
        repository,
        targets,
        planningCutoff: cutoff,
        expectedDigest: planned.summary.planDigest,
        now: clock(applyTime, verifyTime),
      })
      assert.equal(result.status, 'incomplete')
      assert.equal(result.counts.preflightRowDrift, 1)
      assert.equal(repository.writes, 0)
    })
  }
  test(`post-check requires exact nextScopes for ${collection}`, async () => {
    const repository = new MemoryRepository()
    const planned = await fixedPlan(repository)
    repository.afterMutate = (current) => {
      current.state[collection][0].scopes = JSON.stringify([PRODUCT_SCOPE])
    }
    const result = await applyMigration({
      repository,
      targets,
      planningCutoff: cutoff,
      expectedDigest: planned.summary.planDigest,
      now: clock(applyTime, verifyTime),
    })
    assert.equal(result.status, 'incomplete')
    assert.equal(result.counts.postApplyRowDrift, 1)
    assert.equal(result.counts.eligibleRowsMissingProductScope, 0)
  })
}

for (const phase of ['preflight', 'postApply']) {
  for (const collection of ['clients', 'consents', 'refreshTokens']) {
    for (const change of ['added', 'removed']) {
      test(`${phase} detects ${change} selected ${collection} even with product scope`, async () => {
        const repository = new MemoryRepository()
        repository.state[collection].push({
          ...repository.state[collection][0],
          id: 'row-extra',
        })
        // Multiple clients are blocked by the separate ambiguity check.
        if (collection === 'clients') repository.state.clients.pop()
        const planned = await fixedPlan(repository)
        repository.onRead = (current, reads) => {
          if (reads !== (phase === 'preflight' ? 3 : 4)) return
          if (change === 'removed') current.state[collection].pop()
          else
            current.state[collection].push({
              ...current.state[collection][0],
              id: 'row-added',
              scopes: migrated,
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
        assert.equal(result.counts[`${phase}RowDrift`], 1)
        if (phase === 'preflight') assert.equal(repository.writes, 0)
      })
    }
  }
}

test('preflight drift diagnostics survive unavailable verification', async () => {
  const repository = new MemoryRepository()
  repository.state.refreshTokens[0].scopes = migrated
  const planned = await fixedPlan(repository)
  repository.onRead = (current, reads) => {
    if (reads === 3) {
      current.state.refreshTokens[0].revoked = applyTime
      current.state.refreshTokens.push({
        ...baseState().refreshTokens[0],
        id: 'new-active',
      })
    }
    if (reads === 4) throw new Error('synthetic read failure')
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
  assert.equal(result.counts.newlyActiveRefreshTokens, 1)
  assert.equal(result.counts.preflightRowDrift, 2)
  assert.equal(result.counts.verificationUnavailable, 1)
})

function withExternalToken(expiresAt) {
  const state = baseState()
  state.refreshTokens.push({
    ...state.refreshTokens[0],
    id: 'external-token',
    userId: 'external-user',
    expiresAt,
  })
  return state
}

for (const expiresAt of ['2026-09-17T23:30:00-02:00', '2026-09-18 00:30:00Z']) {
  test(`external tokens use instant classification and original cutoff: ${expiresAt}`, async () => {
    const repository = new MemoryRepository(withExternalToken(expiresAt))
    const planned = await fixedPlan(repository)
    assert.equal(planned.summary.counts.sharedActiveRefreshTokens, 1)
    const refused = await applyMigration({
      repository,
      targets,
      planningCutoff: cutoff,
      expectedDigest: planned.summary.planDigest,
      now: clock(applyTime, verifyTime),
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
    assert.equal(approved.counts.sharedClientImpactChanges, 0)
    assert.equal(repository.state.refreshTokens[1].scopes, legacy)
    assert.doesNotMatch(
      JSON.stringify(approved),
      /external-token|external-user|offline_access|artifactshare:access/u,
    )
  })
}

for (const expiresAt of [null, 'invalid']) {
  test(`external ${expiresAt} expiry blocks even with impact override`, async () => {
    const repository = new MemoryRepository(withExternalToken(expiresAt))
    const planned = await fixedPlan(repository)
    assert.equal(planned.summary.status, 'blocked')
    assert.equal(
      planned.summary.counts[
        expiresAt === null
          ? 'externalNullExpiryAnomalies'
          : 'externalInvalidExpiryAnomalies'
      ],
      1,
    )
    const result = await applyMigration({
      repository,
      targets,
      planningCutoff: cutoff,
      expectedDigest: planned.summary.planDigest,
      allowSharedClientImpact: true,
      now: clock(applyTime, verifyTime),
    })
    assert.equal(result.status, 'incomplete')
    assert.equal(repository.writes, 0)
  })
}

for (const phase of [3, 4]) {
  for (const change of ['addition', 'revocation', 'expiry', 'replacement']) {
    test(`external ${change} is detected at read ${phase}`, async () => {
      const repository = new MemoryRepository(
        withExternalToken('2026-10-18T00:00:00.000Z'),
      )
      const planned = await fixedPlan(repository)
      repository.onRead = (current, reads) => {
        if (reads !== phase) return
        const row = current.state.refreshTokens[1]
        if (change === 'addition')
          current.state.refreshTokens.push({ ...row, id: 'external-added' })
        if (change === 'revocation') row.revoked = applyTime
        if (change === 'expiry') row.expiresAt = cutoff
        if (change === 'replacement') row.id = 'external-replacement'
      }
      const result = await applyMigration({
        repository,
        targets,
        planningCutoff: cutoff,
        expectedDigest: planned.summary.planDigest,
        allowSharedClientImpact: true,
        now: clock(applyTime, verifyTime),
      })
      assert.equal(result.status, 'incomplete')
      assert.equal(result.counts.sharedClientImpactChanges, 1)
      if (phase === 3) assert.equal(repository.writes, 0)
    })
  }
}

test('invalid operation timestamps have a stable diagnostic code', async () => {
  const repository = new MemoryRepository()
  const planned = await fixedPlan(repository)
  for (const [planningCutoff, times] of [
    ['invalid', [applyTime, verifyTime]],
    [cutoff, ['invalid', verifyTime]],
    [cutoff, [applyTime, 'invalid']],
  ]) {
    await assert.rejects(
      applyMigration({
        repository: new MemoryRepository(),
        targets,
        planningCutoff,
        expectedDigest: planned.summary.planDigest,
        now: clock(...times),
      }),
      /^Error: TIMESTAMP_INVALID:/u,
    )
  }
})

test('successful migration preserves revoked, expired, and unselected rows exactly', async () => {
  const state = baseState()
  const token = state.refreshTokens[0]
  state.refreshTokens.push(
    { ...token, id: 'revoked-preserved', revoked: cutoff },
    { ...token, id: 'expired-preserved', expiresAt: cutoff },
    { ...token, id: 'unselected-preserved', clientId: 'unselected-client' },
  )
  state.clients.push({
    ...state.clients[0],
    id: 'unselected-client-row',
    clientId: 'unselected-client',
  })
  state.consents.push({
    ...state.consents[0],
    id: 'unselected-consent',
    clientId: 'unselected-client',
  })
  const repository = new MemoryRepository(state)
  const planned = await fixedPlan(repository)
  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(result.status, 'complete')
  for (const collection of ['clients', 'consents', 'refreshTokens']) {
    assert.deepEqual(
      repository.state[collection].slice(1),
      state[collection].slice(1),
    )
  }
})

test('null selected expiry prevents every mutation and preserves all rows', async () => {
  const state = baseState()
  state.refreshTokens[0].expiresAt = null
  const repository = new MemoryRepository(state)
  const planned = await fixedPlan(repository)
  const result = await applyMigration({
    repository,
    targets,
    planningCutoff: cutoff,
    expectedDigest: planned.summary.planDigest,
    now: clock(applyTime, verifyTime),
  })
  assert.equal(result.status, 'incomplete')
  assert.equal(repository.writes, 0)
  assert.deepEqual(repository.state, state)
})
