import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'

/**
 * The statement the guard named, without the wording that explains it: the
 * contract is which statement in which migration the gate refuses, not the
 * sentence the author reads.
 */
type Finding = { file: string; statement: string }

const unsafe: Record<string, string> = {
  '9999_bad_foreign_keys.sql': 'PRAGMA foreign_keys = OFF;',
  '9998_qualified_setter.sql': 'PRAGMA main.foreign_keys(NO);',
  '9997_quoted_setter.sql': 'PRAGMA "foreign_keys" = OFF;',
  '9996_explained_setter.sql': 'EXPLAIN PRAGMA foreign_keys = OFF;',
  '0015_not_legacy.sql': 'PRAGMA main.foreign_keys = 0;',
  '9995_bad_rebuild.sql': `
    PRAGMA foreign_keys = OFF;
    ALTER TABLE shareables RENAME TO shareables_old;
    CREATE TABLE shareables (id TEXT PRIMARY KEY);
    INSERT INTO shareables SELECT id FROM shareables_old;
    DROP TABLE shareables_old;
    DROP TABLE shareables;
  `,
  '9994_bad_delete.sql': 'DELETE FROM versions WHERE shareable_id IS NOT NULL;',
  '9993_compact.sql': `
    REPLACE INTO shareables (id) VALUES ('s1');
    ALTER TABLE scratch_shareables RENAME TO shareables;
    DROP TABLE"versions";
  `,
  '9992_string_comment.sql':
    "UPDATE notes SET body = 'literal -- marker'; DROP TABLE versions;",
  '9991_quoted_identifier.sql':
    'ALTER TABLE notes ADD COLUMN "o\'brien" TEXT; DROP TABLE versions;',
  '9990_drop_column.sql': 'ALTER TABLE shareables DROP project_id;',
  // Allowlists are per migration: this one may drop protected tables, not replace rows.
  '0017_drive_folder_rebase.sql': "REPLACE INTO shareables (id) VALUES ('s1');",
  '0014_shareables_managed_columns_not_null.sql':
    'ALTER TABLE scratch_shareables RENAME TO shareables;',
}

const expectedFindings: Finding[] = [
  {
    file: '9999_bad_foreign_keys.sql',
    statement: 'PRAGMA foreign_keys setters',
  },
  {
    file: '9998_qualified_setter.sql',
    statement: 'PRAGMA foreign_keys setters',
  },
  { file: '9997_quoted_setter.sql', statement: 'PRAGMA foreign_keys setters' },
  {
    file: '9996_explained_setter.sql',
    statement: 'PRAGMA foreign_keys setters',
  },
  { file: '0015_not_legacy.sql', statement: 'PRAGMA foreign_keys setters' },
  { file: '9995_bad_rebuild.sql', statement: 'PRAGMA foreign_keys setters' },
  { file: '9995_bad_rebuild.sql', statement: 'DROP TABLE shareables_old' },
  { file: '9995_bad_rebuild.sql', statement: 'DROP TABLE shareables' },
  { file: '9995_bad_rebuild.sql', statement: 'ALTER TABLE RENAME shareables' },
  { file: '9994_bad_delete.sql', statement: 'DELETE FROM versions' },
  { file: '9993_compact.sql', statement: 'DROP TABLE versions' },
  { file: '9993_compact.sql', statement: 'REPLACE INTO shareables' },
  { file: '9993_compact.sql', statement: 'ALTER TABLE RENAME TO shareables' },
  { file: '9992_string_comment.sql', statement: 'DROP TABLE versions' },
  { file: '9991_quoted_identifier.sql', statement: 'DROP TABLE versions' },
  {
    file: '9990_drop_column.sql',
    statement: 'ALTER TABLE DROP COLUMN shareables',
  },
  {
    file: '0017_drive_folder_rebase.sql',
    statement: 'REPLACE INTO shareables',
  },
  {
    file: '0014_shareables_managed_columns_not_null.sql',
    statement: 'ALTER TABLE RENAME TO shareables',
  },
]

const safe: Record<string, string> = {
  '9999_pragma_text.sql': `
    -- PRAGMA foreign_keys = OFF;
    INSERT INTO notes (body) VALUES ('PRAGMA foreign_keys = OFF;');
  `,
  '0014_shareables_managed_columns_not_null.sql': `
    PRAGMA main.foreign_keys = 0;
    ALTER TABLE shareables_new RENAME TO shareables;
  `,
  '0030_drop_legacy_shareable_container_columns.sql':
    'DROP TABLE shareable_container_cleanup_assertions;',
  '0061_drop_legacy_membership_tables.sql': `
    DROP TABLE IF EXISTS shareable_delete_events;
    DROP TABLE IF EXISTS workspace_contributors;
    DROP TABLE IF EXISTS workspace_admins;
  `,
  '0020_wipe_shareables_for_dns_safe_ids.sql': 'DELETE FROM versions;',
}

const order = (findings: Finding[]) =>
  [...findings].sort((one, other) =>
    `${one.file}|${one.statement}`.localeCompare(
      `${other.file}|${other.statement}`,
    ),
  )

test('the migration guard refuses unsafe statements and names each one', () => {
  const result = runMigrationCheck(unsafe)
  expect(result.ok).toBe(false)
  expect(order(result.findings)).toEqual(order(expectedFindings))
})

test('the migration guard accepts allowlisted and inert SQL', () => {
  expect(runMigrationCheck(safe)).toEqual({ ok: true, findings: [] })
})

function runMigrationCheck(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'artifactshare-migrations-'))
  try {
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(dir, name), sql)
    }
    execFileSync(process.execPath, ['check-migrations.mjs', dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, findings: [] as Finding[] }
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String(error.stderr)
        : String(error)
    return { ok: false, findings: parseFindings(stderr) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function parseFindings(stderr: string): Finding[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const [file, ...rest] = line.slice(2).split(': ')
      return {
        file: file!,
        statement: rest.join(': ').replace(/ (?:is|are) .*$/u, ''),
      }
    })
}
