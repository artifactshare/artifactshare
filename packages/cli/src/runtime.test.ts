import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { isSupportedNode } from './runtime.js'
import { expectFailure, run } from './test/helpers.js'

test('Node version comparison uses numeric major, minor and patch', () => {
  for (const version of ['20.19.0', '22.18.9', '21.99.0'])
    assert.equal(isSupportedNode(version), false)
  for (const version of ['22.19.0', '22.20.0', '24.0.0'])
    assert.equal(isSupportedNode(version), true)
})

test('built entry rejects old Node before loading any command dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-runtime-'))
  try {
    const preload = join(root, 'preload.mjs')
    for (const version of ['20.19.0', '22.18.0']) {
      for (const human of [false, true]) {
        await writeFile(
          preload,
          `
          import { registerHooks } from 'node:module';
          Object.defineProperty(process.versions, 'node', { value: '${version}' });
          Object.defineProperty(process.stdout, 'isTTY', { value: ${human} });
          registerHooks({ resolve(specifier, context, next) {
            if (specifier === './cli.js' || /cli-.*\\.js$/.test(specifier) || ['gunshi', 'undici'].includes(specifier)) throw new Error('Command graph loaded before runtime gate');
            return next(specifier, context);
          }});
        `,
        )
        const result = run(['whoami', ...(human ? [] : ['--json'])], {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        })
        assert.equal(result.stdout, '')
        assert.equal(result.status, 1)
        if (human) {
          assert.equal(result.stderr.trim().split('\n').length, 1)
          assert.match(result.stderr, /Upgrade Node.js/)
        } else {
          const { error } = expectFailure(result, {
            code: 'unsupported_node_version',
          })
          assert.equal(error.agent_recoverable, false)
          assert.equal(error.requires_human, true)
          assert.equal(error.recovery.kind, 'ask_human')
        }
        assert.match(result.stderr, /22\.19\.0/)
        assert.ok(result.stderr.includes(version))
      }
    }
    for (const version of ['22.19.0', '22.20.0', '24.0.0']) {
      await writeFile(
        preload,
        `Object.defineProperty(process.versions, 'node', { value: '${version}' });`,
      )
      const result = run(['--version'], {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /\d+\.\d+\.\d+/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
