#!/usr/bin/env node
// Temporary protected operation. Remove this script, its workflow modes, and
// the protected target secret after the full migration and the later scope
// enforcement waiting window have completed. The OAuth refresh contract tests
// may remain.
//
// The D1 REST query contract documents the parameterized batch body and
// per-statement meta.changes, but does not establish the Workers binding's
// rollback guarantee for this transport. Recovery therefore relies on exact
// conditional updates, a primary-database post-check, and a fresh idempotent
// plan/apply run. Never subtract scopes after an incomplete run.
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const PRODUCT_SCOPE = 'artifactshare:access'
const TARGET_SCHEMA_VERSION = 1

function objectWithExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
  )
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseTargets(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('TARGETS_INVALID: target secret must be valid JSON.')
  }
  if (!objectWithExactKeys(parsed, ['schemaVersion', 'targets']))
    throw new Error('TARGETS_INVALID: target secret fields are invalid.')
  if (parsed.schemaVersion !== TARGET_SCHEMA_VERSION)
    throw new Error('TARGETS_INVALID: target schema version is unsupported.')
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0)
    throw new Error('TARGETS_INVALID: targets must be a nonempty array.')

  const seen = new Set()
  const targets = parsed.targets.map((target) => {
    if (!objectWithExactKeys(target, ['clientId', 'userId']))
      throw new Error('TARGETS_INVALID: target pair fields are invalid.')
    if (!nonemptyString(target.clientId) || !nonemptyString(target.userId))
      throw new Error('TARGETS_INVALID: target identifiers must be nonempty.')
    const pair = `${target.clientId}\u0000${target.userId}`
    if (seen.has(pair))
      throw new Error('TARGETS_INVALID: target pairs must be unique.')
    seen.add(pair)
    return { clientId: target.clientId, userId: target.userId }
  })
  return targets.sort(
    (left, right) =>
      left.clientId.localeCompare(right.clientId) ||
      left.userId.localeCompare(right.userId),
  )
}

export function parseStoredScopes(value) {
  if (typeof value !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const seen = new Set()
  for (const scope of parsed) {
    if (typeof scope !== 'string' || scope.length === 0 || seen.has(scope))
      return null
    seen.add(scope)
  }
  return parsed
}

function expandedScopes(value) {
  const scopes = parseStoredScopes(value)
  if (!scopes) return null
  return scopes.includes(PRODUCT_SCOPE)
    ? { next: value, scopes }
    : { next: JSON.stringify([...scopes, PRODUCT_SCOPE]), scopes }
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function digestPlan(plan) {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex')
}

function utcTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`${label} must be an exact UTC ISO timestamp.`)
  return value
}

function rowString(row, key) {
  return typeof row?.[key] === 'string' ? row[key] : ''
}

function sortRows(rows) {
  return [...rows].sort(
    (left, right) =>
      rowString(left, 'clientId').localeCompare(rowString(right, 'clientId')) ||
      rowString(left, 'userId').localeCompare(rowString(right, 'userId')) ||
      rowString(left, 'id').localeCompare(rowString(right, 'id')),
  )
}

function scopeRow(row, kind) {
  const parsed = expandedScopes(row.scopes)
  return {
    kind,
    id: row.id,
    clientId: row.clientId,
    ...(kind === 'consent' || kind === 'refreshToken'
      ? { userId: row.userId }
      : {}),
    oldScopes: row.scopes,
    nextScopes: parsed?.next ?? null,
    malformed: parsed === null,
    needsUpdate: parsed !== null && parsed.next !== row.scopes,
  }
}

function validRowIdentity(row, fields) {
  return fields.every((field) => nonemptyString(row?.[field]))
}

function refreshState(row, cutoffMs) {
  if (row.revoked !== null) return 'revoked'
  if (row.expiresAt === null) return 'null-expiry'
  if (typeof row.expiresAt !== 'string') return 'invalid-expiry'
  const expiresAt = Date.parse(row.expiresAt)
  if (Number.isNaN(expiresAt)) return 'invalid-expiry'
  return expiresAt > cutoffMs ? 'active' : 'expired'
}

function planCounts(plan) {
  const allScopeRows = [
    ...plan.clients,
    ...plan.consents,
    ...plan.refreshTokens,
    ...plan.ineligibleRefreshTokens.revoked,
    ...plan.ineligibleRefreshTokens.expired,
    ...plan.anomalies,
  ]
  const shared = plan.sharedImpact.filter(
    (impact) =>
      impact.externalConsentCount > 0 ||
      impact.externalActiveRefreshTokenCount > 0,
  )
  return {
    targets: plan.targets.length,
    clients: plan.clients.length,
    clientRowsNeedingUpdate: plan.clients.filter((row) => row.needsUpdate)
      .length,
    consentRows: plan.consents.length,
    consentRowsNeedingUpdate: plan.consents.filter((row) => row.needsUpdate)
      .length,
    activeRefreshTokens: plan.refreshTokens.length,
    activeRefreshTokensNeedingUpdate: plan.refreshTokens.filter(
      (row) => row.needsUpdate,
    ).length,
    revokedRefreshTokens: plan.ineligibleRefreshTokens.revoked.length,
    expiredRefreshTokens: plan.ineligibleRefreshTokens.expired.length,
    nullExpiryAnomalies: plan.anomalies.filter(
      (row) => row.reason === 'null-expiry',
    ).length,
    invalidExpiryAnomalies: plan.anomalies.filter(
      (row) => row.reason === 'invalid-expiry',
    ).length,
    missingClients: plan.missingClients.length,
    missingConsents: plan.missingConsents.length,
    ambiguousClients: plan.ambiguousClients.length,
    malformedScopes: allScopeRows.filter((row) => row.malformed).length,
    nullClientScopes: plan.clients.filter((row) => row.oldScopes === null)
      .length,
    sharedClients: shared.length,
    sharedConsentRows: shared.reduce(
      (total, impact) => total + impact.externalConsentCount,
      0,
    ),
    sharedActiveRefreshTokens: shared.reduce(
      (total, impact) => total + impact.externalActiveRefreshTokenCount,
      0,
    ),
  }
}

function blockerCount(counts) {
  return (
    counts.missingClients +
    counts.missingConsents +
    counts.ambiguousClients +
    counts.malformedScopes +
    counts.nullClientScopes +
    counts.nullExpiryAnomalies +
    counts.invalidExpiryAnomalies
  )
}

export function createPlan({ targets, planningCutoff, snapshot }) {
  utcTimestamp(planningCutoff, 'Planning cutoff')
  const cutoffMs = Date.parse(planningCutoff)
  const clientIds = [...new Set(targets.map(({ clientId }) => clientId))].sort()
  const clientsByClientId = new Map()
  for (const row of snapshot.clients ?? []) {
    if (!validRowIdentity(row, ['id', 'clientId'])) continue
    const existing = clientsByClientId.get(row.clientId) ?? []
    existing.push(row)
    clientsByClientId.set(row.clientId, existing)
  }

  const missingClients = clientIds.filter(
    (clientId) => (clientsByClientId.get(clientId) ?? []).length === 0,
  )
  const ambiguousClients = clientIds.filter(
    (clientId) => (clientsByClientId.get(clientId) ?? []).length > 1,
  )
  const clients = sortRows(
    clientIds.flatMap((clientId) => clientsByClientId.get(clientId) ?? []),
  ).map((row) => scopeRow(row, 'client'))

  const selectedPairs = new Set(
    targets.map(({ clientId, userId }) => `${clientId}\u0000${userId}`),
  )
  const consents = sortRows(snapshot.consents ?? [])
    .filter(
      (row) =>
        validRowIdentity(row, ['id', 'clientId', 'userId']) &&
        selectedPairs.has(`${row.clientId}\u0000${row.userId}`),
    )
    .map((row) => scopeRow(row, 'consent'))
  const consentPairs = new Set(
    consents.map((row) => `${row.clientId}\u0000${row.userId}`),
  )
  const missingConsents = targets.filter(
    ({ clientId, userId }) => !consentPairs.has(`${clientId}\u0000${userId}`),
  )

  const activeRefreshTokens = []
  const anomalies = []
  const revoked = []
  const expired = []
  for (const row of sortRows(snapshot.refreshTokens ?? [])) {
    if (
      !validRowIdentity(row, ['id', 'clientId', 'userId']) ||
      !selectedPairs.has(`${row.clientId}\u0000${row.userId}`)
    )
      continue
    const state = refreshState(row, cutoffMs)
    const plannedRow = {
      ...scopeRow(row, 'refreshToken'),
      expiresAt: row.expiresAt,
      revoked: row.revoked,
    }
    if (state === 'revoked') revoked.push(plannedRow)
    else if (state === 'expired') expired.push(plannedRow)
    else if (state === 'active') activeRefreshTokens.push(plannedRow)
    else anomalies.push({ ...plannedRow, reason: state })
  }

  const impactByClient = new Map(
    (snapshot.sharedImpact ?? []).map((impact) => [impact.clientId, impact]),
  )
  const sharedImpact = clientIds.map((clientId) => {
    const impact = impactByClient.get(clientId) ?? {}
    return {
      clientId,
      externalConsentCount: Number(impact.externalConsentCount ?? 0),
      externalActiveRefreshTokenCount: Number(
        impact.externalActiveRefreshTokenCount ?? 0,
      ),
    }
  })

  return {
    schemaVersion: 1,
    productScope: PRODUCT_SCOPE,
    planningCutoff,
    targets,
    clients,
    consents,
    refreshTokens: activeRefreshTokens,
    anomalies,
    missingClients,
    missingConsents,
    ambiguousClients,
    ineligibleRefreshTokens: { expired, revoked },
    sharedImpact,
  }
}

export async function planMigration({ repository, targets, planningCutoff }) {
  const snapshot = await repository.readSnapshot(targets, planningCutoff)
  const plan = createPlan({ targets, planningCutoff, snapshot })
  const counts = planCounts(plan)
  return {
    internalPlan: plan,
    summary: {
      schemaVersion: 1,
      mode: 'plan',
      status: blockerCount(counts) === 0 ? 'ready' : 'blocked',
      planningCutoff,
      planDigest: digestPlan(plan),
      counts,
    },
  }
}

function sameImpact(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function hasProductScope(value) {
  return parseStoredScopes(value)?.includes(PRODUCT_SCOPE) === true
}

function activeRefreshMap(snapshot, cutoff) {
  const cutoffMs = Date.parse(cutoff)
  return new Map(
    (snapshot.refreshTokens ?? [])
      .filter((row) => refreshState(row, cutoffMs) === 'active')
      .map((row) => [row.id, row]),
  )
}

function currentRowMap(rows) {
  return new Map((rows ?? []).map((row) => [row.id, row]))
}

function baseApplyCounts(planCountsValue) {
  return {
    ...planCountsValue,
    mutationsAttempted: 0,
    mutationsChanged: 0,
    conditionalUpdateConflicts: 0,
    rowsBecameIneligible: 0,
    newlyActiveRefreshTokens: 0,
    eligibleRowsMissingProductScope: 0,
    sharedClientImpactChanges: 0,
    digestMismatches: 0,
    transportFailures: 0,
    verificationUnavailable: 0,
  }
}

function incompleteSummary({ planningCutoff, digest, counts }) {
  return {
    schemaVersion: 1,
    mode: 'apply',
    status: 'incomplete',
    planningCutoff,
    planDigest: digest,
    counts,
  }
}

export async function applyMigration({
  repository,
  targets,
  planningCutoff,
  expectedDigest,
  allowSharedClientImpact = false,
  now = () => new Date().toISOString(),
}) {
  utcTimestamp(planningCutoff, 'Planning cutoff')
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest))
    throw new Error('EXPECTED_DIGEST_INVALID: expected digest must be SHA-256.')

  const reconstructed = await planMigration({
    repository,
    targets,
    planningCutoff,
  })
  const plan = reconstructed.internalPlan
  const actualDigest = reconstructed.summary.planDigest
  const counts = baseApplyCounts(reconstructed.summary.counts)
  if (actualDigest !== expectedDigest) {
    counts.digestMismatches = 1
    return incompleteSummary({ planningCutoff, digest: actualDigest, counts })
  }
  if (blockerCount(counts) > 0)
    return incompleteSummary({ planningCutoff, digest: actualDigest, counts })
  if (counts.sharedClients > 0 && !allowSharedClientImpact)
    return incompleteSummary({ planningCutoff, digest: actualDigest, counts })

  const applyTimestamp = utcTimestamp(now(), 'Apply timestamp')
  if (Date.parse(applyTimestamp) < Date.parse(planningCutoff))
    throw new Error('APPLY_TIME_INVALID: apply timestamp precedes the cutoff.')
  const before = await repository.readSnapshot(targets, applyTimestamp)
  const beforePlan = createPlan({
    targets,
    planningCutoff: applyTimestamp,
    snapshot: before,
  })
  if (!sameImpact(plan.sharedImpact, beforePlan.sharedImpact))
    counts.sharedClientImpactChanges = 1

  const plannedActiveIds = new Set(plan.refreshTokens.map((row) => row.id))
  const currentActive = activeRefreshMap(before, applyTimestamp)
  counts.newlyActiveRefreshTokens = [...currentActive.keys()].filter(
    (id) => !plannedActiveIds.has(id),
  ).length

  const clientRows = currentRowMap(before.clients)
  const consentRows = currentRowMap(before.consents)
  const mutations = []
  for (const row of plan.clients.filter((item) => item.needsUpdate)) {
    const current = clientRows.get(row.id)
    if (!current || current.scopes !== row.oldScopes) {
      counts.conditionalUpdateConflicts += 1
      continue
    }
    mutations.push(row)
  }
  for (const row of plan.consents.filter((item) => item.needsUpdate)) {
    const current = consentRows.get(row.id)
    if (!current || current.scopes !== row.oldScopes) {
      counts.conditionalUpdateConflicts += 1
      continue
    }
    mutations.push(row)
  }
  for (const row of plan.refreshTokens.filter((item) => item.needsUpdate)) {
    const current = currentActive.get(row.id)
    if (!current) {
      counts.rowsBecameIneligible += 1
      continue
    }
    if (current.scopes !== row.oldScopes) {
      counts.conditionalUpdateConflicts += 1
      continue
    }
    mutations.push(row)
  }

  const unsafePreflight =
    blockerCount(planCounts(beforePlan)) > 0 ||
    counts.sharedClientImpactChanges > 0
  if (!unsafePreflight && mutations.length > 0) {
    counts.mutationsAttempted = mutations.length
    try {
      const changes = await repository.applyMutations(mutations, applyTimestamp)
      for (const changed of changes) {
        if (changed === 1) counts.mutationsChanged += 1
        else counts.conditionalUpdateConflicts += 1
      }
      if (changes.length !== mutations.length)
        counts.conditionalUpdateConflicts += Math.abs(
          mutations.length - changes.length,
        )
    } catch {
      // The REST contract does not establish rollback semantics for this batch.
      // Verification below is therefore authoritative for recovery.
      counts.transportFailures = 1
    }
  }

  let after
  const verificationTimestamp = utcTimestamp(now(), 'Verification timestamp')
  if (Date.parse(verificationTimestamp) < Date.parse(applyTimestamp))
    throw new Error(
      'VERIFICATION_TIME_INVALID: verification timestamp precedes apply.',
    )
  try {
    after = await repository.readSnapshot(targets, applyTimestamp)
  } catch {
    counts.verificationUnavailable = 1
    return {
      ...incompleteSummary({
        planningCutoff,
        digest: actualDigest,
        counts,
      }),
      applyTimestamp,
      verificationTimestamp,
    }
  }

  const afterPlan = createPlan({
    targets,
    planningCutoff: applyTimestamp,
    snapshot: after,
  })
  const afterCounts = planCounts(afterPlan)
  const afterActive = activeRefreshMap(after, applyTimestamp)
  counts.rowsBecameIneligible = [...plannedActiveIds].filter(
    (id) => !afterActive.has(id),
  ).length
  counts.newlyActiveRefreshTokens = [...afterActive.keys()].filter(
    (id) => !plannedActiveIds.has(id),
  ).length
  counts.eligibleRowsMissingProductScope = [
    ...(after.clients ?? []),
    ...(after.consents ?? []),
    ...afterActive.values(),
  ].filter((row) => !hasProductScope(row.scopes)).length
  if (!sameImpact(plan.sharedImpact, afterPlan.sharedImpact))
    counts.sharedClientImpactChanges = 1

  for (const key of [
    'missingClients',
    'missingConsents',
    'ambiguousClients',
    'malformedScopes',
    'nullClientScopes',
    'nullExpiryAnomalies',
    'invalidExpiryAnomalies',
  ]) {
    counts[key] = afterCounts[key]
  }

  const incomplete =
    blockerCount(counts) > 0 ||
    counts.conditionalUpdateConflicts > 0 ||
    counts.rowsBecameIneligible > 0 ||
    counts.newlyActiveRefreshTokens > 0 ||
    counts.eligibleRowsMissingProductScope > 0 ||
    counts.sharedClientImpactChanges > 0 ||
    counts.transportFailures > 0 ||
    counts.verificationUnavailable > 0
  return {
    schemaVersion: 1,
    mode: 'apply',
    status: incomplete ? 'incomplete' : 'complete',
    planningCutoff,
    applyTimestamp,
    verificationTimestamp,
    planDigest: actualDigest,
    counts,
  }
}

const targetsCte = `WITH targets(userId, clientId) AS (
  SELECT json_extract(value, '$.userId'), json_extract(value, '$.clientId')
  FROM json_each(?)
)`

function readStatements(targets, cutoff) {
  const targetJson = JSON.stringify(targets)
  return [
    {
      sql: `${targetsCte}
        SELECT c.id, c.clientId, c.scopes
        FROM oauthClient c
        JOIN (SELECT DISTINCT clientId FROM targets) t ON t.clientId = c.clientId
        ORDER BY c.clientId, c.id`,
      params: [targetJson],
    },
    {
      sql: `${targetsCte}
        SELECT c.id, c.clientId, c.userId, c.scopes
        FROM oauthConsent c
        JOIN targets t ON t.clientId = c.clientId AND t.userId = c.userId
        ORDER BY c.clientId, c.userId, c.id`,
      params: [targetJson],
    },
    {
      sql: `${targetsCte}
        SELECT r.id, r.clientId, r.userId, r.scopes, r.expiresAt, r.revoked
        FROM oauthRefreshToken r
        JOIN targets t ON t.clientId = r.clientId AND t.userId = r.userId
        ORDER BY r.clientId, r.userId, r.id`,
      params: [targetJson],
    },
    {
      sql: `${targetsCte}, selectedClients(clientId) AS (
          SELECT DISTINCT clientId FROM targets
        )
        SELECT s.clientId,
          (SELECT count(*) FROM oauthConsent c
           WHERE c.clientId = s.clientId
             AND NOT EXISTS (
               SELECT 1 FROM targets t
               WHERE t.clientId = c.clientId AND t.userId = c.userId
             )) AS externalConsentCount,
          (SELECT count(*) FROM oauthRefreshToken r
           WHERE r.clientId = s.clientId
             AND r.revoked IS NULL
             AND r.expiresAt IS NOT NULL
             AND r.expiresAt > ?
             AND NOT EXISTS (
               SELECT 1 FROM targets t
               WHERE t.clientId = r.clientId AND t.userId = r.userId
             )) AS externalActiveRefreshTokenCount
        FROM selectedClients s
        ORDER BY s.clientId`,
      params: [targetJson, cutoff],
    },
  ]
}

function mutationStatement(row, applyTimestamp) {
  if (row.kind === 'client')
    return {
      sql: `UPDATE oauthClient SET scopes = ?
        WHERE id = ? AND clientId = ? AND scopes = ?`,
      params: [row.nextScopes, row.id, row.clientId, row.oldScopes],
    }
  if (row.kind === 'consent')
    return {
      sql: `UPDATE oauthConsent SET scopes = ?
        WHERE id = ? AND clientId = ? AND userId = ? AND scopes = ?`,
      params: [row.nextScopes, row.id, row.clientId, row.userId, row.oldScopes],
    }
  return {
    sql: `UPDATE oauthRefreshToken SET scopes = ?
      WHERE id = ? AND clientId = ? AND userId = ? AND scopes = ?
        AND revoked IS NULL AND expiresAt IS NOT NULL AND expiresAt > ?`,
    params: [
      row.nextScopes,
      row.id,
      row.clientId,
      row.userId,
      row.oldScopes,
      applyTimestamp,
    ],
  }
}

export function createD1RestAdapter({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = fetch,
}) {
  if (![accountId, databaseId, apiToken].every(nonemptyString))
    throw new Error('D1_CONFIG_INVALID: protected D1 configuration is missing.')
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
  return {
    async execute(statements) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ batch: statements }),
      })
      if (!response.ok)
        throw new Error('D1_REQUEST_FAILED: D1 request was not successful.')
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('D1_RESPONSE_INVALID: D1 returned invalid JSON.')
      }
      if (
        payload?.success !== true ||
        !Array.isArray(payload.result) ||
        payload.result.length !== statements.length ||
        payload.result.some(
          (result) =>
            result?.success !== true ||
            result?.meta?.served_by_primary !== true,
        )
      )
        throw new Error('D1_RESPONSE_INVALID: D1 primary result is incomplete.')
      return payload.result.map((result) => ({
        rows: Array.isArray(result.results) ? result.results : [],
        changes: Number(result.meta.changes ?? 0),
      }))
    },
  }
}

export function createD1MigrationRepository(adapter) {
  return {
    async readSnapshot(targets, cutoff) {
      const results = await adapter.execute(readStatements(targets, cutoff))
      return {
        clients: results[0].rows,
        consents: results[1].rows,
        refreshTokens: results[2].rows,
        sharedImpact: results[3].rows.map((row) => ({
          clientId: row.clientId,
          externalConsentCount: Number(row.externalConsentCount),
          externalActiveRefreshTokenCount: Number(
            row.externalActiveRefreshTokenCount,
          ),
        })),
      }
    },
    async applyMutations(mutations, applyTimestamp) {
      const results = await adapter.execute(
        mutations.map((row) => mutationStatement(row, applyTimestamp)),
      )
      return results.map((result) => result.changes)
    },
  }
}

function writeGithubResult(summary) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `result=${summary.status}`,
        `planning_cutoff=${summary.planningCutoff}`,
        `plan_digest=${summary.planDigest}`,
      ].join('\n') + '\n',
    )
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### OAuth scope migration ${summary.mode}`,
      '',
      `- Result: \`${summary.status}\``,
      `- Planning cutoff: \`${summary.planningCutoff}\``,
      `- Plan digest: \`${summary.planDigest}\``,
    ]
    if (summary.applyTimestamp)
      lines.push(`- Apply timestamp: \`${summary.applyTimestamp}\``)
    if (summary.verificationTimestamp)
      lines.push(
        `- Verification timestamp: \`${summary.verificationTimestamp}\``,
      )
    lines.push('', '#### Aggregate counts', '')
    for (const [key, value] of Object.entries(summary.counts))
      lines.push(`- ${key}: ${value}`)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
}

export async function runCli({ env = process.env, now } = {}) {
  const mode = env.OAUTH_SCOPE_MIGRATION_MODE
  if (!['plan', 'apply'].includes(mode))
    throw new Error('MODE_INVALID: migration mode must be plan or apply.')
  const targets = parseTargets(env.OAUTH_SCOPE_MIGRATION_TARGETS ?? '')
  const adapter = createD1RestAdapter({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.CLOUDFLARE_D1_DATABASE_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  })
  const repository = createD1MigrationRepository(adapter)
  let summary
  if (mode === 'plan') {
    const planningCutoff = utcTimestamp(
      now?.() ?? new Date().toISOString(),
      'Planning cutoff',
    )
    summary = (await planMigration({ repository, targets, planningCutoff }))
      .summary
  } else {
    summary = await applyMigration({
      repository,
      targets,
      planningCutoff: env.OAUTH_SCOPE_MIGRATION_PLANNING_CUTOFF ?? '',
      expectedDigest: env.OAUTH_SCOPE_MIGRATION_EXPECTED_DIGEST ?? '',
      allowSharedClientImpact:
        env.OAUTH_SCOPE_MIGRATION_ALLOW_SHARED_CLIENT_IMPACT === 'true',
      ...(now ? { now } : {}),
    })
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  writeGithubResult(summary)
  return summary.status === 'ready' || summary.status === 'complete' ? 0 : 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runCli()
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z0-9_]+:/u.test(error.message)
        ? error.message.split(':', 1)[0]
        : 'MIGRATION_FAILED'
    process.stderr.write(`${code}: migration stopped safely.\n`)
    process.exitCode = 1
  }
}
