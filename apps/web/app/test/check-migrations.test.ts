import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'

type Problem = {
  file: string
  code: string
  operation?: string
  table?: string
}

// The gate is the artifact under test, so each case runs it and reads the
// problems it reports as data.
function check(name: string, sql: string): Problem[] {
  return runMigrationCheck({ [name]: sql }).problems
}

describe('migration SQL guard', () => {
  test('blocks disabling foreign keys in new migrations', () => {
    expect(
      check('9999_bad_foreign_keys.sql', 'PRAGMA foreign_keys = OFF;'),
    ).toEqual([
      { file: '9999_bad_foreign_keys.sql', code: 'foreign-keys-setter' },
    ])
  })

  test.each([
    'PRAGMA foreign_keys = ON;',
    'PRAGMA main.foreign_keys(NO);',
    'PRAGMA "foreign_keys" = OFF;',
    'EXPLAIN PRAGMA foreign_keys = OFF;',
  ])('blocks foreign-key setter syntax: %s', (sql) => {
    expect(check('9999_bad_foreign_keys.sql', sql)).toEqual([
      { file: '9999_bad_foreign_keys.sql', code: 'foreign-keys-setter' },
    ])
  })

  test('ignores PRAGMA-like text inside comments and string literals', () => {
    expect(
      check(
        '9999_pragma_text.sql',
        `
          -- PRAGMA foreign_keys = OFF;
          INSERT INTO notes (body) VALUES ('PRAGMA foreign_keys = OFF;');
        `,
      ),
    ).toEqual([])
  })

  test('keeps the explicit legacy foreign-key exceptions narrow', () => {
    expect(
      check(
        '0014_shareables_managed_columns_not_null.sql',
        'PRAGMA main.foreign_keys = 0;',
      ),
    ).toEqual([])
    expect(
      check('0015_not_legacy.sql', 'PRAGMA main.foreign_keys = 0;'),
    ).toEqual([{ file: '0015_not_legacy.sql', code: 'foreign-keys-setter' }])
  })

  test('blocks protected parent table drops even when foreign keys are disabled', () => {
    expect(
      check(
        '9999_bad_rebuild.sql',
        `
        PRAGMA foreign_keys = OFF;
        ALTER TABLE shareables RENAME TO shareables_old;
        CREATE TABLE shareables (id TEXT PRIMARY KEY);
        INSERT INTO shareables SELECT id FROM shareables_old;
        DROP TABLE shareables_old;
        DROP TABLE shareables;
      `,
      ),
    ).toEqual([
      { file: '9999_bad_rebuild.sql', code: 'foreign-keys-setter' },
      {
        file: '9999_bad_rebuild.sql',
        code: 'unlisted-drop',
        operation: 'DROP TABLE',
        table: 'shareables_old',
      },
      {
        file: '9999_bad_rebuild.sql',
        code: 'protected-table',
        operation: 'DROP TABLE',
        table: 'shareables',
      },
      {
        file: '9999_bad_rebuild.sql',
        code: 'protected-table',
        operation: 'ALTER TABLE RENAME',
        table: 'shareables',
      },
    ])
  })

  test('allows explicit legacy table drops', () => {
    expect(
      check(
        '0030_drop_legacy_shareable_container_columns.sql',
        'DROP TABLE shareable_container_cleanup_assertions;',
      ),
    ).toEqual([])
  })

  test('allows legacy membership table drops in contract migration', () => {
    expect(
      check(
        '0061_drop_legacy_membership_tables.sql',
        `
        DROP TABLE IF EXISTS shareable_delete_events;
        DROP TABLE IF EXISTS workspace_contributors;
        DROP TABLE IF EXISTS workspace_admins;
      `,
      ),
    ).toEqual([])
  })

  test('blocks protected deletes unless the migration is explicitly allowed', () => {
    expect(
      check(
        '9999_bad_delete.sql',
        'DELETE FROM versions WHERE shareable_id IS NOT NULL;',
      ),
    ).toEqual([
      {
        file: '9999_bad_delete.sql',
        code: 'protected-table',
        operation: 'DELETE FROM',
        table: 'versions',
      },
    ])
    expect(
      check(
        '0020_wipe_shareables_for_dns_safe_ids.sql',
        'DELETE FROM versions;',
      ),
    ).toEqual([])
  })

  test('blocks protected replace, rename destination, and compact quoted drops', () => {
    expect(
      check(
        '9999_compact.sql',
        `
        REPLACE INTO shareables (id) VALUES ('s1');
        ALTER TABLE scratch_shareables RENAME TO shareables;
        DROP TABLE"versions";
      `,
      ),
    ).toEqual([
      {
        file: '9999_compact.sql',
        code: 'protected-table',
        operation: 'DROP TABLE',
        table: 'versions',
      },
      {
        file: '9999_compact.sql',
        code: 'protected-table',
        operation: 'REPLACE INTO',
        table: 'shareables',
      },
      {
        file: '9999_compact.sql',
        code: 'protected-table',
        operation: 'ALTER TABLE RENAME TO',
        table: 'shareables',
      },
    ])
  })

  test('does not let string literal comments hide destructive SQL', () => {
    expect(
      check(
        '9999_string_comment.sql',
        "UPDATE notes SET body = 'literal -- marker'; DROP TABLE versions;",
      ),
    ).toEqual([
      {
        file: '9999_string_comment.sql',
        code: 'protected-table',
        operation: 'DROP TABLE',
        table: 'versions',
      },
    ])
  })

  test('does not let quoted identifier apostrophes hide destructive SQL', () => {
    expect(
      check(
        '9999_quoted_identifier.sql',
        'ALTER TABLE notes ADD COLUMN "o\'brien" TEXT; DROP TABLE versions;',
      ),
    ).toEqual([
      {
        file: '9999_quoted_identifier.sql',
        code: 'protected-table',
        operation: 'DROP TABLE',
        table: 'versions',
      },
    ])
  })

  test('blocks replace even in a migration with a protected drop allowlist', () => {
    expect(
      check(
        '0017_drive_folder_rebase.sql',
        "REPLACE INTO shareables (id) VALUES ('s1');",
      ),
    ).toEqual([
      {
        file: '0017_drive_folder_rebase.sql',
        code: 'protected-table',
        operation: 'REPLACE INTO',
        table: 'shareables',
      },
    ])
  })

  test('allows only explicit protected rename destination pairs', () => {
    expect(
      check(
        '0014_shareables_managed_columns_not_null.sql',
        'ALTER TABLE shareables_new RENAME TO shareables;',
      ),
    ).toEqual([])
    expect(
      check(
        '0014_shareables_managed_columns_not_null.sql',
        'ALTER TABLE scratch_shareables RENAME TO shareables;',
      ),
    ).toEqual([
      {
        file: '0014_shareables_managed_columns_not_null.sql',
        code: 'protected-table',
        operation: 'ALTER TABLE RENAME TO',
        table: 'shareables',
      },
    ])
  })

  test('blocks protected drop column without the optional column keyword', () => {
    expect(
      check('9999_drop_column.sql', 'ALTER TABLE shareables DROP project_id;'),
    ).toEqual([
      {
        file: '9999_drop_column.sql',
        code: 'protected-table',
        operation: 'ALTER TABLE DROP COLUMN',
        table: 'shareables',
      },
    ])
  })
})

describe('check:migrations gate', () => {
  test('exits non-zero and names the refused file and table', () => {
    const clean = runMigrationCheck({
      '9999_safe.sql': 'CREATE TABLE notes (id TEXT PRIMARY KEY);',
    })
    expect(clean.ok).toBe(true)

    const blocked = runMigrationCheck({
      '9999_drop_protected.sql': 'DROP TABLE versions;',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.stderr).toContain('9999_drop_protected.sql')
    expect(blocked.stderr).toContain('DROP TABLE versions')
  })
})

function runMigrationCheck(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'artifactshare-migrations-'))
  try {
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(dir, name), sql)
    }
    const result = spawnSync(
      process.execPath,
      ['check-migrations.mjs', dir, '--json'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    return {
      ok: result.status === 0,
      problems: JSON.parse(result.stdout) as Problem[],
      stderr: result.stderr,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
