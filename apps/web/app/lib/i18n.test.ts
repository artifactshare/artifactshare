import { describe, expect, test } from 'vitest'
import { bindI18n, t, tPlural } from './i18n'

describe('t', () => {
  test('translates a known key', () => {
    expect(t('en', 'vw.back')).toBe('Back')
    expect(t('ja', 'vw.back')).toBe('戻る')
  })

  test('interpolates {var} placeholders', () => {
    expect(t('en', 'toast.copied', { url: 'https://x' })).toBe(
      'Copied · https://x',
    )
  })

  test('interpolates multiple vars + numbers', () => {
    expect(t('en', 'tb.fileCountOther', { n: 5 })).toBe('5 files')
  })

  test('interpolates revised Japanese copy, including the repeated holder', () => {
    expect(
      t('ja', 'team.members.revokeCliSessionsConfirm.title', {
        name: 'テスト',
      }),
    ).toBe('テスト のCLIセッションを失効させますか？')
    expect(t('ja', 'vw.versionStatusWithVersion', { version: 'v2' })).toBe(
      '版の状態: v2',
    )
    expect(t('ja', 'vw.versionStatusWithUpdate', { version: 'v2' })).toBe(
      '版の状態: v2、新しい版があります',
    )
    expect(
      t('ja', 'visibilityDialog.grants.header.title.workspace', {
        hd: 'example.com',
      }),
    ).toBe('「example.com」以外の人への個別共有')
    expect(t('ja', 'projectShareDefaults.addImpactNote', { count: 3 })).toBe(
      '追加した関係者は、保存するとこのプロジェクトのファイル 3 件を閲覧できるようになります。',
    )
    expect(t('ja', 'projectShareDefaults.removeImpactNote', { count: 3 })).toBe(
      '削除予定の関係者は、保存するとこのプロジェクトのファイル 3 件を閲覧できなくなります。',
    )
    expect(
      t('ja', 'billing.context.projectLimit', { limit: 20, current: 3 }),
    ).toBe(
      '有効なプロジェクトを20件中3件使用しています。Plusは20件まで、Teamは無制限で利用できます。',
    )
    expect(
      t('ja', 'toast.projectHasAgentCredentials', { holder: 'テスト' }),
    ).toBe(
      'テスト さんのエージェント CLI 資格情報がこのプロジェクトを対象にしています。テスト さんに資格情報を停止するか失効させてもらってから削除してください。',
    )
  })

  test('falls back to English for missing JA key', () => {
    // Both catalogs share the same key surface (TKey union), so a true
    // "missing in JA, present in EN" scenario requires casting. We instead
    // verify the fallback path returns the EN string when an unknown locale
    // is passed.
    // @ts-expect-error — runtime fallback for unrecognized locale
    expect(t('fr', 'vw.back')).toBe('Back')
  })

  test('returns key string when key not found in any locale', () => {
    // @ts-expect-error — bypass TKey for fallback-path test
    expect(t('en', 'nonexistent.key')).toBe('nonexistent.key')
  })

  test('omits missing var (no throw)', () => {
    expect(t('en', 'toast.copied')).toBe('Copied · ')
  })
})

describe('tPlural', () => {
  test.each([1, 2])(
    'renders revised Japanese plural copy for %i items',
    (n) => {
      expect(tPlural('ja', 'home.unopenedMore', n)).toBe(
        `すべて見る（ほかに未確認 ${n} 件）`,
      )
      expect(tPlural('ja', 'comments.highlightOpen', n)).toBe(
        `この箇所の未解決コメント${n}件を開く`,
      )
      expect(tPlural('ja', 'comments.highlightResolved', n)).toBe(
        `この箇所の解決済みコメント${n}件を開く`,
      )
      expect(tPlural('ja', 'preview.orphanNotice', n)).toBe(
        `ページが大きく変わったため、${n} 件のコメントの対象箇所が見つからなくなりました`,
      )
      expect(tPlural('ja', 'preview.batchQueued', n)).toBe(
        `エージェントへ通知済みです。エージェントが ${n} 件を受け取るのを待っています。この状態が続く場合は preview next の実行を依頼してください`,
      )
      expect(tPlural('ja', 'preview.batchQueuedCodex', n)).toBe(
        `Codexへ通知済みです。Codex が ${n} 件を受け取るのを待っています。この状態が続く場合は codex resume でセッションを再開してください`,
      )
      expect(tPlural('ja', 'preview.batchQueuedClaude', n)).toBe(
        `Claude Codeが依頼を確認しました。Claude Code が ${n} 件を受け取るのを待っています`,
      )
      expect(tPlural('ja', 'preview.batchQueuedCursor', n)).toBe(
        `管理対象のCursorセッションへ通知済みです。Cursor が ${n} 件を受け取るのを待っています`,
      )
    },
  )

  test('picks One form when n === 1', () => {
    expect(tPlural('en', 'tb.fileCount', 1)).toBe('1 file')
    expect(tPlural('ja', 'tb.fileCount', 1)).toBe('ファイル 1 件')
  })

  test('picks Other form when n !== 1', () => {
    expect(tPlural('en', 'tb.fileCount', 0)).toBe('0 files')
    expect(tPlural('en', 'tb.fileCount', 2)).toBe('2 files')
    expect(tPlural('en', 'tb.fileCount', 42)).toBe('42 files')
  })

  test('Recent tab uses a distinct count label', () => {
    expect(tPlural('ja', 'tb.recentCount', 1)).toBe('最近見たもの 1 件')
    expect(tPlural('ja', 'tb.recentCount', 5)).toBe('最近見たもの 5 件')
    expect(tPlural('en', 'tb.recentCount', 1)).toBe('1 recently seen')
    expect(tPlural('en', 'tb.recentCount', 5)).toBe('5 recently seen')
  })

  test('injects n as a var automatically', () => {
    expect(tPlural('en', 'card.viewCount', 7)).toBe('7 views')
    expect(tPlural('ja', 'card.viewCount', 7)).toBe('閲覧 7 回')
  })
})

describe('bindI18n', () => {
  test('curries locale into t / tPlural', () => {
    const j = bindI18n('ja')
    expect(j.locale).toBe('ja')
    expect(j.t('vw.back')).toBe('戻る')
    expect(j.tPlural('tb.fileCount', 3)).toBe('ファイル 3 件')
  })
})
