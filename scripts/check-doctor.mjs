import { readFileSync } from 'node:fs'

const d = JSON.parse(readFileSync(0, 'utf8'))

if (d.error) {
  console.error(d.error.message)
  process.exit(1)
}

const s = d.summary.score
const w = d.summary.warningCount
const e = d.summary.errorCount

console.log('react-doctor score:', s)

if (w !== 0 || e !== 0) {
  console.error(`react-doctor gate failed: warnings=${w}, errors=${e}`)
  process.exit(1)
}
