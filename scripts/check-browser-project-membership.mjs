import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cwd = fileURLToPath(new URL('../apps/web', import.meta.url))
for (const project of ['firefox', 'webkit']) {
  const files = execFileSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'list',
      '--config',
      'vitest.behavior.browser.config.ts',
      '--filesOnly',
      '--project',
      project,
      '_protected/settings',
    ],
    { cwd, encoding: 'utf8' },
  )
  for (const suite of [
    '_content/billing-readiness',
    '_content/bots',
    ...(project === 'firefox' ? ['cli-sessions'] : []),
  ]) {
    const file =
      'app/routes/_protected/settings/' + suite + '.behavior.browser.test.tsx'
    if (!files.split('\n').some((line) => line.trim().endsWith(file)))
      throw new Error(project + ' is missing ' + file)
  }
}
