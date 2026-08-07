import { readFile } from 'node:fs/promises'

export async function loadCliVersion(): Promise<string> {
  try {
    const url = new URL('../package.json', import.meta.url)
    const content = await readFile(url, 'utf8')
    const pkg = JSON.parse(content) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
