import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function parseGlossary(markdown) {
  const deny = []
  for (const row of markdown
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (
      cells.length < 5 ||
      cells[0] === '概念' ||
      cells.every((cell) => /^[-:]+$/.test(cell))
    )
      continue
    for (const word of cells[4]
      .replace(/`[^`]*`/g, '')
      .split(/[、,，]/)
      .map((value) => value.trim())) {
      if (word && word !== '—') {
        const surfaceMatch = word.match(/^ui:(?:(en|ja):)?(.+)$/i)
        const locale = word.match(/^([a-z]{2}):(.+)$/i)
        const prefix =
          surfaceMatch?.[1]?.toLowerCase() ??
          (surfaceMatch ? undefined : locale?.[1].toLowerCase())
        const value = surfaceMatch?.[2] ?? locale?.[2] ?? word
        deny.push({
          ...(prefix ? { locale: prefix } : {}),
          ...(surfaceMatch ? { surface: 'ui' } : {}),
          word: value,
        })
      }
    }
  }
  const products = {}
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^- (日本語|英語): \*\*(.+)\*\*$/)
    if (match) products[match[1] === '日本語' ? 'ja' : 'en'] = match[2]
  }
  return {
    deny: [
      ...new Map(
        deny.map((item) => [
          `${item.locale ?? ''}:${item.surface ?? ''}:${item.word}`,
          item,
        ]),
      ).values(),
    ],
    products,
  }
}

export function flattenJson(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof child === 'string'
      ? [{ key: path, value: child }]
      : flattenJson(child, path)
  })
}

export function findViolations({
  deny,
  json,
  legal,
  publicCopy = {},
  allow = {},
}) {
  const violations = []
  const matches = (value, rawEntry) => {
    const entry = typeof rawEntry === 'string' ? { word: rawEntry } : rawEntry
    const text = value.replace(/Artifact Share/g, '')
    if (entry.locale && entry.locale !== 'en') return text.includes(entry.word)
    if (!entry.locale && /[^\p{ASCII}]/u.test(entry.word))
      return text.includes(entry.word)
    return new RegExp(
      `\\b${entry.word.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`,
      'i',
    ).test(text)
  }
  for (const [locale, localeJson] of Object.entries(json)) {
    for (const { key, value } of flattenJson(localeJson)) {
      for (const rawEntry of deny) {
        const entry =
          typeof rawEntry === 'string' ? { word: rawEntry } : rawEntry
        const word = entry.word
        const allowed = allow.copy?.[value]?.includes(word)
        if (
          (!entry.locale || entry.locale === locale) &&
          (!entry.surface || entry.surface === 'ui') &&
          matches(value, entry) &&
          !allowed
        ) {
          violations.push({
            file: `apps/web/app/i18n/${locale}.json`,
            key,
            word,
          })
        }
      }
    }
  }
  for (const [file, text] of Object.entries(legal)) {
    text.split(/\r?\n/).forEach((line, index) => {
      for (const rawEntry of deny.filter((entry) => !entry.surface)) {
        const entry =
          typeof rawEntry === 'string' ? { word: rawEntry } : rawEntry
        if (
          (!entry.locale || entry.locale === file.split('.')[1]) &&
          matches(line, entry) &&
          !allow.copy?.[line.trim()]?.includes(entry.word)
        )
          violations.push({ file, line: index + 1, word: entry.word })
      }
    })
  }
  for (const [file, text] of Object.entries(publicCopy)) {
    const locale = file.endsWith('.ja')
      ? 'ja'
      : file.endsWith('.en')
        ? 'en'
        : undefined
    for (const rawEntry of deny.filter((entry) => !entry.surface)) {
      const entry = typeof rawEntry === 'string' ? { word: rawEntry } : rawEntry
      if ((!entry.locale || entry.locale === locale) && matches(text, entry))
        violations.push({ file, word: entry.word })
    }
  }
  return violations
}

export function checkProductSummaries(glossary, jsonByLocale) {
  return ['ja', 'en']
    .flatMap((locale) =>
      ['vw.productSummary', 'about.meta.description'].map((key) => ({
        locale,
        key,
        expected: glossary.products[locale],
        actual: jsonByLocale[locale]?.[key],
      })),
    )
    .filter(({ expected, actual }) => !expected || expected !== actual)
}

export function extractMarkdownCopy(markdown) {
  const frontmatter = markdown.match(
    /^---\s*\r?\n([\s\S]*?)^---\s*(?:\r?\n|$)/m,
  )
  const title =
    frontmatter?.[1]
      .split(/\r?\n/)
      .find((line) => /^title\s*:/i.test(line))
      ?.replace(/^title\s*:\s*/, '') ?? ''
  const withoutBlocks =
    `${title}\n${markdown.replace(/^---\s*[\r\n]+[\s\S]*?^---\s*(?:\r?\n|$)/m, '')}`
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^```[\s\S]*?^```\s*/gm, '')
      .replace(/`[^`]*`/g, '')
      .replace(
        /!?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|[\w.+-]+@[\w.-]+)/g,
        (match) =>
          match.startsWith('[') || match.startsWith('![')
            ? match.replace(/\([^)]*\)$/, '')
            : '',
      )
  return withoutBlocks
}

export function extractTypeScriptCopy(source, locale) {
  let scoped = source
  if (locale === 'en') {
    const starts = [
      source.search(/\ben\s*:\s*\{/),
      source.indexOf('const EN:'),
    ].filter((index) => index >= 0)
    const start = starts.length ? Math.min(...starts) : -1
    const ends = [
      source.search(/\bja\s*:\s*\{/),
      source.indexOf('const JA:'),
    ].filter((index) => index > start)
    scoped =
      start >= 0
        ? source.slice(start, ends.length ? Math.min(...ends) : undefined)
        : ''
  } else if (locale === 'ja') {
    const starts = [
      source.search(/\bja\s*:\s*\{/),
      source.indexOf('const JA:'),
    ].filter((index) => index >= 0)
    const start = starts.length ? Math.min(...starts) : -1
    scoped = start >= 0 ? source.slice(start) : ''
  }
  return [...scoped.matchAll(/:\s*(['"`])([\s\S]*?)\1/g)]
    .map(([, , value]) => value)
    .join('\n')
}

// Copy that the owner approved although it uses a glossary term. Keyed by the
// copy itself, so renaming an i18n key or moving a string keeps the exception,
// while rewriting the sentence asks for the decision again.
export const COPY_GLOSSARY_ALLOW = {
  copy: {
    // Private visibility is distinct from the action of publishing.
    非公開: ['公開'],
    // Owner-specified publisher consent sentence uses the API resource name.
    'This client can create private files and static sites in your home. It can read, download and update files and sites it created or you assigned to it, and permanently delete them or their older versions. Access continues after you share or move them within this workspace, while you remain the owner.':
      ['artifacts'],
    'AI ツールと接続': ['ツール'],
    // Owner-approved name for personal AI connections.
    'AI ツールと CLI': ['ツール'],
    'AI ツールや CLI、自動化の処理からの接続を管理します。': ['ツール'],
    管理者から外す: ['外す'],
    公開価格表を見る: ['公開'],
    公開価格表でプランを詳しく比べる: ['公開'],
    'React SPA や静的書き出しは、ビルド済みフォルダーを選択': ['フォルダ'],
    'ドロップしたフォルダーを読み取れませんでした。フォルダー選択からもう一度お試しください。':
      ['フォルダ'],
    'フォルダー階層が深すぎます。': ['フォルダ'],
    'このリンクは期限切れです。新しい期限を設定して保存すると、もう一度公開できます。':
      ['公開'],
    'リンクを再公開しました。': ['公開'],
    'リンクを再公開できませんでした。もう一度お試しください。': ['公開'],
    // Client identity registration, not publishing a file.
    '別のクライアントとして登録するには、別の名前でログインをやり直してください。作成済み・割り当て済みのファイルや静的サイトを引き続き管理するには、既存のクライアントを使い続けてください。':
      ['登録'],
    'ファイルを登録中です。少し待ってから、もう一度追加してください。': [
      '登録',
    ],
    'そのファイルはすでに別のファイルとして登録されています。先に古いほうを削除してください。':
      ['登録'],
    差し替える: ['差し替える'],
    'npx --yes @artifactshare/cli init でセットアップして': ['セットアップ'],
    'HTML、Markdown、フォルダ、静的サイト': ['フォルダ'],
    'Free、Plus、Team。投稿者・閲覧者・コメント参加者の人数による追加料金なし':
      ['参加者'],
    'このメールアドレスは登録済みです。下の欄にメールアドレスを入れて、コードでログインしてください。':
      ['登録'],
  },
}

export function collectCopyGlossary(root = DEFAULT_ROOT) {
  const glossary = parseGlossary(
    readFileSync(join(root, 'docs/reference/glossary.md'), 'utf8'),
  )
  const jsonByLocale = Object.fromEntries(
    ['ja', 'en'].map((locale) => [
      locale,
      JSON.parse(
        readFileSync(join(root, `apps/web/app/i18n/${locale}.json`), 'utf8'),
      ),
    ]),
  )
  const markdownFiles = globSync(
    'apps/web/app/{guides,updates/entries,legal}/*.{ja,en}.md',
    { cwd: root },
  )
  const legal = Object.fromEntries(
    markdownFiles.map((file) => [
      file,
      extractMarkdownCopy(readFileSync(join(root, file), 'utf8')),
    ]),
  )
  const publicCopy = Object.fromEntries(
    ['getting-started-content.ts', 'share-with-ai-content.ts'].flatMap((name) =>
      ['en', 'ja'].map((locale) => {
        const file = `apps/web/app/lib/${name}`
        return [
          `${file}.${locale}`,
          extractTypeScriptCopy(readFileSync(join(root, file), 'utf8'), locale),
        ]
      }),
    ),
  )
  const violations = findViolations({
    deny: glossary.deny,
    json: { ja: jsonByLocale.ja, en: jsonByLocale.en },
    legal,
    publicCopy,
    allow: COPY_GLOSSARY_ALLOW,
  })
  return {
    violations,
    summaries: checkProductSummaries(glossary, jsonByLocale),
  }
}

export function formatCopyGlossaryMessage({ violations, summaries }) {
  return [
    ...violations.map((violation) => {
      const location = violation.key ?? violation.line
      return `${violation.file}${location === undefined ? '' : `:${location}`}: ${violation.word}`
    }),
    ...summaries.map(
      ({ locale, key }) => `${locale}.${key}: product summary differs`,
    ),
  ]
}

const reportedRoots = new Set()

export function createCopyGlossaryRule({ root = DEFAULT_ROOT } = {}) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'enforce the product copy glossary across checked-in public copy',
      },
      schema: [],
    },
    create(context) {
      return {
        Program(node) {
          if (reportedRoots.has(root)) return
          reportedRoots.add(root)
          const messages = formatCopyGlossaryMessage(collectCopyGlossary(root))
          for (const message of messages) context.report({ node, message })
        },
      }
    },
  }
}

const plugin = {
  meta: { name: 'copy-glossary' },
  rules: {
    'no-violations': createCopyGlossaryRule(),
  },
}

export default plugin
