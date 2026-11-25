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
    メンバー: ['メンバー'],
    'ワークスペースのメンバーを管理します。': ['メンバー'],
    'メンバーはいません。': ['メンバー'],
    メンバーを検索: ['メンバー'],
    '検索条件に一致するメンバーがいません。': ['メンバー'],
    管理者から外す: ['メンバー', '外す'],
    メンバー操作メニュー: ['メンバー'],
    '該当するメンバーがいません。': ['メンバー'],
    '管理者ガイド — 日常のメンバー管理': ['メンバー'],
    ワークスペースから削除したメンバー: ['メンバー'],
    'ワークスペースから削除したメンバーのファイルを引き継いだり、メンバーを復帰させたりできます。':
      ['メンバー'],
    'この人が所有するすべてのファイルを、選択したメンバーへ引き継ぎます。': [
      'メンバー',
    ],
    場所: ['場所'],
    公開価格表を見る: ['公開'],
    メンバーを削除: ['メンバー'],
    メンバーを復帰: ['メンバー'],
    'メンバーを削除しました。': ['メンバー'],
    'メンバーはワークスペースから削除されましたが、ファイルは引き継げませんでした。「ワークスペースから削除したメンバー」の一覧からもう一度実行してください。':
      ['メンバー'],
    'このメンバーは別の人と同じワークスペースを利用しているため復帰できません。':
      ['メンバー'],
    アプリ: ['アプリ'],
    'Plus プランではリンク共有を利用できます。組織全体での有効/無効の設定はプランで決まります。':
      ['公開', '組織'],
    'Team プランでは、ワークスペースの管理者が組織全体の外部アクセスを管理できます。':
      ['公開', '組織'],
    'Team プランでは、ワークスペース管理者が組織全体のリンク共有を有効/無効にできます。':
      ['公開', '組織'],
    'Team プランでは、ワークスペース管理者が組織全体の外部投稿を有効/無効にできます。':
      ['組織'],
    'メンバー管理などの Team 向け管理機能が使えなくなります': ['メンバー'],
    Plusを申し込む: ['申し込む'],
    Teamを申し込む: ['申し込む'],
    公開価格表でプランを詳しく比較する: ['公開'],
    'React SPA や静的書き出しは、ビルド済みフォルダーを選択': ['フォルダ'],
    'ドロップしたフォルダーを読み取れませんでした。フォルダー選択からもう一度お試しください。':
      ['フォルダ'],
    'フォルダー階層が深すぎます。': ['フォルダ'],
    選択を外す: ['外す'],
    'このリンクは期限切れです。新しい期限を設定して保存すると、再公開できます。':
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
    '少し時間をおいてから、もう一度お試しください。またはファイルを再アップロードしてください。':
      ['再アップロード'],
    'npm exec --yes --package=@artifactshare/cli -- artifactshare init でセットアップして':
      ['セットアップ'],
    'ページ上の該当箇所にピンでコメント。見る人に AI ツールやアカウント準備は要りません。ブラウザだけで参加できます。':
      ['ツール'],
    'AI の下書きを、チームで決められる文書に。': ['チーム'],
    メンバー招待: ['メンバー'],
    コンバージョン計測レポート: ['バージョン'],
    '「無料で人数制限もなく、すぐ使い始められました。気づいたらチームの共有は全部 URL になっていて、『最新版どれ?』も聞かなくなりました。」':
      ['チーム'],
    'EC 企業・プロダクト開発チーム EM': ['チーム'],
    '投稿直後の共有範囲は社内だけ。チーム内なら設定なしで安全です。': [
      'チーム',
    ],
    'AIでHTMLやMarkdownを作り、社内、顧客、プロジェクト関係者への共有と更新を続けたいチーム':
      ['チーム'],
    'AIでHTMLやMarkdownを作り、社内やプロジェクト関係者と共有するチーム向けのサービスです。作ったものを安全に見せ、反応を集めながら、更新を続けられます。共有ページからこのページに来た方が見ていたファイルは、Artifact Shareに投稿されたものです。':
      ['チーム'],
    '叩き台が、チームの判断材料になるまで': ['チーム'],
    '投稿、コメント、更新を重ねるうちに、共有ページの内容がチームで検討できる形に整っていきます。':
      ['チーム'],
    'HTML、Markdown、フォルダ、静的サイト': ['フォルダ'],
    'Free、Plus、Team。投稿者・閲覧者・コメント参加者の人数による追加料金なし':
      ['参加者'],
    'アプリが Artifact Share への接続を求めています。続けるにはログインしてください。':
      ['アプリ'],
    'あなたの組織では、管理者がこのアプリを承認する必要があります。組織の IT 管理者に、Artifact Share の利用承認を依頼してください。':
      ['アプリ', '組織'],
    'このメールアドレスは登録済みです。下の欄にメールアドレスを入れて、コードでログインしてください。':
      ['登録'],
    '接続すると、アプリがあなたの権限で、あなたのワークスペース内の Artifact Share のファイルを閲覧、共有、更新、完全に削除し、プロジェクトやコメントを管理できます。':
      ['アプリ'],
    '同じ仕事のファイルをまとめる場所を作れます。': ['場所'],
    '他のワークスペースから関係者として共有されたプロジェクトです。': ['組織'],
    // The reader's own PDF app, not the service.
    'このPDFはパスワードで保護されているため、ここでは開けません。ダウンロードして、お使いのPDFアプリで開いてください。':
      ['アプリ'],
    // The reader's own video app, not the service.
    'この動画はここでは再生できません。壊れているか、このブラウザーが対応していない形式の可能性があります。元のファイルをダウンロードして、お使いの動画アプリで開いてください。':
      ['アプリ'],
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
