import { checkTaskWalkthroughs } from './task-walkthroughs.mjs'

const failures = checkTaskWalkthroughs()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('task walkthrough check ok: 4 champion-loop tasks')
