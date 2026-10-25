import { describe, expect, test } from 'vitest'
import surface from './cli-reference-surface.generated.json'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_EXAMPLES,
  CLI_OUTPUT_SCHEMA_VERSION,
  CLI_REFERENCE_PUBLIC_COMMANDS,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceUsage,
  cliReferenceOptionHelp,
  cliReferenceContent,
} from './cli-reference-content'

describe('CLI reference content', () => {
  test('explains trusted download parents and per-artifact manifest failures in both locales', () => {
    const en = cliReferenceContent('en').sections.recovery.body.join('')
    const ja = cliReferenceContent('ja').sections.recovery.body.join('')
    expect(en).toContain('accepts linked output parents')
    expect(en).toContain('rechecks their resolved directory identities')
    expect(en).toContain(
      'invalid manifest paths, bodies, or identities remain per-artifact',
    )
    expect(ja).toContain('出力ルートの親がリンクでも使用でき')
    expect(ja).toContain('リンク先のディレクトリの同一性を再確認')
    expect(ja).toContain('マニフェストのパス・内容・IDの不備は成果物ごとの失敗')
  })

  test('explains fragment delivery and sharing filtered views or headings', () => {
    expect(cliReferenceContent('en').sections.basics.body).toContain(
      'Browser share pages pass their URL fragment (#) to HTML, Markdown, and static-site frames, follow changes inside them, and include it in Copy link for sharing filtered views or headings.',
    )
  })

  test.each(['en', 'ja'] as const)(
    'keeps the %s deletion example short while documenting repetition',
    (locale) => {
      const body = cliReferenceContent(locale).sections.basics.body
      expect(body).toContain('delete_path=data/old.parquet')
      expect(body).not.toMatch(/delete_path=[^\s）]+&delete_path=/)
      expect(body).toContain(
        locale === 'en' ? 'repeated delete_path' : '繰り返しの delete_path',
      )
    },
  )

  test.each(['en', 'ja'] as const)(
    'documents token import for CI in the %s introduction',
    (locale) => {
      const content = cliReferenceContent(locale)
      expect(content.sections.introduction.body).toContain(
        'profiles import-token',
      )
      expect(content.sections.introduction.body).toContain('CI')
      expect(content.commands.map((command) => command.path)).toContain(
        'profiles import-token',
      )
    },
  )

  test.each(['en', 'ja'] as const)(
    'names the runnable init command in the %s introduction',
    (locale) => {
      const content = cliReferenceContent(locale)
      expect(content.sections.introduction.body).toContain(
        CLI_REFERENCE_EXAMPLES.init,
      )
      expect(content.sections.introduction.body).not.toMatch(
        /\babove\b|上記の init コマンド/i,
      )
      expect(
        CLI_REFERENCE_PUBLIC_COMMANDS.map((command) => command.path),
      ).toContain('init')
      expect(
        content.commands.find((command) => command.path === 'init')?.example,
      ).toBe(CLI_REFERENCE_EXAMPLES.init)
    },
  )

  test('covers every generated public command in both locales', () => {
    expect(surface.schema_version).toBe(2)
    expect(surface.package_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(surface.generated_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(surface.commands).toHaveLength(52)
    expect(CLI_REFERENCE_ENTRY_POINT.path).toBe('')
    expect(CLI_REFERENCE_PUBLIC_COMMANDS).toHaveLength(51)
    const paths = CLI_REFERENCE_PUBLIC_COMMANDS.map((command) => command.path)
    expect(
      cliReferenceContent('en').commands.map((command) => command.path),
    ).toEqual(paths)
    expect(
      cliReferenceContent('ja').commands.map((command) => command.path),
    ).toEqual(paths)
    expect(Object.keys(cliReferenceContent('en').sections)).toEqual(
      CLI_REFERENCE_SECTION_IDS,
    )
    expect(Object.keys(cliReferenceContent('ja').sections)).toEqual(
      CLI_REFERENCE_SECTION_IDS,
    )
  })

  test('keeps the public contract language in both locales', () => {
    expect(CLI_OUTPUT_SCHEMA_VERSION).toBe(2)
    for (const locale of ['en', 'ja'] as const) {
      const content = cliReferenceContent(locale)
      expect(content.sections['json-exit'].body).toContain('schema_version: 2')
      expect(content.sections['json-exit'].body).toMatch(/0.*1.*130/)
      expect(content.sections.destinations.body).toContain('home_audience')
      expect(content.sections.destinations.body).toContain(
        'default_artifact_visibility',
      )
      expect(content.sections.destinations.body).toContain(
        'default_project_visibility',
      )
      expect(content.sections.destinations.body).toContain('--grant-email')
      expect(content.sections.destinations.body).toContain('user')
      expect(content.sections.destinations.body).toContain('repository')
      expect(content.sections.destinations.body).toContain('--visibility')
      expect(content.sections.destinations.body).toContain('--scope effective')
      expect(
        content.commands.find((command) => command.path === 'artifacts delete')
          ?.role,
      ).toMatch(/Alias of delete|delete の別名/)
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).toContain(
        locale === 'en'
          ? 'Empty labels, control characters, and invalid, invisible-only, or repeated --label values fail locally with validation_failed before authentication.'
          : '--label の値が空、制御文字を含む、不正、不可視文字のみ、または指定が重複している場合は、認証前にローカルで validation_failed エラーになります。',
      )
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).toContain(
        locale === 'en'
          ? 'Successful JSON includes the stored label at data.version.label, or null when omitted.'
          : '成功時の JSON は data.version.label に保存されたラベルを返し、省略時は null を返します。',
      )
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).not.toContain(
        locale === 'en'
          ? 'empty labels and control characters are rejected before authentication'
          : '空の値や制御文字は認証前に拒否します',
      )
      expect(content.commands).toHaveLength(51)
      expect(content.commands.every((command) => command.role.trim())).toBe(
        true,
      )
      expect(
        content.commands.some(
          (command) =>
            command.role === `この command は ${command.path} を実行します。`,
        ),
      ).toBe(false)
    }
  })

  test('keeps representative examples aligned with the generated surface', () => {
    const commands = new Map(
      surface.commands.map((command) => [command.path, command]),
    )
    for (const example of cliReferenceContent('en').representativeExamples) {
      const binaryMarker = '-- artifactshare '
      const cliInvocation = example.slice(
        example.indexOf(binaryMarker) + binaryMarker.length,
      )
      const tokens =
        cliInvocation
          .match(/(?:[^\s']+|'[^']*')+/g)
          ?.map((token) => token.replace(/^'|'$/g, '')) ?? []
      let matched
      let path = ''
      for (let length = Math.min(3, tokens.length); length > 0; length -= 1) {
        const candidate = tokens.slice(0, length).join(' ')
        if (commands.has(candidate)) {
          path = candidate
          matched = commands.get(candidate)
          break
        }
      }
      expect(matched, example).toBeDefined()
      for (const token of tokens.slice(path.split(' ').length)) {
        const option = token.match(/^(--[a-z0-9][a-z0-9-]*)(?:=|$)/)?.[1]
        if (option) expect(matched?.options).toContain(option)
      }
    }
  })

  test('adds parent command context when help repeats the root usage', () => {
    expect(cliReferenceUsage('', CLI_REFERENCE_ENTRY_POINT.usage)).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare [COMMANDS] <OPTIONS>',
    )
    expect(
      cliReferenceUsage('artifacts', CLI_REFERENCE_ENTRY_POINT.usage),
    ).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts [COMMANDS] <OPTIONS>',
    )
    expect(
      cliReferenceUsage(
        'artifacts get',
        'artifactshare artifacts get <OPTIONS> <artifactIdOrUrl>',
      ),
    ).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <OPTIONS> <artifactIdOrUrl>',
    )
  })

  test('renders every public usage with an explicit package binary', () => {
    for (const command of surface.commands) {
      expect(cliReferenceUsage(command.path, command.usage)).toMatch(
        /^npm exec --yes --package=@artifactshare\/cli -- artifactshare\b/,
      )
    }
  })

  test('keeps the related links labeled in both locales', () => {
    expect(
      Object.values(cliReferenceContent('en').links).map((link) => link.label),
    ).toEqual([
      'Share with AI',
      'Connect',
      'Updates',
      'Private mobile design handoff',
      'npm package',
    ])
    expect(
      Object.values(cliReferenceContent('ja').links).map((link) => link.label),
    ).toEqual([
      'AI から Artifact Share を使う',
      '接続ガイド',
      '更新情報',
      'モバイル文書の安全な引き継ぎ',
      'npm package',
    ])
  })

  test('keeps destination resolution and setting boundaries explicit', () => {
    for (const locale of ['en', 'ja'] as const) {
      const body = cliReferenceContent(locale).sections.destinations.body
      const keys =
        locale === 'en'
          ? [
              'repository home_audience',
              'repository default_artifact_visibility',
              'user home_audience',
              'user default_artifact_visibility',
              'product default workspace',
            ]
          : [
              'repository の home_audience',
              'repository の default_artifact_visibility',
              'user の home_audience',
              'user の default_artifact_visibility',
              '製品既定 workspace',
            ]
      for (let index = 1; index < keys.length; index += 1) {
        expect(body.indexOf(keys[index - 1])).toBeLessThan(
          body.indexOf(keys[index]),
        )
      }
      expect(body).toContain('.artifactshare/config.json')
      expect(body).toContain('user config')
      expect(body).toContain('default_project_visibility')
      expect(body).toMatch(/independent|独立/)
      expect(body).toMatch(/does not implicitly change|暗黙に変更しません/)
      expect(body).toMatch(/personal safe default|個人の安全な既定値/)
      expect(body).toMatch(/policy agreed|合意した方針/)
      expect(body).toMatch(/one post|一回限り/)
      expect(body).toContain('--scope effective')
    }
  })
})

test('documents agent update recovery in both locales', () => {
  expect(cliReferenceContent('en').sections.recovery.body.join('')).toContain(
    'For expected_version_required after login --preset agent, pass data.version.id from the previous successful share or update output as --expected-version when retrying update or share --key. If that output is unavailable, for single-file HTML and Markdown artifacts, artifacts get <target> --json returns the current version as data.version_id. For static sites, download <target> --json returns it as data.version.id. Check the returned current content (data.content, or the downloaded files for static sites) and reapply your changes to it if it differs from what you edited. Pass the returned value as --expected-version.',
  )
  expect(cliReferenceContent('ja').sections.recovery.body.join('')).toContain(
    'login --preset agent でログインして expected_version_required が返された場合は、前回成功した share または update の出力にある data.version.id を --expected-version に指定して、update または share --key を再実行します。前回の出力がない場合、単一ファイルの HTML・Markdown では artifacts get <target> --json が現在のバージョンを data.version_id として返します。静的サイトでは download <target> --json が data.version.id として返します。返された現在の内容（data.content、静的サイトではダウンロードしたファイル）を確認し、編集元の内容と異なる場合は、その現在の内容に変更を適用し直します。返された値を --expected-version に指定します。',
  )
  for (const locale of ['en', 'ja'] as const) {
    expect(
      cliReferenceContent(locale).representativeExamples.find((example) =>
        example.includes('artifactshare update '),
      ),
    ).toContain('--expected-version <version-id>')
  }
})

test.each(['en', 'ja'] as const)(
  'documents edit project visibility in %s',
  (locale) => {
    const body = cliReferenceContent(locale).sections.destinations.body
    expect(body).toContain('edit')
    expect(body).toContain('--visibility private|workspace|project|link')
    expect(body).toContain(
      locale === 'en'
        ? 'requires the artifact to be in a project after the edit'
        : '編集後の保存先がプロジェクトであることが必要',
    )
  },
)

test.each(['en', 'ja'] as const)(
  'publisher reference covers expanded API scope in %s',
  (locale) => {
    const body = cliReferenceContent(locale).sections.introduction.body
    for (const field of [
      'base_version',
      'delete_path',
      'retain_versions',
      'publisher_client_id',
      'whoami/doctor',
      '/api/cli/artifacts/:id/adopt',
      'POST/PATCH',
    ])
      expect(body).toContain(field)
    expect(body).toContain(locale === 'en' ? 'metadata-only' : 'メタデータだけ')
    expect(body).toContain(
      locale === 'en' ? 'workflows are unsupported' : '対応していません',
    )
  },
)

test('publisher-specific download and read responses are explicitly scoped', () => {
  const en = cliReferenceContent('en').sections.introduction.body
  expect(en).toContain(
    'With a publisher credential, the exact download endpoint returns source bytes',
  )
  expect(en).toContain(
    'With a publisher credential, readback includes visibility',
  )
  const ja = cliReferenceContent('ja').sections.introduction.body
  expect(ja).toContain(
    'publisher の資格では、download は単一ファイルなら元データ',
  )
  expect(ja).toContain('publisher の資格では、個別アセットの取得はできません。')
  expect(ja).toContain(
    'publisher の資格では、内容を取得すると共有範囲も返し、静的サイトではメタデータだけを返します',
  )
  expect(ja).not.toContain('readback')
})

test('retention option localization is scoped to the edit command', () => {
  const help =
    '--retain-versions <retain-versions> N or all (owner only). Keeps the latest N versions; publisher-managed artifacts count only publisher versions and keep all versions people added. Older eligible versions are permanently deleted; all clears the limit.'
  expect(
    surface.commands.find((command) => command.path === 'edit')?.option_help,
  ).toContain(help)
  expect(cliReferenceOptionHelp('edit', help, 'ja')).toBe(
    '--retain-versions <retain-versions> N または all(持ち主のみ)。最新の N 版を残します。publisher の資格で作成したファイル、または publisher のクライアントに割り当てられたファイルでは、publisher の資格で追加した版だけを数え、人が追加した版はすべて残します。対象となる古い版の削除は取り消せません。all で制限を外します。',
  )
  expect(cliReferenceOptionHelp('edit', help, 'en')).toBe(help)
  expect(cliReferenceOptionHelp('share', help, 'ja')).toBe(help)
  expect(
    cliReferenceOptionHelp(
      'edit',
      '--visibility <visibility> private or link',
      'ja',
    ),
  ).toBe('--visibility <visibility> private or link')
})

test.each(['en', 'ja'] as const)(
  'publisher retention guidance explains owner edits and historical clients in %s',
  (locale) => {
    const guidance = cliReferenceContent(locale).sections.introduction.body
    const policy =
      locale === 'en'
        ? [
            'On artifacts created by or assigned to a publisher client',
            'including earlier clients',
            'keeps every other version',
            'This also applies to unrestricted owner edits.',
            'drafts do not count.',
            'Unmanaged artifacts continue to count all published versions.',
          ]
        : [
            'publisher の資格で作成したファイル、または publisher のクライアントに割り当てられたファイル',
            '以前のクライアントによる版も含め',
            '人が追加した版はすべて残します。',
            'このルールは所有者が unrestricted 資格情報で設定するときも同じです。',
            '下書きは数えません。',
            'それ以外のファイルでは、これまでどおりすべての公開版を数えます。',
          ]
    for (const explanation of policy) expect(guidance).toContain(explanation)
  },
)

test.each(['en', 'ja'] as const)(
  'documents upload boundary recovery in %s',
  (locale) => {
    const recovery = cliReferenceContent(locale).sections.recovery.body.join('')
    expect(recovery).toContain(
      locale === 'en'
        ? 'Check missing paths, pass an absolute path for outside_cwd, retry changed selections, and follow the named guarantee or file-type hint.'
        : '見つからないパスは確認し、outside_cwd では絶対パスを指定し、読み取り中の変更は再試行し、保証やファイル種別の問題は個別のヒントに従います。',
    )
    expect(recovery).toContain(
      locale === 'en'
        ? 'For validation_failed without a details.reason, check usage and options.'
        : 'details.reason がない validation_failed は構文と option を確認します。',
    )
    expect(recovery).not.toContain(
      locale === 'en'
        ? 'For validation_failed, check usage and options.'
        : '。validation_failed は構文と option を確認します。',
    )
    const content = JSON.stringify(cliReferenceContent(locale))
    for (const term of [
      'details.path',
      'details.reason',
      'parent_traversal',
      'link',
      'outside_cwd',
      'not_found',
      'changed',
      'unsupported_guarantee',
      'invalid_type',
      'upload_read_failed',
      'details.errno',
      'POSIX',
      'Windows',
      'lstat',
    ])
      expect(content).toContain(term)
    expect(content).toContain(
      locale === 'en' ? 'direct absolute path' : '直接の絶対パス',
    )
    expect(content).toContain(
      locale === 'en'
        ? 'authentication retries reuse verified content'
        : '認証の再試行では検証済みの内容を再利用',
    )
  },
)

test('names parent-directory references clearly in Japanese recovery guidance', () => {
  const recovery = cliReferenceContent('ja').sections.recovery.body.join('')
  expect(recovery).toContain('親ディレクトリ参照（..）を含むパスは使えません。')
  expect(recovery).not.toContain('。.. を')
})

test.each(['en', 'ja'] as const)(
  'documents local write recovery in %s',
  (locale) => {
    const content = cliReferenceContent(locale)
    expect(content.sections.recovery.body.join('')).toContain('^[a-z0-9]{10}$')
    expect(content.sections.recovery.body.join('')).toContain(
      'data.backup_paths',
    )
    expect(content.sections.recovery.body.join('')).toContain(
      'git_exclude_warning',
    )
    const download = surface.commands.find(
      (command) => command.path === 'download',
    )!
    expect(download.option_help).toEqual([
      '--force Replace existing output; retain backups for recovery',
    ])
  },
)

test('download recovery describes boundary refusals and retained originals in both locales', () => {
  const en = cliReferenceContent('en').sections.recovery.body.join('')
  expect(en).toContain(
    'Linked output roots, indexes, and listed artifact trees are refused',
  )
  expect(en).toContain('including unchanged versions')
  expect(en).toContain(
    'Successful replacements retain originals and previous indexes',
  )
  expect(en).toContain('every boundary violation stops further publication')
  const ja = cliReferenceContent('ja').sections.recovery.body.join('')
  expect(ja).toContain('リンクは --force でも拒否')
  expect(ja).toContain('変更のない成果物を含む全対象')
  expect(ja).toContain('置換前のデータと index は成功後も保持')
  expect(ja).toContain('後続の成果物と最終 index の公開を中断')
})

test.each(['en', 'ja'] as const)(
  'splits recovery into four ordered topics with error remedies in %s',
  (locale) => {
    const paragraphs = cliReferenceContent(locale).sections.recovery.body
    expect(paragraphs).toHaveLength(4)
    const starts =
      locale === 'en'
        ? [
            'Download IDs',
            'When saving configuration, init refuses linked or changed config paths.',
            'Files named by another spelling',
            'For auth_required or token_invalid',
          ]
        : [
            'download の ID',
            '設定保存時の init',
            'Windows の短い名前など、別の綴りで指定したファイル',
            'auth_required または token_invalid',
          ]
    paragraphs.forEach((paragraph, index) => {
      expect(paragraph.trim().length).toBeGreaterThan(0)
      expect(paragraph.startsWith(starts[index])).toBe(true)
    })
    expect(paragraphs[0]).toContain('data.backup_paths')
    expect(paragraphs[1]).toContain('git_exclude_warning')
    expect(paragraphs[2]).toContain('upload_read_failed')
    expect(paragraphs[2]).toContain('details.reason')
    if (locale === 'ja') {
      expect(paragraphs[1]).toContain(
        '.git ファイル、リンク、.git の中の gitdir や commondir のファイル、安全に更新できない exclude は',
      )
      for (const fact of [
        'Windows の短い名前など、別の綴りで指定したファイルは、保存されている本来の名前から種類と content type を決めます。',
        '途中に通常のファイルを含む相対パス（例: file.txt/x）は not_found になります。',
        'ドット（.）で始まる名前と除外対象は、検査の前に省きます。',
      ]) {
        expect(paragraphs[2]).toContain(fact)
      }
    }
    if (locale === 'en') {
      expect(paragraphs[1]).toContain(
        '.git files, links, gitdir or commondir files inside .git, and unsafe exclude paths',
      )
      for (const fact of [
        'Files named by another spelling (such as Windows short names) use their stored names for kind and content type',
        'relative paths with a regular file in the middle (for example file.txt/x) are not_found.',
        'Names that start with a dot (.) and excluded names are skipped before inspection.',
      ]) {
        expect(paragraphs[2]).toContain(fact)
      }
    }
    const errors = paragraphs[3]
    for (const code of [
      'unknown_option',
      'invalid_expected_version',
      'unsupported_node_version',
    ]) {
      expect(errors.split(code)).toHaveLength(2)
    }
    for (const fact of [
      'details.option',
      'data.version.id',
      'data.version_id',
      'artifacts get <target> --json',
      'recovery.kind: change_input',
      '22.19.0',
      'recovery.kind: ask_human',
      'agent_recoverable: false',
      'requires_human: true',
      'expected_version_required',
    ]) {
      expect(errors).toContain(fact)
    }
    expect(errors).toContain(
      locale === 'en'
        ? 'correct details.option using the hint or command help; options are checked before authentication, requests or writes.'
        : 'unknown_option は認証・通信・書き込みの前に返されます。details.option をヒントやコマンドのヘルプに従って修正してください。',
    )
    expect(errors).toContain(
      locale === 'en'
        ? 'use a version id from data.version.id in share/update output or data.version_id from artifacts get <target> --json, rather than a number.'
        : '番号ではなく、share/update の出力の data.version.id、または artifacts get <target> --json の data.version_id を指定します。',
    )
    expect(errors).toContain(
      locale === 'en'
        ? 'upgrade Node.js to 22.19.0 or newer; this requires human or environment action'
        : 'Node.js を 22.19.0 以上に更新してください。人または実行環境側の対応が必要です',
    )
    if (locale === 'en')
      expect(paragraphs.join(' ')).not.toContain('Config-mode')
  },
)
