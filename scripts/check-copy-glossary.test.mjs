import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkProductSummaries,
  extractMarkdownCopy,
  extractTypeScriptCopy,
  findViolations,
  parseGlossary,
} from './check-copy-glossary.mjs'

test('extracts deny words and product sentences', () => {
  const result = parseGlossary(
    '| 概念 | 日本語 | 英語 | コード | 使わない語 |\n|---|---|---|---|---|\n| x | y | z | `artifact` | 成果物、—、`コード` |\n- 日本語: **日本語の文。**\n- 英語: **English sentence.**',
  )
  assert.deepEqual(result.deny, [{ word: '成果物' }])
  assert.deepEqual(result.products, {
    ja: '日本語の文。',
    en: 'English sentence.',
  })
})
test('new glossary rows become deny words, while headers, separators, dashes, and code do not', () => {
  const result = parseGlossary(
    '| 概念 | 日本語 | 英語 | コード | 使わない語 |\n|---|---|---|---|---|\n| x | y | z | `成果物` | 新しい語、—、`コード` |\n| y | y | z | — | 追加語 |',
  )
  assert.deepEqual(result.deny, [{ word: '新しい語' }, { word: '追加語' }])
})
test('parses locale-specific deny words and matches English safely', () => {
  const result = parseGlossary(
    '| 概念 | 日本語 | 英語 | コード | 使わない語 |\n|---|---|---|---|---|\n| x | y | z | — | en:Artifact、成果物 |',
  )
  assert.deepEqual(result.deny, [
    { locale: 'en', word: 'Artifact' },
    { word: '成果物' },
  ])
  assert.equal(
    findViolations({
      deny: result.deny,
      json: { en: { a: 'an artifact' }, ja: { a: '成果物' } },
      legal: {},
    }).length,
    2,
  )
  assert.equal(
    findViolations({
      deny: result.deny,
      json: { en: { a: 'Artifact Share Artifact artifact_id' } },
      legal: {},
    }).length,
    1,
  )
})
test('parses UI-only deny words and excludes them from prose', () => {
  const result = parseGlossary(
    '| 概念 | 日本語 | 英語 | コード | 使わない語 |\n|---|---|---|---|---|\n| x | y | z | — | ui:フォルダ、ui:en:Audience |',
  )
  assert.deepEqual(result.deny, [
    { surface: 'ui', word: 'フォルダ' },
    { locale: 'en', surface: 'ui', word: 'Audience' },
  ])
  assert.deepEqual(
    findViolations({
      deny: result.deny,
      json: { ja: { value: 'フォルダ' }, en: { value: 'Audience' } },
      legal: { 'guide.ja.md': 'フォルダ', 'guide.en.md': 'Audience' },
    }),
    [
      { file: 'apps/web/app/i18n/ja.json', key: 'value', word: 'フォルダ' },
      { file: 'apps/web/app/i18n/en.json', key: 'value', word: 'Audience' },
    ],
  )
})
test('ui deny words apply only to UI JSON', () => {
  const { deny } = parseGlossary(
    '| 概念 | 日本語 | 英語 | コード | 使わない語 |\n|---|---|---|---|---|\n| x | y | z | — | ui:アプリ |',
  )
  assert.deepEqual(deny, [{ surface: 'ui', word: 'アプリ' }])
  assert.equal(
    findViolations({
      deny,
      json: { ja: { label: 'アプリ' } },
      legal: {},
      publicCopy: { 'copy.ja': 'アプリ' },
    }).length,
    1,
  )
})
test('frontmatter title and link labels are copy, metadata and href are not', () => {
  const copy = extractMarkdownCopy(
    '---\ntitle: artifact\nslug: artifact\n---\n[artifact](https://artifact.example/artifact)',
  )
  assert.match(copy, /artifact/)
  assert.equal(copy.match(/artifact/g)?.length, 2)
})
test('TypeScript extraction scopes locale blocks', () => {
  const source = `const copy = { en: { title: 'artifact' }, ja: { title: '成果物' } }`
  assert.equal(extractTypeScriptCopy(source, 'en'), 'artifact')
  assert.equal(extractTypeScriptCopy(source, 'ja'), '成果物')
})
test('extracts Markdown title and prose but excludes structural non-copy', () => {
  const copy = extractMarkdownCopy(
    `---\ntitle: Sharing scope\nslug: artifact\n---\n# Project audience\nUse [Add audience](https://example.com/artifact)\n\`Current audience\` artifact@example.com https://example.com/artifact\n<!-- Company-wide -->\n\`\`\`\nen: artifact\n\`\`\``,
  )
  assert.match(copy, /Sharing scope/)
  assert.match(copy, /Project audience/)
  assert.match(copy, /Add audience/)
  assert.doesNotMatch(copy, /Current audience/)
  assert.doesNotMatch(copy, /Company-wide/)
  assert.doesNotMatch(copy, /artifact@example/)
  assert.doesNotMatch(copy, /https:\/\//)
})
test('extracts only quoted TypeScript copy', () => {
  const copy = extractTypeScriptCopy(
    "const route = 'artifact_id'; const item = { label: 'Project audience' }; // artifact",
  )
  assert.doesNotMatch(copy, /artifact_id/)
  assert.match(copy, /Project audience/)
  assert.doesNotMatch(copy, /\/\/ artifact/)
})
test('extracts both locale blocks from supported public copy shapes', () => {
  const objectCopy =
    "const COPY = {\n  en: { text: 'Artifact' },\n  ja: { text: '成果物' },\n}"
  assert.match(extractTypeScriptCopy(objectCopy, 'en'), /Artifact/)
  assert.doesNotMatch(extractTypeScriptCopy(objectCopy, 'en'), /成果物/)
  assert.match(extractTypeScriptCopy(objectCopy, 'ja'), /成果物/)

  const constantCopy =
    "const EN: Copy = { text: 'Artifact' }\nconst JA: Copy = { text: '成果物' }"
  assert.match(extractTypeScriptCopy(constantCopy, 'en'), /Artifact/)
  assert.doesNotMatch(extractTypeScriptCopy(constantCopy, 'en'), /成果物/)
  assert.match(extractTypeScriptCopy(constantCopy, 'ja'), /成果物/)
})
test('reports locale and key, and respects exact JSON allowlists', () => {
  const input = {
    deny: ['成果物'],
    json: {
      ja: { ok: '成果物', nested: { key: '成果物' } },
      en: { ok: '成果物' },
    },
    legal: {},
    allow: { json: { 'ja.ok': ['成果物'] } },
  }
  assert.deepEqual(findViolations(input), [
    { file: 'apps/web/app/i18n/ja.json', key: 'nested.key', word: '成果物' },
    { file: 'apps/web/app/i18n/en.json', key: 'ok', word: '成果物' },
  ])
  assert.deepEqual(
    findViolations({ ...input, allow: { json: { 'ja.ok': ['別の語'] } } })[0],
    { file: 'apps/web/app/i18n/ja.json', key: 'ok', word: '成果物' },
  )
})
test('legal allowlists require exact file, line, and word', () => {
  const input = {
    deny: ['成果物'],
    json: {},
    legal: { 'terms.ja.md': '成果物\n成果物\n' },
    allow: { legal: { 'terms.ja.md': { 1: ['成果物'] } } },
  }
  assert.deepEqual(findViolations(input), [
    { file: 'terms.ja.md', line: 2, word: '成果物' },
  ])
})
test('checks both summary keys', () => {
  assert.deepEqual(
    checkProductSummaries(
      { products: { ja: '日本語。', en: 'English.' } },
      {
        ja: {
          'vw.productSummary': '日本語。',
          'about.meta.description': '違う。',
        },
        en: {
          'vw.productSummary': 'English.',
          'about.meta.description': 'English.',
        },
      },
    ),
    [
      {
        locale: 'ja',
        key: 'about.meta.description',
        expected: '日本語。',
        actual: '違う。',
      },
    ],
  )
})
test('requires product sentences in both locales and keys', () => {
  const result = checkProductSummaries(
    { products: { ja: '日本語。', en: undefined } },
    {
      ja: {
        'vw.productSummary': '日本語。',
        'about.meta.description': '日本語。',
      },
      en: {},
    },
  )
  assert.deepEqual(
    result.map(({ locale, key }) => `${locale}.${key}`),
    ['en.vw.productSummary', 'en.about.meta.description'],
  )
})
