/*
 * Local Marked instance — avoids mutating the global `marked` singleton
 * with setOptions, which would leak settings to anything else importing it.
 */

import { Marked } from 'marked'

const markdown = new Marked({ gfm: true, breaks: false })
export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false }) as string
}
