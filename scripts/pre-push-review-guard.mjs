import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const BLOCK_MESSAGE =
  'Draft PR のレビュー中は修正を local commit に留めてください。両 reviewer の final GO 後は AS_PUSH_AFTER_GO=1 git push としてください。'
export const STATE_ERROR_MESSAGE =
  'PR の状態を確認できないため push を停止しました。gh の導入、認証、network、rate limit を確認してください。確認後も明示的に進める場合は AS_PUSH_AFTER_GO=1 git push を使ってください。'

export function shouldCheckPush(input, branch) {
  if (!branch) return false
  const ref = `refs/heads/${branch}`
  return input
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === ref)
}

export function checkPrePush({
  stdin = '',
  branch,
  env = process.env,
  commandExists = (command) => {
    try {
      execFileSync('which', [command], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  runGh = () =>
    execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'isDraft'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ),
}) {
  if (!shouldCheckPush(stdin, branch)) return { exitCode: 0 }
  if (env.AS_PUSH_AFTER_GO === '1') return { exitCode: 0 }
  if (!commandExists('gh'))
    return { exitCode: 1, stderr: `${STATE_ERROR_MESSAGE}\n` }
  let rows
  try {
    rows = JSON.parse(runGh())
  } catch {
    return { exitCode: 1, stderr: `${STATE_ERROR_MESSAGE}\n` }
  }
  if (!Array.isArray(rows) || rows.length > 1)
    return { exitCode: 1, stderr: `${STATE_ERROR_MESSAGE}\n` }
  if (rows.length === 0 || rows[0]?.isDraft === false) return { exitCode: 0 }
  if (rows[0]?.isDraft === true)
    return { exitCode: 1, stderr: `${BLOCK_MESSAGE}\n` }
  return { exitCode: 1, stderr: `${STATE_ERROR_MESSAGE}\n` }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stdin = ''
  for await (const chunk of process.stdin) stdin += chunk
  let branch = ''
  try {
    branch = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
    }).trim()
  } catch {}
  const outcome = checkPrePush({ stdin, branch })
  if (outcome.stderr) process.stderr.write(outcome.stderr)
  process.exitCode = outcome.exitCode
}
