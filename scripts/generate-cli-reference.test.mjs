import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandPathsFromHelp,
  extractCommandExamples,
  generateSurface,
  parseHelp,
  validateCommandCoverage,
  validateDocumentExamples,
  DOCUMENT_PATHS,
  CLI_REFERENCE_PACKAGE_VERSION,
  CLI_SURFACE_SCHEMA_VERSION,
  compareSurfaceSnapshots,
  isRealIsoDate,
  utcDate,
  executableCommandPaths,
  agentSurfaceKeys,
  validateCapabilityMatrix,
  validateLiteralDuplication,
} from './generate-cli-reference.mjs'

const HELP = `Artifact Share CLI
USAGE:
  artifactshare comments <OPTIONS>

COMMANDS:
  [comments] <OPTIONS>       Comment commands
  list <OPTIONS>              List comments
  post <OPTIONS>              Post a comment

OPTIONS:
  -h, --help                 Display this help message
  --json                     Print stable JSON output
  --thread-id <thread-id>    Thread ID
`

test('parseHelp extracts deterministic usage and long option names', () => {
  assert.deepEqual(parseHelp(HELP), {
    usage: 'artifactshare comments <OPTIONS>',
    options: ['--help', '--json', '--thread-id'],
  })
})

test('commandPathsFromHelp ignores the parent marker', () => {
  assert.deepEqual(commandPathsFromHelp(HELP), ['list', 'post'])
})

test('generateSurface discovers nested commands from help', async () => {
  const helps = new Map([
    [
      '',
      `USAGE:\n  artifactshare <OPTIONS>\n\nCOMMANDS:\n  comments <OPTIONS>\n`,
    ],
    ['comments', HELP],
    [
      'comments list',
      'USAGE:\n  artifactshare comments list <OPTIONS>\n\nOPTIONS:\n  --json x\n',
    ],
    [
      'comments post',
      'USAGE:\n  artifactshare comments post <OPTIONS>\n\nOPTIONS:\n  --json x\n',
    ],
  ])
  assert.deepEqual(
    await generateSurface({ run: (args) => helps.get(args.join(' ')) }),
    {
      schema_version: CLI_SURFACE_SCHEMA_VERSION,
      package_version: CLI_REFERENCE_PACKAGE_VERSION,
      commands: [
        { path: '', usage: 'artifactshare <OPTIONS>', options: [] },
        {
          path: 'comments',
          usage: 'artifactshare comments <OPTIONS>',
          options: ['--help', '--json', '--thread-id'],
        },
        {
          path: 'comments list',
          usage: 'artifactshare comments list <OPTIONS>',
          options: ['--json'],
        },
        {
          path: 'comments post',
          usage: 'artifactshare comments post <OPTIONS>',
          options: ['--json'],
        },
      ],
    },
  )
})

test('generateSurface caches raw help for downstream capability checks', async () => {
  const helpCache = new Map()
  let runs = 0
  await generateSurface({
    helpCache,
    run: (args) => {
      runs += 1
      return args.length
        ? 'USAGE:\n  artifactshare share <OPTIONS>\n\nOPTIONS:\n  --json x\n'
        : 'USAGE:\n  artifactshare <OPTIONS>\n\nCOMMANDS:\n  share <OPTIONS>\n'
    },
  })

  assert.equal(runs, 2)
  assert.match(helpCache.get(''), /artifactshare <OPTIONS>/)
  assert.match(helpCache.get('share'), /--json/)

  await generateSurface({
    helpCache,
    run: () => {
      throw new Error('cached help must be reused')
    },
  })
  assert.equal(runs, 2)
})

test('generated metadata uses the UTC date supplied at write time', async () => {
  assert.equal(utcDate(new Date('2026-07-18T23:30:00.000Z')), '2026-07-18')
  assert.deepEqual(
    await generateSurface({
      run: (args) =>
        new Map([['', 'USAGE:\n  artifactshare <OPTIONS>\n']]).get(
          args.join(' '),
        ),
      generatedDate: '2026-07-18',
    }),
    {
      schema_version: CLI_SURFACE_SCHEMA_VERSION,
      package_version: CLI_REFERENCE_PACKAGE_VERSION,
      generated_date: '2026-07-18',
      commands: [{ path: '', usage: 'artifactshare <OPTIONS>', options: [] }],
    },
  )
})

test('generated dates accept real past dates without requiring today', () => {
  assert.equal(isRealIsoDate('2026-07-18'), true)
  assert.equal(isRealIsoDate('2026-02-29'), false)
  assert.equal(isRealIsoDate('2026-13-01'), false)
  assert.equal(isRealIsoDate('not-a-date'), false)
})

test('surface comparison accepts a valid past generated date', () => {
  const generated = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    package_version: CLI_REFERENCE_PACKAGE_VERSION,
    commands: [{ path: '', usage: 'artifactshare <OPTIONS>', options: [] }],
  }
  const committed = { ...generated, generated_date: '2026-07-18' }

  assert.deepEqual(compareSurfaceSnapshots(generated, committed), {
    generatedDateIsValid: true,
    deterministicFieldsMatch: true,
  })
})

test('surface comparison rejects invalid dates and deterministic field changes', () => {
  const generated = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    package_version: CLI_REFERENCE_PACKAGE_VERSION,
    commands: [{ path: '', usage: 'artifactshare <OPTIONS>', options: [] }],
  }
  const committed = { ...generated, generated_date: '2026-07-18' }

  assert.deepEqual(
    compareSurfaceSnapshots(generated, {
      ...committed,
      generated_date: '2026-02-29',
    }),
    { generatedDateIsValid: false, deterministicFieldsMatch: true },
  )
  assert.deepEqual(
    compareSurfaceSnapshots(generated, {
      ...committed,
      commands: [
        { path: '', usage: 'artifactshare --changed <OPTIONS>', options: [] },
      ],
    }),
    { generatedDateIsValid: true, deterministicFieldsMatch: false },
  )
})

test('document examples are checked against the committed surface', () => {
  const snapshot = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    commands: [
      {
        path: 'share',
        usage: 'artifactshare share <OPTIONS>',
        options: ['--json', '--home'],
      },
    ],
  }
  assert.deepEqual(
    extractCommandExamples(
      '`npm exec --yes --package=@artifactshare/cli -- artifactshare share report.md --home --json`',
    ),
    [['share', 'report.md', '--home', '--json']],
  )
  assert.deepEqual(
    validateDocumentExamples(snapshot, {
      README: '`artifactshare share report.md --home --json`',
    }),
    [],
  )
  assert.match(
    validateDocumentExamples(snapshot, {
      README: '`artifactshare share report.md --unknown`',
    })[0],
    /unknown option --unknown/,
  )
})

test('README and internal reference cover every public command path', () => {
  const snapshot = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    commands: [{ path: 'share', usage: '', options: [] }],
  }
  assert.deepEqual(validateCommandCoverage(snapshot, { README: '`share`' }), [])
  assert.match(
    validateCommandCoverage(snapshot, { README: '`update`' })[0],
    /missing public command path share/,
  )
})

test('root validation includes the public CLI reference content source', () => {
  assert.ok(
    DOCUMENT_PATHS.includes('apps/web/app/lib/cli-reference-content.ts'),
  )
})

const validMatrix = (overrides = {}) => ({
  surfaces: [
    { id: 'cli_help' },
    { id: 'cli_readme' },
    { id: 'bundled_skill' },
    { id: 'generated_snapshot' },
    { id: 'agent_surface' },
    { id: 'mcp_tools' },
    {
      id: 'changelog',
      default: { kind: 'out_of_scope', reason: 'release only' },
    },
    {
      id: 'public_updates',
      default: { kind: 'out_of_scope', reason: 'release only' },
    },
  ],
  contracts: [
    {
      id: 'contract',
      implementation_path: 'impl.ts',
      identifier: 'REAL_CONTRACT',
    },
  ],
  capabilities: [
    {
      id: 'share',
      cli_commands: ['share'],
      cli_options: {
        share: ['--json', '--token'],
      },
      mcp_tools: ['share_artifact'],
      contracts: ['contract'],
      surfaces: {
        cli_help: { kind: 'generated', source: 'cli.js', identifier: 'share' },
        cli_readme: {
          kind: 'reference',
          path: 'readme.md',
          identifier: 'share',
        },
        bundled_skill: {
          kind: 'out_of_scope',
          reason: 'この fixture では対象外',
        },
        generated_snapshot: {
          kind: 'generated',
          source: 'snapshot.json',
          identifier: 'share',
        },
        agent_surface: {
          kind: 'out_of_scope',
          reason: 'この fixture では対象外',
        },
        mcp_tools: {
          kind: 'reference',
          path: 'mcp.ts',
          identifier: 'share_artifact',
          scope: { kind: 'mcp_tool', name: 'share_artifact' },
          recovery_identifier: 'If it fails, inspect the returned error',
          contract_identifiers: {
            mcp_name: ["'share_artifact'"],
            mcp_description: ['Share an artifact'],
            mcp_input: ['content'],
            mcp_output: ['id'],
            mcp_recovery: ['If it fails, inspect the returned error'],
          },
        },
      },
      owners: {
        cli_command: ['cli_help'],
        cli_option: ['cli_help'],
        cli_json: ['cli_help'],
        cli_auth: ['cli_help'],
        mcp_name: ['mcp_tools'],
        mcp_description: ['mcp_tools'],
        mcp_input: ['mcp_tools'],
        mcp_output: ['mcp_tools'],
        mcp_recovery: ['mcp_tools'],
      },
    },
  ],
  ...overrides,
})
const injectedMcpSource = `server.registerTool(
    'share_artifact',
    {
      description: toolDescription('Share an artifact. If it fails, inspect the returned error.'),
      inputSchema: {
        content: z.string()
      },
      outputSchema: {
        id: z.string()
      }
    }
  )`
const injectedFiles = {
  'impl.ts': 'REAL_CONTRACT',
  'cli.js': 'share',
  'readme.md': 'share',
  'snapshot.json': 'share',
  'mcp.ts': injectedMcpSource,
}
const injected = (matrix) =>
  validateCapabilityMatrix({
    matrix,
    snapshot: {
      commands: [{ path: 'share', options: ['--json', '--token'] }],
    },
    mcpSource: injectedMcpSource,
    readFile: (path) => injectedFiles[path] ?? '',
  })

test('negative control: a missing CLI capability row fails', () => {
  const errors = validateCapabilityMatrix({
    matrix: validMatrix(),
    snapshot: { commands: [{ path: 'share' }, { path: 'update' }] },
    mcpSource: "registerTool('share_artifact', {})",
    readFile: (path) => injectedFiles[path] ?? '',
  })
  assert.ok(
    errors.some((error) => error.includes('missing CLI command: update')),
  )
})

test('negative control: a missing agent surface key fails', () => {
  const errors = validateCapabilityMatrix({
    matrix: validMatrix(),
    snapshot: { commands: [{ path: 'share' }] },
    mcpSource: "registerTool('share_artifact', {})",
    agentSource:
      "export const AGENT_CAPABILITIES = ['share-html-page'] as const",
    readFile: (path) => injectedFiles[path] ?? '',
  })
  assert.ok(
    errors.some((error) =>
      error.includes('missing agent surface key: share-html-page'),
    ),
  )
  assert.deepEqual(
    agentSurfaceKeys(
      "export const AGENT_CAPABILITIES = ['share-html-page'] as const",
    ),
    ['share-html-page'],
  )
})

test('negative control: an agent surface key requires a discovery owner', () => {
  const matrix = structuredClone(validMatrix())
  matrix.capabilities[0].agent_surface_keys = ['share-html-page']
  delete matrix.capabilities[0].owners.discovery
  const errors = injected(matrix, {
    agentSource: `export const AGENT_CAPABILITIES = [
  'share-html-page',
] as const`,
  })
  assert.ok(
    errors.some((error) => error.includes('missing owner for discovery')),
  )
})

test('negative control: an empty cell and empty out_of_scope reason fail', () => {
  const row = validMatrix().capabilities[0]
  const errors = injected(
    validMatrix({
      capabilities: [
        {
          ...row,
          surfaces: {
            ...row.surfaces,
            bundled_skill: null,
            agent_surface: { kind: 'out_of_scope', reason: '' },
          },
        },
      ],
    }),
  )
  assert.ok(errors.some((error) => error.includes('empty bundled_skill')))
  assert.ok(errors.some((error) => error.includes('empty out_of_scope reason')))
})

test('negative control: only release surfaces may define defaults', () => {
  const matrix = validMatrix()
  matrix.surfaces[0].default = { kind: 'out_of_scope', reason: 'invalid' }
  assert.ok(
    injected(matrix).some((error) =>
      error.includes('only release surfaces may define a default'),
    ),
  )
})

test('negative control: a contract must be mapped exactly once and exist', () => {
  assert.ok(
    injected(
      validMatrix({
        contracts: [
          {
            id: 'contract',
            implementation_path: 'impl.ts',
            identifier: 'MISSING',
          },
        ],
      }),
    ).some((e) => e.includes('missing contract implementation')),
  )
})

test('negative control: reference identifier must exist in injected file', () => {
  assert.ok(
    injected(
      validMatrix({
        capabilities: [
          {
            ...validMatrix().capabilities[0],
            surfaces: {
              ...validMatrix().capabilities[0].surfaces,
              mcp_tools: {
                kind: 'reference',
                path: 'mcp.ts',
                identifier: 'missing',
              },
            },
          },
        ],
      }),
    ).some((e) => e.includes('missing reference identifier')),
  )
})

test('negative control: generated identifier must exist in generated source', () => {
  assert.ok(
    injected(
      validMatrix({
        capabilities: [
          {
            ...validMatrix().capabilities[0],
            surfaces: {
              ...validMatrix().capabilities[0].surfaces,
              cli_help: {
                kind: 'generated',
                source: 'cli.js',
                identifier: 'missing',
              },
            },
          },
        ],
      }),
    ).some((e) => e.includes('missing generated identifier')),
  )
})

test('negative control: CLI, MCP, and contract identifiers are unique', () => {
  const row = validMatrix().capabilities[0]
  const errors = injected(
    validMatrix({
      capabilities: [row, { ...row, id: 'other', contracts: ['contract'] }],
    }),
  )
  assert.ok(
    errors.some((error) => error.includes('duplicate capability identifier')),
  )
  assert.ok(
    errors.some((error) => error.includes('contract mapped more than once')),
  )
})

test('negative control: duplicate and forbidden owners fail independently', () => {
  const row = validMatrix().capabilities[0]
  const duplicate = structuredClone(validMatrix())
  duplicate.capabilities[0].owners.cli_command = ['cli_help', 'cli_help']
  assert.ok(
    injected(duplicate).some((error) => error.includes('duplicate owner')),
  )

  const forbidden = structuredClone(validMatrix())
  forbidden.capabilities[0].owners.mcp_description = ['agent_surface']
  assert.ok(
    injected(forbidden).some((error) =>
      error.includes('mcp_description cannot be owned by agent_surface'),
    ),
  )
})

test('negative control: get_artifact read-back identifiers are required', () => {
  const matrix = structuredClone(validMatrix())
  matrix.capabilities[0].mcp_tools = ['get_artifact']
  matrix.capabilities[0].surfaces.mcp_tools = {
    kind: 'reference',
    path: 'mcp.ts',
    identifiers: ["'get_artifact'"],
    scoped_identifiers: [
      'outputSchema: GET_ARTIFACT_OUTPUT_SCHEMA',
      'If the response sets truncated:true',
    ],
    file_scope: {
      kind: 'const_object',
      name: 'GET_ARTIFACT_OUTPUT_SCHEMA',
    },
    file_identifiers: ['content', 'version_id', 'truncated', 'next_offset'],
    scope: { kind: 'mcp_tool', name: 'get_artifact' },
  }
  const errors = validateCapabilityMatrix({
    matrix,
    snapshot: { commands: [{ path: 'share' }] },
    mcpSource: `const GET_ARTIFACT_OUTPUT_SCHEMA = {
  content: z.string(),
  version_id: z.string(),
  truncated: z.boolean()
}

const UNRELATED_OUTPUT_SCHEMA = {
  next_offset: z.number().nullable()
}

server.registerTool(
    'get_artifact',
    {
      description: 'If the response sets truncated:true',
      outputSchema: GET_ARTIFACT_OUTPUT_SCHEMA
    }
  )`,
    readFile: (path) =>
      path === 'mcp.ts'
        ? `const GET_ARTIFACT_OUTPUT_SCHEMA = {
  content: z.string(),
  version_id: z.string(),
  truncated: z.boolean()
}

const UNRELATED_OUTPUT_SCHEMA = {
  next_offset: z.number().nullable()
}

server.registerTool(
    'get_artifact',
    {
      description: 'If the response sets truncated:true',
      outputSchema: GET_ARTIFACT_OUTPUT_SCHEMA
    }
  )`
        : (injectedFiles[path] ?? ''),
  })
  assert.ok(
    errors.some((error) =>
      error.includes('missing file reference identifier next_offset'),
    ),
  )
})

test('negative control: every owned MCP contract is structurally required', () => {
  const matrix = structuredClone(validMatrix())
  matrix.capabilities[0].surfaces.mcp_tools.scope = {
    kind: 'mcp_tool',
    name: 'share_artifact',
  }
  matrix.capabilities[0].surfaces.mcp_tools.recovery_identifier =
    'If it fails, inspect the returned error'
  matrix.capabilities[0].surfaces.mcp_tools.contract_identifiers = {
    mcp_name: ["'share_artifact'"],
    mcp_description: ['Share an artifact'],
    mcp_input: ['content'],
    mcp_output: ['id'],
    mcp_recovery: ['If it fails, inspect the returned error'],
  }
  const validBlock = `server.registerTool(
    'share_artifact',
    {
      description: toolDescription('Share an artifact. If it fails, inspect the returned error.'),
      inputSchema: {
        content: z.string()
      },
      outputSchema: {
        id: z.string()
      }
    }
  )`
  const validateBlock = (mcpSource) =>
    validateCapabilityMatrix({
      matrix,
      snapshot: {
        commands: [{ path: 'share', options: ['--json', '--token'] }],
      },
      mcpSource,
      readFile: (path) =>
        path === 'mcp.ts' ? mcpSource : (injectedFiles[path] ?? ''),
    })
  assert.deepEqual(validateBlock(validBlock), [])
  for (const [contract, changed] of [
    [
      'mcp_description',
      validBlock.replace('Share an artifact', 'Publish content'),
    ],
    ['mcp_input', validBlock.replace('content:', 'source:')],
    [
      'mcp_input',
      validBlock.replace(
        'content: z.string()',
        'content: z.string(),\n        extra: z.string()',
      ),
    ],
    ['mcp_output', validBlock.replace('outputSchema:', 'outputContract:')],
    [
      'mcp_output',
      validBlock.replace(
        'id: z.string()',
        'id: z.string(),\n        extra: z.string()',
      ),
    ],
    [
      'mcp_recovery',
      validBlock.replace(
        'If it fails, inspect the returned error.',
        'No recovery guidance.',
      ),
    ],
  ])
    assert.ok(
      validateBlock(changed).some((error) => error.includes(contract)),
      contract,
    )
})

test('negative control: CLI option, JSON, and auth contracts are required', () => {
  const matrix = structuredClone(validMatrix())
  const validateCli = ({ options, help }) =>
    validateCapabilityMatrix({
      matrix,
      snapshot: { commands: [{ path: 'share', options }] },
      mcpSource: "registerTool('share_artifact', {})",
      cliHelp: () => help,
      readFile: (path) => injectedFiles[path] ?? '',
    })
  const validHelp = `OPTIONS:
  --json      Print stable JSON output
  --token     Bearer token`
  assert.ok(
    validateCli({ options: ['--json', '--token'], help: '' }).some((error) =>
      error.includes('cli_option'),
    ),
  )
  assert.ok(
    validateCli({ options: ['--token'], help: validHelp }).some((error) =>
      error.includes('cli_json'),
    ),
  )
  assert.ok(
    validateCli({ options: ['--json'], help: validHelp }).some((error) =>
      error.includes('cli_auth'),
    ),
  )
})

test('literal duplication uses eighty characters and supports allowances', () => {
  const source = `${'長い説明文'.repeat(20)}。`
  assert.equal(
    validateLiteralDuplication({ source, reference: source }).length,
    1,
  )
  assert.deepEqual(
    validateLiteralDuplication({
      source,
      reference: source,
      allowances: [{ text: source }],
    }),
    [],
  )
  assert.deepEqual(
    validateLiteralDuplication({ source, reference: 'unrelated change' }),
    [],
  )
  const copied = '連続する説明文'.repeat(12)
  assert.equal(
    validateLiteralDuplication({
      source: `異なる前置き。${copied}異なる後置き。`,
      reference: `別の前置き。${copied}別の後置き。`,
    }).length,
    1,
  )
  assert.equal(
    validateLiteralDuplication({
      source: `短い文。${'文をまたぐ連続部分'.repeat(10)}。`,
      reference: `短い文。${'文をまたぐ連続部分'.repeat(10)}。`,
    }).length,
    1,
  )
  assert.equal(
    validateLiteralDuplication({
      source: `${'箇条書きにも残す説明'.repeat(10)}。`,
      reference: `- ${'箇条書きにも残す説明'.repeat(10)}。`,
    }).length,
    1,
  )
})

test('negative control: the matrix checker reads owner and reference files for prose duplication', () => {
  const matrix = structuredClone(validMatrix())
  const prose = `${'複製してはいけない説明'.repeat(10)}。`
  const errors = validateCapabilityMatrix({
    matrix,
    snapshot: { commands: [{ path: 'share' }] },
    mcpSource: "registerTool('share_artifact', {})",
    readFile: (path) => {
      if (path === 'mcp.ts') return `share_artifact ${prose}`
      if (path === 'readme.md') return `share ${prose}`
      return injectedFiles[path] ?? ''
    },
  })
  assert.ok(errors.some((error) => error.includes('literal prose duplication')))
})

test('literal duplication ignores explicit executable command lines', () => {
  const command =
    'npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --project-id example --json'
  assert.deepEqual(
    validateLiteralDuplication({ source: command, reference: command }),
    [],
  )
})

test('CLI help owner prose is checked without scanning its generated bundle', () => {
  const matrix = structuredClone(validMatrix())
  matrix.capabilities[0].surfaces.mcp_tools = {
    kind: 'out_of_scope',
    reason: 'この fixture では対象外',
  }
  matrix.capabilities[0].mcp_tools = null
  for (const owner of [
    'mcp_name',
    'mcp_description',
    'mcp_input',
    'mcp_output',
    'mcp_recovery',
  ])
    delete matrix.capabilities[0].owners[owner]
  const prose = `${'生成物からは検査しない説明'.repeat(10)}。`
  const errors = validateCapabilityMatrix({
    matrix,
    snapshot: { commands: [{ path: 'share' }] },
    mcpSource: '',
    cliHelp: () => `share ${prose}`,
    readFile: (path) =>
      path === 'cli.js' || path === 'readme.md'
        ? `share ${prose}`
        : (injectedFiles[path] ?? ''),
  })
  assert.ok(errors.some((error) => error.includes('literal prose duplication')))
})

test('unrelated reference content succeeds', () => {
  assert.deepEqual(injected(validMatrix()), [])
})
