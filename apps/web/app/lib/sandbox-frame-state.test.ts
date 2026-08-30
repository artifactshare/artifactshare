import { describe, expect, test } from 'vitest'
import en from '../i18n/en.json'
import ja from '../i18n/ja.json'
import {
  classifySandboxProbeResponse,
  shouldAcceptNavigationResult,
  shouldReportBlock,
  shouldAttemptAutomaticRecovery,
  shouldStartLivenessCheck,
  shouldStartLivenessProbe,
} from './sandbox-frame-state'

describe('sandbox frame transitions', () => {
  test('keeps the blocked and paused copy exact', () => {
    const expected = {
      en: [
        'Unable to load this file',
        'Your current network may be blocking this file from loading.',
        'The file hasn’t been deleted',
        'Reload',
        'It may open on a different network.',
        'Using a company network?',
        'Ask your IT administrator to allow HTTPS connections to artifactshare.com and *.sandbox.artifactshare.com. The second domain securely isolates and displays file content.',
        'Display paused',
        'The display did not finish loading, so we paused it.',
        'The file and share link are unaffected',
        'Continue viewing',
        'You can resume right away.',
        'The last attempt did not finish. Try again or reload the page.',
        'Resuming display…',
      ],
      ja: [
        '内容を読み込めていません',
        '現在のネットワークでは、ファイルの読み込みが遮断されている可能性があります。',
        'ファイルは削除されていません',
        '再読み込み',
        '別のネットワークで開くと表示できることがあります。',
        '社内ネットワークで利用する場合',
        'IT 管理者へ、artifactshare.com と *.sandbox.artifactshare.com への HTTPS 通信の許可を依頼してください。後者はファイルの内容を隔離して表示するための配信用ドメインです。',
        '表示を一時停止しています',
        '読み込みを完了できなかったため、表示を一時停止しました。',
        'ファイルと共有リンクに問題はありません',
        '続きを表示',
        'すぐに表示を再開できます。',
        '直前の再開処理を完了できませんでした。もう一度試すか、ページを再読み込みしてください。',
        '表示を再開しています…',
      ],
    }
    const keys = [
      'title',
      'body',
      'reassurance',
      'reload',
      'next',
      'company',
      'admin',
      'title',
      'body',
      'reassurance',
      'resume',
      'next',
      'retryFailed',
      'resuming',
    ]
    const lookup = (catalog: typeof en) =>
      keys.map((key, index) =>
        index === 13
          ? catalog['vw.sandboxResuming']
          : catalog[
              `vw.sandbox${index < 7 ? 'Blocked' : 'Paused'}.${key}` as keyof typeof catalog
            ],
      )
    expect(lookup(en)).toEqual(expected.en)
    expect(lookup(ja)).toEqual(expected.ja)
  })
  test('liveness timer probes only when its generation is still current', () => {
    expect(shouldStartLivenessProbe(2, 2)).toBe(true)
    expect(shouldStartLivenessProbe(2, 3)).toBe(false)
  })
  test('stale navigation result is ignored', () => {
    expect(shouldAcceptNavigationResult(1, 2)).toBe(false)
  })
  test('reports once per navigation', () => {
    expect(shouldReportBlock(null, 3)).toBe(true)
    expect(shouldReportBlock(3, 3)).toBe(false)
  })
  test('requires the exposed marker header and exact body for reachability', () => {
    const marker = 'artifactshare-sandbox-probe-v1'
    expect(classifySandboxProbeResponse(200, marker, marker, marker)).toBe(
      'reachable',
    )
    expect(classifySandboxProbeResponse(200, null, marker, marker)).toBe(
      'network-error',
    )
    expect(classifySandboxProbeResponse(200, marker, 'other', marker)).toBe(
      'network-error',
    )
    expect(classifySandboxProbeResponse(403, null, '', marker)).toBe(
      'forbidden',
    )
  })
  test('checks visible resumes and persisted pageshow only', () => {
    expect(shouldStartLivenessCheck('visibilitychange', 'hidden')).toBe(false)
    expect(shouldStartLivenessCheck('visibilitychange', 'visible')).toBe(true)
    expect(shouldStartLivenessCheck('pageshow', 'hidden', true)).toBe(false)
    expect(shouldStartLivenessCheck('pageshow', 'visible', false)).toBe(false)
    expect(shouldStartLivenessCheck('pageshow', 'visible', true)).toBe(true)
  })
  test('bounds automatic recovery attempts', () => {
    expect(shouldAttemptAutomaticRecovery(0, 1)).toBe(true)
    expect(shouldAttemptAutomaticRecovery(1, 1)).toBe(false)
  })
})
