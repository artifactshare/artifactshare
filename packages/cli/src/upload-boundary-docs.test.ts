import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

async function boundaryGuidance(path: string): Promise<string> {
  const text = await readFile(new URL(path, import.meta.url), 'utf8')
  const section = text.split('### Local upload boundary\n')[1]
  assert.ok(section, `Missing upload boundary guidance in ${path}`)
  return section.split(/^#{1,6} /m)[0]!.trim()
}

for (const path of [
  '../../../docs/reference/cli-command-catalog.md',
  '../skills/artifactshare/SKILL.md',
  '../skills/artifactshare/artifactshare.mdc',
]) {
  test(`upload boundary guidance matches the README in ${path}`, async () => {
    // These surfaces promise the same filesystem protection to users and agents.
    // Compare the shared section so one cannot retain an outdated guarantee.
    assert.equal(
      await boundaryGuidance(path),
      await boundaryGuidance('../README.md'),
    )
  })
}

test('upload boundary guidance states the required protections and limits', async () => {
  const guidance = (await boundaryGuidance('../README.md')).replace(/\s+/g, ' ')
  for (const requirement of [
    /Inputs, components below the trust root, and encountered descendants must not be symbolic links or junctions/,
    /boundary is the nearest ancestor of the input containing a `\.git` file or directory/,
    /If none exists, it is the current directory for relative inputs and the input's parent directory for absolute inputs/,
    /Inputs within cwd's worktree retain that boundary, even when addressed through an ancestor alias: a nearer Git marker cannot exempt links inside it/,
    /Windows checks the opened handle's `dev`\/`ino`\/`mode` against the link-free path before and after reading/,
    /Missing stable file identities still cause a local failure/,
    /not an atomic filesystem snapshot.*transient swap-and-restore changes between checks cannot always be detected/,
  ])
    assert.match(guidance, requirement)
})
