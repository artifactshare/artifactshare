import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'

const config = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config/public-export-scan.json')),
)
const manifestVersion = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'config/public-export-include.json'),
  ),
).manifest_version
const compiled = config.patterns.map((item) => ({
  ...item,
  regex: new RegExp(item.pattern, 'giu'),
  pathRegex: item.path ? new RegExp(item.path, 'u') : undefined,
}))
const allowlist = config.allowlist.map((item) => ({
  ...item,
  regex: new RegExp(item.pattern, 'iu'),
  pathRegex: item.path ? new RegExp(item.path, 'u') : undefined,
}))
const generatedDirectories = new Set([
  '.git',
  '.next',
  '.react-router',
  '.turbo',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'scenario-regression-artifacts',
  'static-sites',
  '__screenshots__',
  '.vitest-attachments',
])
const generatedFileNames = new Set(['worker-configuration.d.ts', '.DS_Store'])

function isGeneratedFile(fileName) {
  return generatedFileNames.has(fileName) || fileName.endsWith('.tsbuildinfo')
}

function trackedEntries(directory) {
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
  })
  const isGitRoot =
    gitRoot.status === 0 &&
    fs.realpathSync(gitRoot.stdout.trim()) === fs.realpathSync(directory)
  if (isGitRoot) {
    const gitFiles = spawnSync('git', ['ls-files', '-z'], {
      cwd: directory,
      encoding: 'utf8',
    })
    if (gitFiles.status !== 0)
      throw new Error('failed to enumerate tracked files for scan target')
    return {
      files: new Set(gitFiles.stdout.split('\0').filter(Boolean)),
      receiptBased: false,
      receiptFiles: [],
    }
  }
  const receipt = path.join(directory, 'PUBLIC-EXPORT-RECEIPT.json')
  if (!fs.existsSync(receipt))
    throw new Error('scan target must be a git worktree or fresh public export')
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  if (data.manifest_version !== manifestVersion)
    throw new Error('export receipt manifest version mismatch')
  if (!Array.isArray(data.files))
    throw new Error('invalid export receipt files')
  const receiptFiles = data.files.map((file) => {
    if (
      typeof file?.path !== 'string' ||
      path.isAbsolute(file.path) ||
      file.path !== path.normalize(file.path) ||
      file.path.startsWith(`..${path.sep}`) ||
      file.path === '..'
    )
      throw new Error('invalid export receipt path')
    if (!/^[0-9a-f]{64}$/u.test(file.sha256))
      throw new Error(`invalid export receipt sha256: ${file.path}`)
    return file
  })
  if (
    new Set(receiptFiles.map((file) => file.path)).size !== receiptFiles.length
  )
    throw new Error('duplicate export receipt path')
  return {
    files: new Set([
      ...receiptFiles.map((file) => file.path),
      'PUBLIC-EXPORT-RECEIPT.json',
    ]),
    receiptBased: true,
    receiptFiles,
  }
}

function isAllowed(category, value, filePath) {
  return allowlist.some(
    (item) =>
      item.category === category &&
      (!item.pathRegex || item.pathRegex.test(filePath)) &&
      item.regex.test(value),
  )
}

export function checkMarkdownRelativeLinks(directory, exportedPaths) {
  const exported = new Set(exportedPaths)
  const findings = []
  const checkTarget = (relativePath, target) => {
    target = target.replace(/^<|>$/gu, '')
    if (
      !target ||
      target.startsWith('#') ||
      target.startsWith('/') ||
      /^[a-z][a-z\d+.-]*:/iu.test(target) ||
      target.startsWith('//')
    )
      return
    let targetPath
    try {
      targetPath = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0])
    } catch {
      findings.push({
        category: 'broken-relative-link',
        path: relativePath,
        target,
      })
      return
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(relativePath), targetPath),
    )
    if (
      resolved === '..' ||
      resolved.startsWith('../') ||
      !exported.has(resolved)
    )
      findings.push({
        category: 'broken-relative-link',
        path: relativePath,
        target,
      })
  }
  for (const relativePath of exported) {
    if (!relativePath.toLowerCase().endsWith('.md')) continue
    const file = path.join(directory, relativePath)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    const tokens = marked.lexer(fs.readFileSync(file, 'utf8'))
    marked.walkTokens(tokens, (token) => {
      if (
        token.type === 'link' ||
        token.type === 'image' ||
        token.type === 'def'
      )
        checkTarget(relativePath, token.href)
      if (token.type !== 'text' || token.tokens) return
      for (const match of token.raw.matchAll(
        /(?<!\\)!?\[([^\]]+)\]\[([^\]]*)\]/gu,
      )) {
        const id = (match[2] || match[1]).trim().toLowerCase()
        findings.push({
          category: 'broken-relative-link',
          path: relativePath,
          target: `[${id}]`,
        })
      }
    })
  }
  return findings
}
export function scan(directory, options = {}) {
  const findings = []
  const tracked = trackedEntries(directory)
  const exportedPaths = [...tracked.files].filter(
    (file) => file !== 'PUBLIC-EXPORT-RECEIPT.json',
  )
  if (tracked.receiptBased && options.verifyReceipt !== false) {
    for (const expected of tracked.receiptFiles) {
      const file = path.join(directory, expected.path)
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile())
        throw new Error(`export receipt file missing: ${expected.path}`)
      const actualSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex')
      if (actualSha256 !== expected.sha256)
        throw new Error(`export receipt sha256 mismatch: ${expected.path}`)
    }
    const actual = []
    function visit(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory() && generatedDirectories.has(entry.name))
          continue
        if (entry.isFile() && isGeneratedFile(entry.name)) continue
        const file = path.join(current, entry.name)
        if (entry.isDirectory()) visit(file)
        else actual.push(path.relative(directory, file))
      }
    }
    visit(directory)
    const expected = tracked.files
    const unexpected = actual.filter((file) => !expected.has(file))
    if (unexpected.length)
      throw new Error(
        `export contains files absent from receipt: ${unexpected.join(', ')}`,
      )
  }
  findings.push(...checkMarkdownRelativeLinks(directory, exportedPaths))
  for (const relativePath of tracked.files) {
    if (relativePath === 'PUBLIC-EXPORT-RECEIPT.json') continue
    if (options.pathPrefix && !relativePath.startsWith(options.pathPrefix))
      continue
    const file = path.join(directory, relativePath)
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(`tracked scan file missing: ${relativePath}`)
      throw error
    }
    if (!stat.isFile())
      throw new Error(`tracked scan file is not regular: ${relativePath}`)
    const buffer = fs.readFileSync(file)
    if (buffer.includes(0)) continue
    const value = buffer.toString('utf8')
    for (const item of compiled) {
      if (item.pathRegex && !item.pathRegex.test(relativePath)) continue
      item.regex.lastIndex = 0
      for (const match of value.matchAll(item.regex)) {
        if (!isAllowed(item.category, match[0], relativePath)) {
          findings.push({
            category: item.category,
            path: relativePath,
            pattern: item.pattern,
          })
        }
      }
    }
  }
  return findings
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2]
  if (!directory) throw new Error('scan <export-directory>')
  const findings = scan(path.resolve(directory))
  if (findings.length) {
    console.error(JSON.stringify(findings, null, 2))
    process.exitCode = 1
  } else console.log('scan: 0 findings')
}
