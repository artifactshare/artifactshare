import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateVitestResults,
  countRecordedSubprocessLaunches,
} from './measure-cli-tests.mjs'

test('counts one record per runtime subprocess launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifactshare-measure-test-'))
  const path = join(directory, 'launches.log')
  await writeFile(path, '1\n1\n1\n')
  assert.equal(await countRecordedSubprocessLaunches(path), 3)
  assert.equal(
    await countRecordedSubprocessLaunches(join(directory, 'none')),
    0,
  )
})

test('aggregates Vitest counts and returns slow suites with repo-relative paths', () => {
  const result = aggregateVitestResults(
    {
      numTotalTestSuites: 2,
      numPassedTestSuites: 1,
      numFailedTestSuites: 1,
      numTotalTests: 3,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [
        {
          name: '/repo/packages/cli/src/slow.test.ts',
          startTime: 100,
          endTime: 450,
          status: 'failed',
        },
        {
          name: '/repo/packages/cli/src/fast.test.ts',
          startTime: 200,
          endTime: 250,
          status: 'passed',
        },
      ],
    },
    '/repo',
  )
  assert.deepEqual(result, {
    suites: { total: 2, passed: 1, failed: 1 },
    tests: { total: 3, passed: 1, failed: 1, pending: 1, todo: 0 },
    slow_suites: [
      {
        name: 'packages/cli/src/slow.test.ts',
        duration_ms: 350,
        status: 'failed',
      },
      {
        name: 'packages/cli/src/fast.test.ts',
        duration_ms: 50,
        status: 'passed',
      },
    ],
  })
})
