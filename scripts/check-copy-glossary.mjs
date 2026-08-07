import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname

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
        const allowed = allow.json?.[`${locale}.${key}`]?.includes(word)
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
        const word = entry.word
        const lineNumber = index + 1
        const allowed = allow.legal?.[file]?.[lineNumber]?.includes(word)
        if (
          (!entry.locale || entry.locale === file.split('.')[1]) &&
          matches(line, entry) &&
          !allowed
        )
          violations.push({ file, line: lineNumber, word })
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

if (import.meta.main) {
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
  const allow = {
    json: {
      'ja.footer.connect': ['ツール'],
      'ja.team.members': ['メンバー'],
      'ja.team.members.body': ['メンバー'],
      'ja.team.members.empty': ['メンバー'],
      'ja.team.members.role.member': ['メンバー'],
      'ja.team.members.search.label': ['メンバー'],
      'ja.team.members.noMatches': ['メンバー'],
      'ja.team.members.removeAdmin': ['メンバー', '外す'],
      'ja.team.members.menu': ['メンバー'],
      'ja.team.members.assetTransfer.noResults': ['メンバー'],
      'ja.team.guides.admin.primary': ['メンバー'],
      'ja.team.removedMembers': ['メンバー'],
      'ja.team.removedMembers.body': ['メンバー'],
      'ja.team.removedMembers.transferConfirm.body': ['メンバー'],
      'ja.team.inventory.location': ['場所'],
      'ja.team.usage.pricingLink': ['公開'],
      'ja.team.activity.action.member.remove': ['メンバー'],
      'ja.team.activity.action.member.restore': ['メンバー'],
      'ja.team.status.removed': ['メンバー'],
      'ja.team.status.removedTransferFailed': ['メンバー'],
      'ja.team.status.restoreUnavailable': ['メンバー'],
      'ja.oa.consent.app': ['アプリ'],
      'ja.externalAccess.plan.plus': ['公開', '組織'],
      'ja.externalAccess.plan.team': ['公開', '組織'],
      'ja.externalAccess.linkSharing.team': ['公開', '組織'],
      'ja.externalAccess.externalPosting.team': ['組織'],
      'ja.billing.downgrade.admin': ['メンバー'],
      'ja.billing.checkout.submit.plus': ['申し込む'],
      'ja.billing.checkout.submit.team': ['申し込む'],
      'ja.billing.pricingLink': ['公開'],
      'ja.upload.drop.bundleHelp': ['フォルダ'],
      'ja.upload.error.dropReadFailed': ['フォルダ'],
      'ja.upload.error.pathTooDeep': ['フォルダ'],
      'ja.comments.clearSelection': ['外す'],
      'ja.visibilityDialog.link.expired': ['公開'],
      'ja.visibilityDialog.link.republishSuccess': ['公開'],
      'ja.visibilityDialog.link.republishError': ['公開'],
      'ja.toast.pickNotRegistered': ['登録'],
      'ja.toast.repairConflict': ['登録'],
      'ja.sourceMissing.repair': ['差し替える'],
      'ja.openErr.body': ['再アップロード'],
      'ja.lp.routes.cli.body': ['フォルダ'],
      'ja.lp.flow.steps.publish.body': ['フォルダ'],
      'ja.lp.workflow.title': ['チーム'],
      'ja.lp.workflow.cards.kpi.body': ['チーム'],
      'ja.lp.workflow.cards.design.body': ['場所'],
      'ja.lp.access.body': ['参加者'],
      'ja.about.official.audience': ['チーム'],
      'ja.about.hero.intro': ['チーム'],
      'ja.about.flow.title': ['チーム'],
      'ja.about.flow.intro': ['チーム'],
      'ja.about.official.formats': ['フォルダ'],
      'ja.about.official.plans': ['参加者'],
      'ja.oa.signin.sub': ['アプリ'],
      'ja.signin.error.admin_consent': ['アプリ', '組織'],
      'ja.signin.error.account_not_linked': ['登録'],
      'ja.oa.consent.sub': ['アプリ'],
      'ja.project.emptyBody': ['場所'],
      'ja.project.sharedProjectsNote': ['組織'],
      'ja.slack.kind.workspace_app': ['アプリ'],
    },
  }
  const violations = findViolations({
    deny: glossary.deny,
    json: { ja: jsonByLocale.ja, en: jsonByLocale.en },
    legal,
    publicCopy,
    allow,
  })
  const summaries = checkProductSummaries(glossary, jsonByLocale)
  for (const v of violations)
    console.error(`${v.file}:${v.key ?? v.line}: ${v.word}`)
  for (const v of summaries)
    console.error(`${v.locale}.${v.key}: product summary differs`)
  if (violations.length || summaries.length) process.exitCode = 1
}
