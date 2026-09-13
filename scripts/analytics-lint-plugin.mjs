import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const allowed = new Set([
  'apps/web/app/lib/analytics/track.client.ts',
  'apps/web/app/root.tsx',
])

export default {
  meta: { name: 'analytics' },
  rules: {
    'typed-sender': {
      meta: { schema: [] },
      create(context) {
        const file = relative(root, context.filename).replaceAll('\\', '/')
        if (
          !file.startsWith('apps/web/app/') ||
          !/\.tsx?$/.test(file) ||
          /\.test\.tsx?$/.test(file) ||
          allowed.has(file)
        )
          return {}
        return {
          Program() {
            // Preserve the retired checker's text scan, including embedded tag
            // snippets and comments. The suffix match includes window/globalThis
            // and receiver aliases such as w.gtag and w.dataLayer.push.
            const source = context.sourceCode
            const deny =
              /gtag\s*\??\.?\s*\(\s*(['"])event\1|dataLayer\s*\.\s*push/g
            for (const match of source.text.matchAll(deny)) {
              context.report({
                loc: {
                  start: source.getLocFromIndex(match.index),
                  end: source.getLocFromIndex(match.index + match[0].length),
                },
                message:
                  'Use the typed trackEvent sender for analytics events.',
              })
            }
          },
        }
      },
    },
  },
}
