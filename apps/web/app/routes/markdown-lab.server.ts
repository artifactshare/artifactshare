import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const createHighlighter = createBundledHighlighter({
  langs: {
    typescript: () => import('@shikijs/langs/typescript'),
  },
  themes: {
    'github-light': () => import('@shikijs/themes/github-light'),
  },
  engine: () => createJavaScriptRegexEngine(),
})
const { codeToHtml } = createSingletonShorthands(createHighlighter)

export async function enhanceHtml(html: string) {
  const codeBlock =
    /<pre[^>]*><code class="language-([^" ]+)">([\s\S]*?)<\/code><\/pre>/g
  const matches = Array.from(html.matchAll(codeBlock))
  const replacements = await Promise.all(
    matches.map(([original, language, encodedCode]) => {
      if (language !== 'typescript' && language !== 'ts') return original
      return codeToHtml(decodeHtml(encodedCode), {
        lang: 'typescript',
        theme: 'github-light',
      })
    }),
  )
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
