import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseSync, Visitor } from 'oxc-parser'

const QUIRK_VENDORS = [
  'better-auth',
  'chromium',
  'd1',
  'firefox',
  'github',
  'google',
  'gtag',
  'kysely',
  'macos',
  'mermaid',
  'node',
  'pdfjs',
  'playwright',
  'radix',
  'react',
  'react-router',
  'resend',
  'safari',
  'slack',
  'sqlite',
  'stripe',
  'vite',
  'webkit',
  'windows',
  'workerd',
  'wrangler',
]

const CALLS = {
  effect: new Set(['useEffect', 'useLayoutEffect']),
  timer: new Set([
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'requestIdleCallback',
    'queueMicrotask',
  ]),
}
const TEMPLATE_TIMER =
  /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)\s*\(/g
const CODE_FILE = /\.[cm]?[jt]sx?$/
const SCANNED_ROOT = /^(?:apps|packages|scripts)\//
const NOT_PRODUCT =
  /(?:^|\/)(?:test|tests|__tests__|d1-tests|integration|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.generated\.|\.d\.[cm]?ts$/
const SCRIPT_DIRECTORY = /(?:^|\/)scripts\//
const HOOKS_DIRECTORY = 'apps/web/app/hooks'

const DIRECTIVES = [
  {
    pattern: /^oxlint-(?:disable|enable)(?:-next-line|-line)?(?:\s|$)/,
    reason: /\s--\s+\S/,
    fix: 'end it with ` -- <reason>`',
  },
  {
    pattern: /^react-doctor-disable(?:-next-line|-line)?(?:\s|$)/,
    reason: /\s--\s+\S/,
    fix: 'end it with ` -- <reason>`',
  },
  {
    pattern: /^@ts-expect-error(?:\s|$)/,
    reason: /^@ts-expect-error\s+\S/,
    fix: 'follow it with the reason',
  },
  { pattern: /^\/\s*<reference\s/ },
  { pattern: /^@vite-ignore$/ },
]
const TAG = /^(?:quirk\(|compat:|invariant:|agent-allow\()/
const ALLOW = /^agent-allow\(([^)]*)\):?\s*(.*)$/s
const QUIRK = /^quirk\(([^)]*)\):?\s*(.*)$/s
const INVARIANT_TEST = /\(test:\s*([^\s)]+)\s*\)/
const JSDOC_TYPE =
  /^@(?:type|param|returns?|typedef|template|satisfies|import|property|callback|overload|this|enum|implements|extends)\b/
const JS_FILE = /\.[cm]?jsx?$/

const FIXES = {
  effect: (hooks) =>
    `compute the value during render, or do the work in the event handler that causes it. For a subscription, listener, observer or fetcher result, call a named hook from ${HOOKS_DIRECTORY}${hooks.length ? ` (${hooks.join(', ')})` : ''}, or add one there that replaces the effects it absorbs. If the effect must stay, put // agent-allow(effect): <reason> on the line above it`,
  timer: (hooks) =>
    `wait for an observed condition instead of a delay: an event or an acknowledgment message for frame and network ordering, a ref callback or flushSync for render, AbortSignal.timeout(ms) for a deadline, or a named hook from ${HOOKS_DIRECTORY}${hooks.includes('useCopyState') ? ' such as useCopyState for a reset after a delay' : ''}. If the timer must stay, put // agent-allow(timer): <reason> on the line above it`,
  comment: () =>
    `put the reason in a name, a type, a test, or the PR body. These comments do not count: a tool directive with a reason (oxlint-disable-next-line <rule> -- <reason>, react-doctor-disable-next-line <rule> -- <reason>, @ts-expect-error <reason>), /// <reference>, @vite-ignore, JSDoc types in a .js file, quirk(<vendor>): about the behavior of ${QUIRK_VENDORS.join(', ')}, compat: about a shipped CLI or wire format, and invariant: <what holds> (test: <path of an existing test>). If the comment must stay, start it with agent-allow(comment): <reason>`,
}

class RatchetError extends Error {}

function rulesFor(path) {
  if (
    !CODE_FILE.test(path) ||
    !SCANNED_ROOT.test(path) ||
    NOT_PRODUCT.test(path)
  )
    return []
  return SCRIPT_DIRECTORY.test(path)
    ? ['comment']
    : ['effect', 'timer', 'comment']
}

function lineStarts(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index++)
    if (source.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

function lineOf(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type !== 'MemberExpression') return null
  if (!callee.computed) return callee.property.name
  return typeof callee.property.value === 'string'
    ? callee.property.value
    : null
}

function directive(text) {
  return DIRECTIVES.find(({ pattern }) => pattern.test(text))
}

function blockText(comment) {
  return comment.type === 'Line'
    ? comment.value.trim()
    : comment.value
        .split('\n')
        .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
        .filter(Boolean)
        .join('\n')
}

function groupComments(comments, source) {
  const blocks = []
  let open = null
  for (const comment of comments) {
    const text = comment.text
    const single = comment.type === 'Block' || directive(text)
    const joins =
      open &&
      !single &&
      !TAG.test(text) &&
      comment.line === open.endLine + 1 &&
      /^\s*$/.test(source.slice(open.end, comment.start))
    if (joins) {
      open.text += `\n${text}`
      open.endLine = comment.endLine
      open.end = comment.end
      continue
    }
    open = { ...comment }
    blocks.push(open)
    if (single) open = null
  }
  return blocks
}

function templateParts(source, quasis, starts) {
  const comments = []
  const timers = []
  for (const quasi of quasis) {
    const raw = quasi.value.raw
    const found = source.indexOf(raw, quasi.start)
    const offset = found === -1 ? quasi.start + 1 : found
    let lineStart = 0
    for (const [index, segment] of raw.split('\n').entries()) {
      const at = offset + lineStart
      lineStart += segment.length + 1
      const comment = index > 0 && /^\s*\/\//.test(segment)
      if (comment) {
        const line = lineOf(starts, at)
        comments.push({
          type: 'Line',
          text: segment.trim().slice(2).trim(),
          line,
          endLine: line,
          start: at,
          end: at + segment.length,
        })
        continue
      }
      for (const match of segment.matchAll(TEMPLATE_TIMER))
        timers.push({ line: lineOf(starts, at + match.index), label: match[1] })
    }
  }
  return { comments, timers }
}

function classify(block, path, exists) {
  if (
    block.type === 'Block' &&
    JS_FILE.test(path) &&
    block.text.split('\n').every((line) => JSDOC_TYPE.test(line))
  )
    return { allowed: true }
  const allow = ALLOW.exec(block.text)
  if (allow) {
    const [, rule, reason] = allow
    if (!['effect', 'timer', 'comment'].includes(rule))
      return {
        hint: `agent-allow names effect, timer or comment, not "${rule}"`,
      }
    if (!reason.trim()) return { hint: 'agent-allow needs a reason' }
    return { allow: rule, reason: reason.trim().split('\n')[0] }
  }
  const tool = directive(block.text)
  if (tool)
    return !tool.reason || tool.reason.test(block.text)
      ? { allowed: true }
      : { hint: `directive without a reason; ${tool.fix}` }
  const quirk = QUIRK.exec(block.text)
  if (quirk) {
    if (!QUIRK_VENDORS.includes(quirk[1]))
      return { hint: `quirk vendor "${quirk[1]}" is not in the list` }
    return quirk[2].trim()
      ? { allowed: true }
      : { hint: 'quirk needs the behavior it works around' }
  }
  if (/^compat:\s*\S/.test(block.text)) return { allowed: true }
  if (block.text.startsWith('invariant:')) {
    const test = INVARIANT_TEST.exec(block.text)?.[1]
    if (!test) return { hint: 'invariant: needs (test: <path>)' }
    return exists(test)
      ? { allowed: true }
      : { hint: `invariant test ${test} does not exist` }
  }
  return {}
}

function summary(text) {
  const first = text.split('\n')[0]
  return `"${first.length > 60 ? `${first.slice(0, 57)}...` : first}"`
}

function scan(source, path, exists) {
  const rules = rulesFor(path)
  const counts = { effect: [], timer: [], comment: [], allowed: [] }
  if (rules.length === 0) return counts
  const parsed = parseSync(path, source)
  const starts = lineStarts(source)
  const calls = []
  const templateComments = []
  new Visitor({
    CallExpression(node) {
      const name = calleeName(node.callee)
      for (const rule of ['effect', 'timer'])
        if (rules.includes(rule) && CALLS[rule].has(name))
          calls.push({ rule, line: lineOf(starts, node.start), label: name })
    },
    TemplateLiteral(node) {
      const { comments, timers } = templateParts(source, node.quasis, starts)
      templateComments.push(...comments)
      if (rules.includes('timer'))
        for (const timer of timers) calls.push({ rule: 'timer', ...timer })
    },
  }).visit(parsed.program)
  const comments = [
    ...parsed.comments.map((comment) => ({
      type: comment.type,
      text: blockText(comment),
      line: lineOf(starts, comment.start),
      endLine: lineOf(starts, comment.end),
      start: comment.start,
      end: comment.end,
    })),
    ...templateComments,
  ].sort((left, right) => left.start - right.start)
  const escapes = []
  for (const block of groupComments(comments, source)) {
    const verdict = classify(block, path, exists)
    if (verdict.allowed) continue
    if (verdict.allow === 'comment') {
      counts.allowed.push({
        rule: 'comment',
        line: block.line,
        reason: verdict.reason,
      })
      continue
    }
    if (verdict.allow) {
      escapes.push({ ...block, rule: verdict.allow, reason: verdict.reason })
      continue
    }
    counts.comment.push({
      line: block.line,
      endLine: block.endLine,
      label: summary(block.text),
      hint: verdict.hint,
    })
  }
  const used = new Set()
  for (const call of calls) {
    const escape = escapes.find(
      (candidate) =>
        candidate.rule === call.rule &&
        (candidate.endLine + 1 === call.line || candidate.line === call.line),
    )
    if (!escape) {
      counts[call.rule].push({ line: call.line, label: call.label })
      continue
    }
    used.add(escape)
    counts.allowed.push({
      rule: call.rule,
      line: call.line,
      reason: escape.reason,
    })
  }
  for (const escape of escapes)
    if (!used.has(escape))
      counts.comment.push({
        line: escape.line,
        endLine: escape.endLine,
        label: summary(escape.text),
        hint: `agent-allow(${escape.rule}) is not on the line above a ${escape.rule} call`,
      })
  return counts
}

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  })
}

function readBlobs(root, specs) {
  if (specs.length === 0) return []
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: specs.map((spec) => `${spec}\n`).join(''),
    maxBuffer: 1 << 30,
  })
  const blobs = []
  let offset = 0
  for (const _ of specs) {
    const newline = output.indexOf(10, offset)
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(
      output.toString('utf8', offset, newline),
    )
    offset = newline + 1
    if (!header) {
      blobs.push(null)
      continue
    }
    const size = Number(header[2])
    blobs.push(
      header[1] === 'blob'
        ? output.toString('utf8', offset, offset + size)
        : null,
    )
    offset += size + 1
  }
  return blobs
}

function nameList(output) {
  return output.split('\0').filter(Boolean)
}

function addedLines(root, base, head) {
  const added = new Map()
  let current = null
  let remaining = 0
  const diff = git(root, [
    '-c',
    'core.quotepath=off',
    'diff',
    '-U0',
    '-M',
    '--no-color',
    '--no-ext-diff',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    base,
    ...(head ? [head] : []),
    '--',
  ])
  for (const line of diff.split('\n')) {
    if (remaining > 0) {
      if (!line.startsWith('\\')) remaining--
      continue
    }
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '')
      current = name.startsWith('b/') ? new Set() : null
      if (current) added.set(name.slice(2), current)
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!hunk || !current) continue
    const removed = hunk[1] === undefined ? 1 : Number(hunk[1])
    const start = Number(hunk[2])
    const count = hunk[3] === undefined ? 1 : Number(hunk[3])
    for (let number = start; number < start + count; number++)
      current.add(number)
    remaining = removed + count
  }
  return added
}

function resolveBase(root, base, head, env) {
  const ci = /^(?:1|true)$/i.test(env.CI ?? '')
  const requested =
    base || env.AGENT_RATCHET_BASE || (ci ? null : 'origin/main')
  if (!requested)
    throw new RatchetError(
      'CI must name the base; set AGENT_RATCHET_BASE to the pull request base sha or the merge group base sha',
    )
  try {
    return git(root, [
      'merge-base',
      '--end-of-options',
      requested,
      head ?? 'HEAD',
    ]).trim()
  } catch {
    throw new RatchetError(
      `no merge base between ${requested} and ${head ?? 'HEAD'}; run git fetch origin main (git fetch --unshallow in a shallow clone), or pass --base <rev>`,
    )
  }
}

function namedHooks(root) {
  try {
    return readdirSync(join(root, HOOKS_DIRECTORY))
      .filter((name) => /^use-[a-z0-9-]+\.tsx?$/.test(name))
      .map((name) =>
        name
          .replace(/\.tsx?$/, '')
          .replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase()),
      )
  } catch {
    return []
  }
}

function ratchet({ root, base, head, env = {} }) {
  if (head)
    try {
      git(root, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${head}^{commit}`,
      ])
    } catch {
      throw new RatchetError(`--head ${head} is not a commit in this clone`)
    }
  const mergeBase = resolveBase(root, base, head, env)
  const tracked = nameList(
    git(root, [
      'diff',
      '--name-only',
      '--no-renames',
      '--no-relative',
      '-z',
      mergeBase,
      ...(head ? [head] : []),
      '--',
    ]),
  )
  const untracked = head
    ? []
    : nameList(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  const paths = [...new Set([...tracked, ...untracked])].filter(
    (path) => rulesFor(path).length > 0,
  )
  const baseSources = readBlobs(
    root,
    paths.map((path) => `${mergeBase}:${path}`),
  )
  const headSources = head
    ? readBlobs(
        root,
        paths.map((path) => `${head}:${path}`),
      )
    : paths.map((path) =>
        existsSync(join(root, path))
          ? readFileSync(join(root, path), 'utf8')
          : null,
      )
  const inBase = (path) => readBlobs(root, [`${mergeBase}:${path}`])[0] !== null
  const inHead = head
    ? (path) => readBlobs(root, [`${head}:${path}`])[0] !== null
    : (path) => existsSync(join(root, path))
  const added = addedLines(root, mergeBase, head)
  const untrackedSet = new Set(untracked)
  const rules = Object.fromEntries(
    ['effect', 'timer', 'comment'].map((rule) => [
      rule,
      { base: 0, head: 0, added: [], files: [] },
    ]),
  )
  const allowed = []
  for (const [index, path] of paths.entries()) {
    const before = scan(baseSources[index] ?? '', path, inBase)
    const after = scan(headSources[index] ?? '', path, inHead)
    const isAdded = (line) =>
      untrackedSet.has(path) || (added.get(path)?.has(line) ?? false)
    for (const [rule, total] of Object.entries(rules)) {
      total.base += before[rule].length
      total.head += after[rule].length
      if (after[rule].length > before[rule].length)
        total.files.push({
          path,
          base: before[rule].length,
          head: after[rule].length,
        })
      for (const occurrence of after[rule]) {
        const last = occurrence.endLine ?? occurrence.line
        for (let line = occurrence.line; line <= last; line++)
          if (isAdded(line)) {
            total.added.push({ path, ...occurrence })
            break
          }
      }
    }
    for (const allowance of after.allowed)
      if (isAdded(allowance.line)) allowed.push({ path, ...allowance })
  }
  return { base: mergeBase, files: paths.length, rules, allowed }
}

function changed({ files, base }) {
  return `${files} changed file${files === 1 ? '' : 's'} since ${base.slice(0, 12)}`
}

function report(result, hooks = []) {
  const failures = Object.entries(result.rules).filter(
    ([, total]) => total.head > total.base,
  )
  const lines = []
  for (const [rule, total] of failures) {
    lines.push(
      `agent-pattern-ratchet: ${rule} rose from ${total.base} to ${total.head} in ${changed(result)}`,
    )
    const shown = total.added.length
      ? total.added.map(
          ({ path, line, label, hint }) =>
            `  ${path}:${line} ${label}${hint ? ` (${hint})` : ''}`,
        )
      : total.files.map(
          ({ path, base, head }) => `  ${path}: ${base} -> ${head}`,
        )
    lines.push(...shown)
    lines.push(`  fix: ${FIXES[rule](hooks)}`)
  }
  for (const { path, line, rule, reason } of result.allowed)
    lines.push(
      `agent-pattern-ratchet: allowed ${rule} at ${path}:${line}: ${reason}`,
    )
  if (failures.length === 0) {
    const counts = Object.entries(result.rules)
      .map(([rule, total]) => `${rule} ${total.base} -> ${total.head}`)
      .join(', ')
    lines.push(`agent-pattern-ratchet: ok (${counts} in ${changed(result)})`)
  }
  return { ok: failures.length === 0, lines }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, head: { type: 'string' } },
  })
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
    const { ok, lines } = report(
      ratchet({ root, ...values, env: process.env }),
      namedHooks(root),
    )
    ;(ok ? process.stdout : process.stderr).write(`${lines.join('\n')}\n`)
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    if (!(error instanceof RatchetError)) throw error
    process.stderr.write(`agent-pattern-ratchet: ${error.message}\n`)
    process.exitCode = 1
  }
}
