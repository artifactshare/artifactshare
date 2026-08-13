import { createBundledHighlighter } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import {
  highlightTanStackCode,
  TANSTACK_HIGHLIGHT_CSS,
} from '~/lib/tanstack-highlight.server'

const createHighlighter = createBundledHighlighter({
  langs: {
    typescript: () => import('@shikijs/langs/typescript'),
  },
  themes: {
    'github-light': () => import('@shikijs/themes/github-light'),
  },
  engine: () => createJavaScriptRegexEngine(),
})
export { TANSTACK_HIGHLIGHT_CSS }

export async function enhanceHtml(
  html: string,
  renderer: 'marked' | 'tanstack',
) {
  const codeBlock =
    /<pre[^>]*><code class="language-([^" ]+)">([\s\S]*?)<\/code><\/pre>/g
  const matches = Array.from(html.matchAll(codeBlock))
  const shiki =
    renderer === 'marked'
      ? await createHighlighter({
          langs: ['typescript'],
          themes: ['github-light'],
        })
      : undefined
  const replacements = matches.map(([original, language, encodedCode]) => {
    if (renderer === 'tanstack') {
      // Mermaid keeps its source class until the browser-side diagram pass.
      if (language === 'mermaid') return original
      return highlightTanStackCode(decodeHtml(encodedCode), language).html
    }
    if (language !== 'typescript' && language !== 'ts') return original
    return shiki!.codeToHtml(decodeHtml(encodedCode), {
      lang: 'typescript',
      theme: 'github-light',
    })
  })
  shiki?.dispose()
  let output = ''
  let cursor = 0

  for (const [index, match] of matches.entries()) {
    output += html.slice(cursor, match.index) + replacements[index]
    const [original] = match
    cursor = (match.index ?? 0) + original.length
  }
  return output + html.slice(cursor)
}

function decodeHtml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
