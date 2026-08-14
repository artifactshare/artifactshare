import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseMarkdown } from '@tanstack/markdown/parser'
import { compileScanConfig, scanValue } from './lib/scan-patterns.mjs'

const config = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'config/public-repository-scan.json'),
  ),
)
const compiled = compileScanConfig(config)
function trackedEntries(directory) {
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
  })
  const isGitRoot =
    gitRoot.status === 0 &&
    fs.realpathSync(gitRoot.stdout.trim()) === fs.realpathSync(directory)
  if (!isGitRoot) throw new Error('scan target must be a git worktree root')
  const gitFiles = spawnSync('git', ['ls-files', '-z'], {
    cwd: directory,
    encoding: 'utf8',
  })
  if (gitFiles.status !== 0)
    throw new Error('failed to enumerate tracked files for scan target')
  return new Set(gitFiles.stdout.split('\0').filter(Boolean))
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
    const document = parseMarkdown(fs.readFileSync(file, 'utf8'))
    walkMarkdown(document, (node) => {
      if (node.type === 'link') checkTarget(relativePath, node.href)
      if (node.type === 'image') checkTarget(relativePath, node.src)
      if (node.type !== 'text') return
      for (const match of node.value.matchAll(
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

function walkMarkdown(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkMarkdown(item, visit)
    return
  }
  if (!value || typeof value !== 'object') return
  if (typeof value.type === 'string') visit(value)
  for (const child of Object.values(value)) walkMarkdown(child, visit)
}
export function scan(directory, options = {}) {
  const findings = []
  const tracked = trackedEntries(directory)
  const exportedPaths = [...tracked]
  findings.push(...checkMarkdownRelativeLinks(directory, exportedPaths))
  for (const relativePath of tracked) {
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
    findings.push(
      ...scanValue(value, relativePath, compiled).map((finding) => ({
        ...finding,
        path: relativePath,
      })),
    )
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
