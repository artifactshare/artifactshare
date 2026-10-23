import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'

const vitest =
  /(?:^|[/])(?:(?:vitest|vite-plus\/test|@voidzero-dev\/vite-plus-test)(?:[/]|$)|@vitest[/])/u

const sdk = /@modelcontextprotocol\/sdk(?:\/|$)/u
const oauthClient =
  /@modelcontextprotocol\/sdk\/(?:dist\/(?:esm|cjs)\/)?client\//u

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(file) : [file]
    }),
  )
  return files.flat().sort()
}

function importSpecifiers(program) {
  const imports = []
  const dynamicImports = []
  function record(source) {
    if (typeof source?.value === 'string') imports.push(source.value)
    else if (
      source?.type === 'TemplateLiteral' &&
      source.expressions.length === 0
    )
      imports.push(source.quasis[0].value.cooked)
    else dynamicImports.push(source)
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(node.type) &&
      node.source
    ) {
      record(node.source)
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'require') {
      record(node.arguments[0])
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(program)
  return { imports, dynamicImports }
}

// Reads every server chunk, including lazy chunks, not just the entrypoint.
// The default build uses development bindings. For deployment evidence run
// VITE_SOURCEMAP=1 pnpm --filter @artifactshare/web build:production first.
// The command below consumes and removes that build, even if analysis fails.
export async function checkBundles(buildRoot) {
  const report = []
  let serverSdkModules = 0
  for (const target of ['server', 'client']) {
    const files = (await filesUnder(path.join(buildRoot, target))).filter(
      (file) => /\.[cm]?js$/u.test(file),
    )
    assert(files.length > 0, `Missing ${target} JavaScript build evidence`)
    let moduleCount = 0
    for (const file of files) {
      const code = await readFile(file, 'utf8')
      const parsed = parseSync(file, code)
      assert.equal(
        parsed.errors.length,
        0,
        `Cannot parse emitted JavaScript: ${file}`,
      )
      const { imports, dynamicImports } = importSpecifiers(parsed.program)
      let sources
      try {
        const map = JSON.parse(await readFile(`${file}.map`, 'utf8'))
        assert.equal(map.version, 3, `Invalid source map: ${file}`)
        assert(
          Array.isArray(map.sources) &&
            map.sources.length > 0 &&
            map.sources.every((source) => typeof source === 'string'),
          `Missing source modules: ${file}`,
        )
        sources = map.sources.map((source) =>
          `${map.sourceRoot ?? ''}/${source}`.replaceAll('\\', '/'),
        )
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        // Rolldown emits mapless facade chunks containing only imports and
        // re-exports. Their complete behavior is visible in the emitted AST.
        const facade =
          parsed.program.body.length > 0 &&
          parsed.program.body.every(
            (node) =>
              node.type === 'ImportDeclaration' ||
              node.type === 'ExportAllDeclaration' ||
              (node.type === 'ExportNamedDeclaration' && !node.declaration),
          )
        const empty = parsed.program.body.length === 0
        let manifest = false
        const prefix = 'window.__reactRouterManifest='
        if (target === 'client' && code.startsWith(prefix)) {
          // JSON parsing rejects executable expressions and trailing code.
          JSON.parse(code.slice(prefix.length).trim().replace(/;$/u, ''))
          manifest = true
        }
        // Reviewed Rolldown interop helpers: Object property copying, ESM/CJS
        // wrappers, and exports only. Match content, never just the filename;
        // a changed runtime must be inspected again before accepting it.
        const runtime =
          createHash('sha256').update(code).digest('hex') ===
          'bd162d053a2002dbfcd9a76e8e10228715c3b056862d0d385090f23d9985efad'
        if (
          !empty &&
          !manifest &&
          !runtime &&
          (!facade || imports.length === 0)
        )
          throw error
        assert(
          imports.every(
            (specifier) =>
              specifier.startsWith('.') &&
              files.includes(path.resolve(path.dirname(file), specifier)),
          ),
          `Unresolved mapless facade import: ${file}`,
        )
        sources = []
        report.push(
          `${target} ${path.relative(buildRoot, file)}: mapless ${empty ? 'empty chunk' : manifest ? 'JSON route manifest' : runtime ? 'reviewed Rolldown runtime' : 'import/re-export facade'} verified from emitted code`,
        )
      }
      // Runtime-selected framework imports cannot be resolved from a static
      // build. Report them explicitly; scanning all chunks still covers every
      // emitted module, but does not prove arbitrary runtime targets absent.
      for (const expression of dynamicImports) {
        const emitted = code.slice(expression.start, expression.end)
        assert(
          target !== 'server' || !emitted.includes('@modelcontextprotocol/sdk'),
          `Dynamic MCP SDK import in ${file}: ${emitted}`,
        )
        assert(
          !emitted.includes('vitest'),
          `Dynamic Vitest import in ${file}: ${emitted}`,
        )
        report.push(
          `${target} ${path.relative(buildRoot, file)}: runtime-selected import (unresolved): ${emitted}`,
        )
      }
      moduleCount += sources.length
      for (const source of [...sources, ...imports]) {
        assert(
          !vitest.test(source),
          `Vitest module or import in ${file}: ${source}`,
        )
        if (target === 'server')
          assert(
            !oauthClient.test(source),
            `MCP OAuth client in ${file}: ${source}`,
          )
        // External SDK imports cannot prove the transitive OAuth client graph absent.
        if (target === 'server' && imports.includes(source))
          assert(
            !sdk.test(source),
            `Unbundled MCP SDK graph in ${file}: ${source}`,
          )
        if (sdk.test(source)) {
          if (target === 'server') serverSdkModules++
          report.push(`${target} ${path.relative(buildRoot, file)}: ${source}`)
        }
      }
      report.push(
        `${target} ${path.relative(buildRoot, file)}: ${sources.length} source modules; imports ${JSON.stringify(imports)}`,
      )
    }
    report.push(
      `${target}: ${files.length} chunks, ${moduleCount} source modules analyzed; no vitest/@vitest source modules or literal imports`,
    )
  }
  assert(serverSdkModules > 0, 'Missing bundled MCP SDK server evidence')
  return report
}

export async function checkAndRemoveBundles(buildRoot) {
  try {
    return await checkBundles(buildRoot)
  } finally {
    // Source maps embed server sources. Do not leave evidence build output
    // behind for subsequent validation or accidental publication.
    await rm(buildRoot, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const root = path.resolve(import.meta.dirname, '../apps/web/build')
    console.log((await checkAndRemoveBundles(root)).join('\n'))
    console.log(
      'No MCP OAuth client modules or literal external SDK imports in the analyzed Worker build. No vitest/@vitest modules or literal imports in the analyzed Worker/client builds. Runtime-selected imports listed above remain unresolved. This does not classify other advisories or the CLI.',
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
