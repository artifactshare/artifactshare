import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const migrationsDir = fileURLToPath(new URL('./db/migrations', import.meta.url))
const scriptPath = fileURLToPath(import.meta.url)

const protectedTables = new Set([
  'accounts',
  'artifact_containers',
  'comment_threads',
  'project_share_defaults',
  'project_grants',
  'projects',
  'sessions',
  'security_audit_records',
  'shareable_grants',
  'shareables',
  'slack_workspaces',
  'users',
  'versions',
  'workspaces',
])

const allowedProtectedDrops = new Map([
  ['0014_shareables_managed_columns_not_null.sql', ['shareables']],
  ['0017_drive_folder_rebase.sql', ['shareables', 'versions']],
  [
    '0019_in_app_storage.sql',
    [
      'accounts',
      'sessions',
      'shareable_grants',
      'shareables',
      'slack_workspaces',
      'users',
      'versions',
      'workspaces',
    ],
  ],
  [
    '0030_drop_legacy_shareable_container_columns.sql',
    ['project_grants', 'projects'],
  ],
  ['0045_project_share_default_roles.sql', ['project_share_defaults']],
])

const allowedProtectedDeletes = new Map([
  [
    '0020_wipe_shareables_for_dns_safe_ids.sql',
    ['shareable_grants', 'shareables', 'versions'],
  ],
])
const allowedProtectedRenameSources = new Map()
const allowedProtectedRenameDestinations = new Map([
  [
    '0014_shareables_managed_columns_not_null.sql',
    ['shareables_new->shareables'],
  ],
  [
    '0017_drive_folder_rebase.sql',
    ['shareables_new->shareables', 'versions_new->versions'],
  ],
  [
    '0045_project_share_default_roles.sql',
    ['project_share_defaults_new->project_share_defaults'],
  ],
])
const allowedProtectedDropColumns = new Map([
  ['0022_workspace_plan_storage.sql', ['users']],
  ['0030_drop_legacy_shareable_container_columns.sql', ['shareables']],
  ['0036_drop_project_slug.sql', ['artifact_containers']],
])
const allowedLegacyForeignKeySetter = new Set([
  '0001_initial.sql',
  '0008_relax_views_artifact_id.sql',
  '0014_shareables_managed_columns_not_null.sql',
  '0017_drive_folder_rebase.sql',
  '0019_in_app_storage.sql',
])

const allowedLegacyDrops = new Map([
  ['0078_slack_webhook_channels.sql', ['container_slack_channels']],
  [
    '0057_billing_meter_sends_gb_unit.sql',
    ['_billing_meter_sends_guard', 'billing_meter_sends'],
  ],
  ['0058_billing_overage_charges.sql', ['billing_meter_sends']],
  ['0008_relax_views_artifact_id.sql', ['views']],
  ['0009_drop_views_artifact_id.sql', ['views']],
  ['0010_drop_artifacts.sql', ['artifacts']],
  ['0066_drop_access_requests.sql', ['access_requests']],
  [
    '0019_in_app_storage.sql',
    [
      '_migration_0019_guard',
      'sandbox_token_uses',
      'slack_user_links',
      'verifications',
      'version_files',
      'views',
      'views_anon',
    ],
  ],
  [
    '0029_artifact_containers.sql',
    [
      'artifact_container_migration_assertions',
      'shareable_grant_origins',
      'shareable_project_grant_exclusions',
    ],
  ],
  [
    '0030_drop_legacy_shareable_container_columns.sql',
    ['shareable_container_cleanup_assertions'],
  ],
  [
    '0033_drop_shareable_grant_origins_and_exclusions.sql',
    ['shareable_grant_origins', 'shareable_project_share_default_exclusions'],
  ],
  // Table rebuild to widen the source CHECK; rows are copied before the drop.
  ['0042_access_request_source_cli.sql', ['access_requests']],
  ['0054_view_count_recency.sql', ['views', 'views_anon']],
  [
    '0061_drop_legacy_membership_tables.sql',
    ['shareable_delete_events', 'workspace_contributors', 'workspace_admins'],
  ],
  ['0062_remove_upload_suspension.sql', ['workspace_members_legacy']],
  ['0063_workspace_owner_role.sql', ['workspace_members_legacy']],
  // Dependency-ordered rebuild to relax the agent-preset CHECK; both tables
  // are copied to temp tables first, and guard tables assert row counts and
  // child-row linkage survived.
  [
    '0082_relax_agent_authority_project_check.sql',
    [
      'cli_family_authorities',
      'cli_family_authorities_tmp',
      'cli_session_authorities',
      'cli_session_authorities_tmp',
      '_migration_0082_guard',
    ],
  ],
  // Reserved-domain assertion guard table; created and dropped within the
  // migration itself.
  ['0084_bot_users.sql', ['_migration_0084_guard']],
  [
    '0087_slack_notification_expiry.sql',
    [
      'container_slack_channels',
      'container_slack_channels_tmp',
      '_migration_0087_guard',
    ],
  ],
])

const identifierPattern =
  '(?:"([^"]+)"|`([^`]+)`|\\[([^\\]]+)\\]|([a-zA-Z_][\\w$]*))'
const qualifiedIdentifierPrefix = `(?:(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[a-zA-Z_][\\w$]*)\\s*\\.\\s*)?`
const qualifiedTablePattern = `${qualifiedIdentifierPrefix}${identifierPattern}`
const dropTablePattern = new RegExp(
  `\\bdrop\\s+table\\b\\s*(?:if\\s+exists\\s+)?${qualifiedTablePattern}`,
  'gi',
)
const deleteFromPattern = new RegExp(
  `\\bdelete\\s+from\\b\\s*${qualifiedTablePattern}`,
  'gi',
)
const replaceIntoPattern = new RegExp(
  `\\b(?:insert\\s+or\\s+replace|replace)\\s+into\\b\\s*${qualifiedTablePattern}`,
  'gi',
)
const dropColumnPattern = new RegExp(
  `\\balter\\s+table\\b\\s*${qualifiedTablePattern}\\s+drop\\s+(?:column\\b\\s*)?`,
  'gi',
)
const renameTablePattern = new RegExp(
  `\\balter\\s+table\\b\\s*${qualifiedTablePattern}\\s+rename\\s+to\\b\\s*${qualifiedTablePattern}`,
  'gi',
)
const foreignKeysSetterPattern =
  /(?:^|;)\s*(?:explain(?:\s+query\s+plan)?\s+)?pragma\s+(?:(?:[a-zA-Z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*\.\s*)?(?:foreign_keys|"foreign_keys"|`foreign_keys`|\[foreign_keys\])\s*(?:=|\()/im
if (process.argv[1] === scriptPath) {
  const problems = checkMigrationFiles(process.argv[2] ?? migrationsDir)
  if (problems.length > 0) {
    console.error('Unsafe migration SQL detected:')
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  }
}

export function checkMigrationFiles(dir = migrationsDir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((name) =>
      checkMigrationSql(name, readFileSync(join(dir, name), 'utf8')),
    )
}

export function checkMigrationSql(name, rawSql) {
  const sql = stripSqlComments(rawSql)
  const problems = []

  if (
    foreignKeysSetterPattern.test(sql) &&
    !allowedLegacyForeignKeySetter.has(name)
  ) {
    problems.push(
      `${name}: PRAGMA foreign_keys setters are not supported in D1 migrations; use a D1-safe table rebuild`,
    )
  }

  for (const match of sql.matchAll(dropTablePattern)) {
    checkStatement(problems, name, 'DROP TABLE', capturedTable(match), {
      allowLegacyDrops: true,
      protectedAllowlist: allowedProtectedDrops,
    })
  }
  for (const match of sql.matchAll(deleteFromPattern)) {
    checkStatement(problems, name, 'DELETE FROM', capturedTable(match), {
      allowLegacyDrops: false,
      protectedAllowlist: allowedProtectedDeletes,
    })
  }
  for (const match of sql.matchAll(replaceIntoPattern)) {
    checkStatement(problems, name, 'REPLACE INTO', capturedTable(match), {
      allowLegacyDrops: false,
      protectedAllowlist: new Map(),
    })
  }
  for (const match of sql.matchAll(dropColumnPattern)) {
    checkStatement(
      problems,
      name,
      'ALTER TABLE DROP COLUMN',
      capturedTable(match),
      {
        allowLegacyDrops: false,
        protectedAllowlist: allowedProtectedDropColumns,
      },
    )
  }
  for (const match of sql.matchAll(renameTablePattern)) {
    const sourceTable = capturedTable(match)
    const destinationTable = capturedTable(match, 4)
    checkStatement(problems, name, 'ALTER TABLE RENAME', sourceTable, {
      allowLegacyDrops: false,
      protectedAllowlist: allowedProtectedRenameSources,
    })
    if (
      protectedTables.has(destinationTable) &&
      !isRenameDestinationAllowed(name, sourceTable, destinationTable)
    ) {
      problems.push(
        `${name}: ALTER TABLE RENAME TO ${destinationTable} is blocked because the table is protected`,
      )
    }
  }

  return problems
}

function checkStatement(
  problems,
  migrationName,
  operation,
  tableName,
  options,
) {
  if (protectedTables.has(tableName)) {
    if (
      isAllowed(
        migrationName,
        tableName,
        options.protectedAllowlist ?? allowedProtectedDrops,
      )
    ) {
      return
    }
    problems.push(
      `${migrationName}: ${operation} ${tableName} is blocked because the table is protected`,
    )
    return
  }
  if (
    operation === 'DROP TABLE' &&
    options.allowLegacyDrops &&
    isAllowed(migrationName, tableName, allowedLegacyDrops)
  ) {
    return
  }
  if (operation === 'DROP TABLE') {
    problems.push(
      `${migrationName}: DROP TABLE ${tableName} is not in the explicit migration allowlist`,
    )
  }
}

function capturedTable(match, offset = 0) {
  return (
    match[1 + offset] ??
    match[2 + offset] ??
    match[3 + offset] ??
    match[4 + offset]
  ).toLowerCase()
}

function isAllowed(migrationName, tableName, allowlist) {
  return allowlist.get(migrationName)?.includes(tableName) ?? false
}

function isRenameDestinationAllowed(
  migrationName,
  sourceTable,
  destinationTable,
) {
  return (
    allowedProtectedRenameDestinations
      .get(migrationName)
      ?.includes(`${sourceTable}->${destinationTable}`) ?? false
  )
}

function stripSqlComments(sql) {
  let stripped = ''
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index]
    const next = sql[index + 1]

    if (current === '"') {
      stripped += current
      index += 1
      while (index < sql.length) {
        stripped += sql[index]
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 1
            stripped += sql[index]
            index += 1
            continue
          }
          break
        }
        index += 1
      }
      continue
    }

    if (current === '`') {
      stripped += current
      index += 1
      while (index < sql.length) {
        stripped += sql[index]
        if (sql[index] === '`') break
        index += 1
      }
      continue
    }

    if (current === '[') {
      stripped += current
      index += 1
      while (index < sql.length) {
        stripped += sql[index]
        if (sql[index] === ']') break
        index += 1
      }
      continue
    }

    if (current === "'") {
      stripped += ' '
      index += 1
      while (index < sql.length) {
        if (sql[index] === '\n') stripped += '\n'
        else stripped += ' '
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2
            stripped += ' '
            continue
          }
          break
        }
        index += 1
      }
      continue
    }

    if (current === '-' && next === '-') {
      stripped += '  '
      index += 2
      while (index < sql.length && sql[index] !== '\n') {
        stripped += ' '
        index += 1
      }
      if (sql[index] === '\n') stripped += '\n'
      continue
    }

    if (current === '/' && next === '*') {
      stripped += '  '
      index += 2
      while (index < sql.length) {
        if (sql[index] === '\n') stripped += '\n'
        else stripped += ' '
        if (sql[index] === '*' && sql[index + 1] === '/') {
          stripped += ' '
          index += 1
          break
        }
        index += 1
      }
      continue
    }

    stripped += current
  }
  return stripped
}
