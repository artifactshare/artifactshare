import { readFile } from 'node:fs/promises'
import type { ChangelogData, ChangelogLatestEntry } from './types.js'

export const CLI_UPDATES_URL = 'https://artifactshare.com/updates?product=cli'

const SECTION_HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})$/

export function extractChangelogSection(
  content: string,
  version: string,
): ChangelogLatestEntry | null {
  const lines = content.split('\n')
  let bodyStart = -1
  let date = ''

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(SECTION_HEADING)
    if (!match || match[1] !== version) continue
    bodyStart = index + 1
    date = match[2] ?? ''
    break
  }

  if (bodyStart === -1) return null

  const bodyLines: string[] = []
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('## ')) break
    bodyLines.push(line)
  }

  return {
    version,
    date,
    body: bodyLines.join('\n').trim(),
  }
}

export async function readBundledChangelog(): Promise<string | null> {
  try {
    const url = new URL('../CHANGELOG.md', import.meta.url)
    return await readFile(url, 'utf8')
  } catch {
    return null
  }
}

export function changelogDataFromContent(
  version: string,
  content: string | null,
): ChangelogData {
  return {
    version,
    updates_url: CLI_UPDATES_URL,
    latest: content ? extractChangelogSection(content, version) : null,
  }
}

export async function buildChangelogData(
  version: string,
): Promise<ChangelogData> {
  const content = await readBundledChangelog()
  return changelogDataFromContent(version, content)
}
