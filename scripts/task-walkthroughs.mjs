import { personas, taskFlowPhases, tasks } from './task-ledger.mjs'

export const championLoopTaskIds = [
  'return-to-recent-file',
  'republish-updated-file',
  'share-file-link',
  'review-new-reactions',
]

export const walkthroughActionKinds = new Set([
  'goto',
  'gotoArtifact',
  'gotoCliArtifact',
  'cliShare',
  'cliShareAndGoto',
  'cliUpdate',
  'cliUpdateMissing',
  'cliUpdateRecovery',
  'cliDelete',
  'click',
  'inspect',
  'inspectOptional',
  'wait',
  'readClipboard',
])

const phase = (name, description, action) => ({
  phase: name,
  description,
  action,
})

export const taskWalkthroughs = [
  {
    taskId: 'return-to-recent-file',
    scenario: 'recent/content-rich',
    artifactIndex: 21,
    steps: [
      phase('start', 'Home で最近見たファイルを探し始める', {
        kind: 'goto',
        path: '/',
      }),
      phase('action', 'Home の候補と全件導線を確認する', {
        kind: 'inspect',
        selector: 'main a[href^="/recent"]',
      }),
      phase('pending', '全件履歴の読み込みを記録する', {
        kind: 'goto',
        path: '/recent?page=2',
        captureDuringNavigation: true,
      }),
      phase('success', '全件履歴から目的のファイルを開く', {
        kind: 'gotoArtifact',
      }),
      phase('failure', 'Home の表示範囲だけでは目的を特定できない', {
        kind: 'goto',
        path: '/',
      }),
      phase('recovery', '全件履歴へ移って候補を広げる', {
        kind: 'goto',
        path: '/recent?page=2',
      }),
      phase('next', 'Viewer で目的の内容を再確認する', {
        kind: 'gotoArtifact',
      }),
    ],
  },
  {
    taskId: 'republish-updated-file',
    scenario: 'recent/content-rich',
    artifactIndex: 21,
    agentMediated: true,
    steps: [
      phase('start', '既存ファイルと更新前の内容を確認する', {
        kind: 'cliShareAndGoto',
      }),
      phase('action', 'CLI で同じ対象へ更新版を投稿する', {
        kind: 'cliUpdate',
      }),
      phase('pending', '更新処理中のログと Viewer 読み込みを記録する', {
        kind: 'gotoCliArtifact',
        captureDuringNavigation: true,
      }),
      phase('success', '同じ URL に更新後の本文が表示される', {
        kind: 'gotoCliArtifact',
      }),
      phase('failure', '誤った対象指定の CLI エラーを記録する', {
        kind: 'cliUpdateMissing',
      }),
      phase('recovery', '正しい対象を指定して更新し直す', {
        kind: 'cliUpdateRecovery',
      }),
      phase('next', '更新版の共有 URL を再確認する', {
        kind: 'gotoCliArtifact',
      }),
    ],
  },
  {
    taskId: 'share-file-link',
    scenario: 'recent/content-rich',
    artifactIndex: 1,
    agentMediated: true,
    steps: [
      phase('start', 'Viewer で対象と公開範囲を確認する', {
        kind: 'cliShareAndGoto',
        visibility: 'link',
      }),
      phase('action', '共有リンクをコピーする', {
        kind: 'click',
        selector:
          'button[aria-label="Copy link"], button[aria-label="共有リンクをコピー"]',
      }),
      phase('pending', 'コピー操作直後の通知を記録する', {
        kind: 'wait',
        milliseconds: 500,
      }),
      phase('success', 'クリップボードと成功通知を確認する', {
        kind: 'readClipboard',
      }),
      phase('failure', '公開範囲を判断できない場合の状態を確認する', {
        kind: 'inspect',
        selector:
          '[aria-label*="Change who can view"], [aria-label*="共有範囲を変更"]',
      }),
      phase('recovery', 'リンク共有ガイドで公開範囲を確認する', {
        kind: 'goto',
        path: '/guides/link-sharing',
      }),
      phase('next', 'Viewer に戻り、相手へ渡す URL を確認する', {
        kind: 'gotoCliArtifact',
      }),
    ],
  },
  {
    taskId: 'review-new-reactions',
    scenario: 'recent/content-rich',
    artifactIndex: 1,
    steps: [
      phase('start', 'Home で新しい反応の手がかりを探す', {
        kind: 'goto',
        path: '/',
      }),
      phase('action', '新着のあるファイルを一覧から開く', {
        kind: 'gotoArtifact',
      }),
      phase('pending', 'Viewer とコメントの読み込みを記録する', {
        kind: 'click',
        selector:
          'button[aria-label="Comments"], button[aria-label="コメント"]',
        captureDuringNavigation: true,
      }),
      phase('success', '新しいコメント本文を確認する', {
        kind: 'inspect',
        selector: '[data-slot="sheet-content"]',
      }),
      phase('failure', 'Home だけでは反応の対象を特定できない状態を残す', {
        kind: 'goto',
        path: '/',
      }),
      phase('recovery', '最近見た全件の新着表示から探し直す', {
        kind: 'goto',
        path: '/recent',
      }),
      phase('next', '対象 Viewer のコメントへ戻る', {
        kind: 'gotoArtifact',
      }),
    ],
  },
]

export function checkTaskWalkthroughs({
  walkthroughs = taskWalkthroughs,
  ledgerTasks = tasks,
  ledgerPersonas = personas,
} = {}) {
  const failures = []
  const taskById = new Map(ledgerTasks.map((task) => [task.id, task]))
  const personaById = new Map(
    ledgerPersonas.map((persona) => [persona.id, persona]),
  )
  const ids = new Set()
  for (const walkthrough of walkthroughs) {
    const task = taskById.get(walkthrough.taskId)
    if (!task) failures.push(`${walkthrough.taskId}: unknown task`)
    if (ids.has(walkthrough.taskId))
      failures.push(`${walkthrough.taskId}: duplicate walkthrough`)
    ids.add(walkthrough.taskId)
    if (!walkthrough.scenario)
      failures.push(`${walkthrough.taskId}: scenario required`)
    const phases = walkthrough.steps?.map((step) => step.phase) ?? []
    if (phases.join(',') !== taskFlowPhases.join(','))
      failures.push(
        `${walkthrough.taskId}: walkthrough phases must be ${taskFlowPhases.join(', ')}`,
      )
    for (const step of walkthrough.steps ?? []) {
      if (!step.description?.trim())
        failures.push(
          `${walkthrough.taskId}/${step.phase}: description required`,
        )
      if (!step.action?.kind)
        failures.push(`${walkthrough.taskId}/${step.phase}: action required`)
      else if (!walkthroughActionKinds.has(step.action.kind))
        failures.push(
          `${walkthrough.taskId}/${step.phase}: unknown action ${step.action.kind}`,
        )
    }
    const persona = task ? personaById.get(task.persona) : null
    if (!persona?.auth)
      failures.push(`${walkthrough.taskId}: persona auth required`)
    if (walkthrough.agentMediated && persona?.mediation !== 'agent-mediated')
      failures.push(
        `${walkthrough.taskId}: agent-mediated walkthrough requires an agent-mediated persona`,
      )
  }
  for (const id of championLoopTaskIds)
    if (!ids.has(id)) failures.push(`${id}: champion loop walkthrough required`)
  return failures
}
