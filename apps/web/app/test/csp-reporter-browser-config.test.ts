import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('browser behavior config loads with native Node package resolution', () => {
  // Unit-test transforms can hide imports that fail in the config's Node process.
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadConfigFromFile } from 'vite';
const result = await loadConfigFromFile(
  { command: 'serve', mode: 'test' },
  'vitest.behavior.browser.config.ts',
);
if (typeof result?.config.test.browser.commands.cspDiagnostic !== 'function') {
  throw new Error('CSP browser command was not loaded');
}
console.log('browser config loaded');`,
    ],
    { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
  )
  expect(output).toContain('browser config loaded')
})
