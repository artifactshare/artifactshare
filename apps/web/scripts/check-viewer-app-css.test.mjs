import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { compareAppCss, withCommitApp } from './check-viewer-app-css.mjs'

test('the same sources build the same app CSS bytes', async () => {
  await withCommitApp('HEAD', async (currentRoot) => {
    const { same, baseCss } = await compareAppCss({ base: 'HEAD', currentRoot })
    assert.equal(same, true)
    assert.match(baseCss, /--breakpoint-stack/)
  })
})

test('a source that adds a utility to the app changes its CSS', async () => {
  await withCommitApp('HEAD', async (currentRoot) => {
    await writeFile(
      join(currentRoot, 'extra-utility.tsx'),
      "export const extra = <p className='grid-cols-[7fr_5fr]' />\n",
    )
    const { same, currentCss } = await compareAppCss({
      base: 'HEAD',
      currentRoot,
    })
    assert.equal(same, false)
    assert.match(currentCss, /grid-cols-\\\[7fr_5fr\\\]/)
  })
})
