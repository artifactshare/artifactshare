import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { test } from 'vitest'
import {
  loadSkillBundle,
  managedState,
} from './command-runners/skill-folder.js'

const lines = (text: string) => text.replace(/\n$/, '').split('\n').length
const links = (text: string) =>
  [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]!)
const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\w -]/g, '')
    .replace(/ /g, '-')

function validateBundle(files: Record<string, string>) {
  const entry = files['SKILL.md']!
  assert.ok(lines(entry) < 500, 'entrypoint must have fewer than 500 lines')
  const direct = links(entry)
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith('references/')) {
      assert.ok(direct.includes(path), `unlinked reference: ${path}`)
      if (lines(content) > 100)
        assert.match(content, /^(?:# [^\n]+\n\n)?## Contents\n\n- \[/)
    }
    for (const link of links(content)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue
      const [target, fragment] = link.split('#')
      const resolved = target ? posix.join(posix.dirname(path), target) : path
      assert.ok(Object.hasOwn(files, resolved), `missing target: ${resolved}`)
      if (path.startsWith('references/') && target)
        assert.ok(!resolved.startsWith('references/'), 'reference chain')
      if (fragment) {
        const headings = [...files[resolved]!.matchAll(/^#+ (.+)$/gm)]
        assert.ok(
          headings.some((match) => anchor(match[1]!) === fragment),
          `missing anchor: ${link}`,
        )
      }
    }
  }
}

test('bundled entrypoint is short, valid, managed and links every reference', async () => {
  const bundle = await loadSkillBundle(
    fileURLToPath(new URL('../skills/artifactshare', import.meta.url)),
  )
  validateBundle(bundle.files)
  const entry = bundle.files['SKILL.md']!
  const frontmatter = entry.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(frontmatter)
  const metadata = parse(frontmatter[1]!)
  assert.equal(metadata.name, 'artifactshare')
  assert.equal(typeof metadata.description, 'string')
  assert.ok(metadata.description.length > 0)
  assert.deepEqual(managedState(entry), { kind: 'managed', version: 52 })
  assert.equal(bundle.version, 52)
})

test('bundle checks reject missing, unlinked, oversized and chained documentation', () => {
  const valid = {
    'SKILL.md': '[Details](references/detail.md)',
    'references/detail.md': '# Details\n',
  }
  validateBundle(valid)
  assert.throws(
    () => validateBundle({ 'SKILL.md': valid['SKILL.md'] }),
    /missing target/,
  )
  assert.throws(
    () => validateBundle({ ...valid, 'references/extra.md': '# Extra' }),
    /unlinked reference/,
  )
  assert.throws(
    () =>
      validateBundle({
        ...valid,
        'SKILL.md': `${valid['SKILL.md']}\n${'line\n'.repeat(499)}`,
      }),
    /fewer than 500/,
  )
  assert.throws(
    () =>
      validateBundle({
        ...valid,
        'references/detail.md': '[Missing](#missing)',
      }),
    /missing anchor/,
  )
  assert.throws(
    () =>
      validateBundle({ ...valid, 'references/detail.md': '[Self](detail.md)' }),
    /reference chain/,
  )
  assert.throws(
    () =>
      validateBundle({
        ...valid,
        'references/detail.md': 'line\n'.repeat(101),
      }),
    /Contents/,
  )
})
