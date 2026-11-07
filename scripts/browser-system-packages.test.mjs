import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const helper = 'scripts/ci/browser-system-packages.sh'

for (const scenario of [
  'copy',
  'missing',
  'empty',
  'filter',
  'spaces',
  'io-error',
]) {
  test(`archive copying: ${scenario}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-packages-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const source = path.join(root, 'source archives')
    const destination = path.join(root, 'destination archives')
    if (scenario !== 'missing') fs.mkdirSync(source)
    if (['copy', 'filter', 'spaces', 'io-error'].includes(scenario)) {
      fs.writeFileSync(
        path.join(source, 'example-package_1.0_amd64.deb'),
        Buffer.from([0, 1, 255]),
      )
    }
    if (scenario === 'copy') {
      fs.writeFileSync(path.join(source, 'second.deb'), 'second')
      fs.mkdirSync(destination)
      fs.writeFileSync(path.join(destination, 'unrelated'), 'retain')
    }
    if (scenario === 'filter') {
      fs.writeFileSync(path.join(source, 'unrelated.txt'), 'ignore')
      fs.mkdirSync(path.join(source, 'nested.deb'))
      fs.writeFileSync(path.join(source, 'nested.deb', 'nested.deb'), 'ignore')
      fs.symlinkSync(
        path.join(source, 'example-package_1.0_amd64.deb'),
        path.join(source, 'link.deb'),
      )
    }
    if (scenario === 'io-error')
      fs.writeFileSync(destination, 'not a directory')
    const result = spawnSync('bash', [helper, source, destination], {
      encoding: 'utf8',
    })
    if (scenario === 'io-error') {
      assert.notEqual(result.status, 0)
      return
    }
    assert.equal(result.status, 0, result.stderr)
    if (['missing', 'empty'].includes(scenario)) {
      assert.equal(fs.existsSync(destination), false)
      return
    }
    assert.deepEqual(
      fs.readFileSync(path.join(destination, 'example-package_1.0_amd64.deb')),
      Buffer.from([0, 1, 255]),
    )
    assert.deepEqual(
      fs.readFileSync(path.join(source, 'example-package_1.0_amd64.deb')),
      Buffer.from([0, 1, 255]),
    )
    if (scenario === 'copy') {
      assert.equal(
        fs.readFileSync(path.join(destination, 'second.deb'), 'utf8'),
        'second',
      )
      assert.equal(
        fs.readFileSync(path.join(source, 'second.deb'), 'utf8'),
        'second',
      )
      assert.equal(
        fs.readFileSync(path.join(destination, 'unrelated'), 'utf8'),
        'retain',
      )
    } else {
      assert.deepEqual(fs.readdirSync(destination), [
        'example-package_1.0_amd64.deb',
      ])
    }
  })
}

test('archive helper and test are canonical repository files', () => {
  const { canonical } = JSON.parse(
    fs.readFileSync('config/repository-boundary.json', 'utf8'),
  )
  for (const file of [helper, 'scripts/browser-system-packages.test.mjs'])
    assert.ok(canonical.includes(file))
})
