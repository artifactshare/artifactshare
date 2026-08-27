import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'

describe('migration SQL guard', () => {
  test('blocks disabling foreign keys in new migrations', () => {
    const result = runMigrationCheck({
      '9999_bad_foreign_keys.sql': 'PRAGMA foreign_keys = OFF;',
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_bad_foreign_keys.sql: PRAGMA foreign_keys setters are not supported in D1 migrations; use a D1-safe table rebuild\n',
    })
  })

  test.each([
    'PRAGMA foreign_keys = ON;',
    'PRAGMA main.foreign_keys(NO);',
    'PRAGMA "foreign_keys" = OFF;',
    'EXPLAIN PRAGMA foreign_keys = OFF;',
  ])('blocks foreign-key setter syntax: %s', (sql) => {
    expect(runMigrationCheck({ '9999_bad_foreign_keys.sql': sql })).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_bad_foreign_keys.sql: PRAGMA foreign_keys setters are not supported in D1 migrations; use a D1-safe table rebuild\n',
    })
  })

  test('ignores PRAGMA-like text inside comments and string literals', () => {
    expect(
      runMigrationCheck({
        '9999_pragma_text.sql': `
          -- PRAGMA foreign_keys = OFF;
          INSERT INTO notes (body) VALUES ('PRAGMA foreign_keys = OFF;');
        `,
      }),
    ).toEqual({ ok: true, stderr: '' })
  })

  test('keeps the explicit legacy foreign-key exceptions narrow', () => {
    expect(
      runMigrationCheck({
        '0014_shareables_managed_columns_not_null.sql':
          'PRAGMA main.foreign_keys = 0;',
      }),
    ).toEqual({ ok: true, stderr: '' })

    expect(
      runMigrationCheck({
        '0015_not_legacy.sql': 'PRAGMA main.foreign_keys = 0;',
      }),
    ).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 0015_not_legacy.sql: PRAGMA foreign_keys setters are not supported in D1 migrations; use a D1-safe table rebuild\n',
    })
  })

  test('blocks protected parent table drops even when foreign keys are disabled', () => {
    const result = runMigrationCheck({
      '9999_bad_rebuild.sql': `
        PRAGMA foreign_keys = OFF;
        ALTER TABLE shareables RENAME TO shareables_old;
        CREATE TABLE shareables (id TEXT PRIMARY KEY);
        INSERT INTO shareables SELECT id FROM shareables_old;
        DROP TABLE shareables_old;
        DROP TABLE shareables;
      `,
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_bad_rebuild.sql: PRAGMA foreign_keys setters are not supported in D1 migrations; use a D1-safe table rebuild\n' +
        '- 9999_bad_rebuild.sql: DROP TABLE shareables_old is not in the explicit migration allowlist\n' +
        '- 9999_bad_rebuild.sql: DROP TABLE shareables is blocked because the table is protected\n' +
        '- 9999_bad_rebuild.sql: ALTER TABLE RENAME shareables is blocked because the table is protected\n',
    })
  })

  test('allows explicit legacy table drops', () => {
    const result = runMigrationCheck({
      '0030_drop_legacy_shareable_container_columns.sql':
        'DROP TABLE shareable_container_cleanup_assertions;',
    })

    expect(result).toEqual({ ok: true, stderr: '' })
  })

  test('allows legacy membership table drops in contract migration', () => {
    const result = runMigrationCheck({
      '0061_drop_legacy_membership_tables.sql': `
        DROP TABLE IF EXISTS shareable_delete_events;
        DROP TABLE IF EXISTS workspace_contributors;
        DROP TABLE IF EXISTS workspace_admins;
      `,
    })

    expect(result).toEqual({ ok: true, stderr: '' })
  })

  test('blocks protected deletes unless the migration is explicitly allowed', () => {
    const blocked = runMigrationCheck({
      '9999_bad_delete.sql':
        'DELETE FROM versions WHERE shareable_id IS NOT NULL;',
    })
    expect(blocked).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_bad_delete.sql: DELETE FROM versions is blocked because the table is protected\n',
    })

    const allowed = runMigrationCheck({
      '0020_wipe_shareables_for_dns_safe_ids.sql': 'DELETE FROM versions;',
    })
    expect(allowed).toEqual({ ok: true, stderr: '' })
  })

  test('blocks protected replace, rename destination, and compact quoted drops', () => {
    const result = runMigrationCheck({
      '9999_compact.sql': `
        REPLACE INTO shareables (id) VALUES ('s1');
        ALTER TABLE scratch_shareables RENAME TO shareables;
        DROP TABLE"versions";
      `,
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_compact.sql: DROP TABLE versions is blocked because the table is protected\n' +
        '- 9999_compact.sql: REPLACE INTO shareables is blocked because the table is protected\n' +
        '- 9999_compact.sql: ALTER TABLE RENAME TO shareables is blocked because the table is protected\n',
    })
  })

  test('does not let string literal comments hide destructive SQL', () => {
    const result = runMigrationCheck({
      '9999_string_comment.sql':
        "UPDATE notes SET body = 'literal -- marker'; DROP TABLE versions;",
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_string_comment.sql: DROP TABLE versions is blocked because the table is protected\n',
    })
  })

  test('does not let quoted identifier apostrophes hide destructive SQL', () => {
    const result = runMigrationCheck({
      '9999_quoted_identifier.sql':
        'ALTER TABLE notes ADD COLUMN "o\'brien" TEXT; DROP TABLE versions;',
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_quoted_identifier.sql: DROP TABLE versions is blocked because the table is protected\n',
    })
  })

  test('blocks replace even in a migration with a protected drop allowlist', () => {
    const result = runMigrationCheck({
      '0017_drive_folder_rebase.sql':
        "REPLACE INTO shareables (id) VALUES ('s1');",
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 0017_drive_folder_rebase.sql: REPLACE INTO shareables is blocked because the table is protected\n',
    })
  })

  test('allows only explicit protected rename destination pairs', () => {
    expect(
      runMigrationCheck({
        '0014_shareables_managed_columns_not_null.sql':
          'ALTER TABLE shareables_new RENAME TO shareables;',
      }),
    ).toEqual({ ok: true, stderr: '' })

    const blocked = runMigrationCheck({
      '0014_shareables_managed_columns_not_null.sql':
        'ALTER TABLE scratch_shareables RENAME TO shareables;',
    })
    expect(blocked).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 0014_shareables_managed_columns_not_null.sql: ALTER TABLE RENAME TO shareables is blocked because the table is protected\n',
    })
  })

  test('blocks protected drop column without the optional column keyword', () => {
    const result = runMigrationCheck({
      '9999_drop_column.sql': 'ALTER TABLE shareables DROP project_id;',
    })

    expect(result).toEqual({
      ok: false,
      stderr:
        'Unsafe migration SQL detected:\n' +
        '- 9999_drop_column.sql: ALTER TABLE DROP COLUMN shareables is blocked because the table is protected\n',
    })
  })
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
    return { ok: true, stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stderr:
        error instanceof Error && 'stderr' in error
          ? String(error.stderr)
          : String(error),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
