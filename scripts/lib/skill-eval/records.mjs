import { resolve } from 'node:path'

// Conservative tokenization for ordinary command lines. Shell programs remain raw evidence.
export function words(text) {
  if (typeof text !== 'string') return null
  if (/[`$]|<<|[;&|]/u.test(text)) return null
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/gu) ?? []
  return tokens.map((token) =>
    /^['"]/u.test(token) ? token.slice(1, -1) : token,
  )
}
export function parseStream(agent, text, cwd = '.') {
  const record = {
    commands: [],
    reads: [],
    finalMessage: '',
    errors: [],
    complete: false,
    turns: 0,
    malformed: 0,
  }
  const commands = new Map()
  const cycles = new Set()
  const cycle = (id) => {
    if (!cycles.has(id)) {
      cycles.add(id)
      record.turns++
    }
  }
  const read = (path, evidence) => {
    if (typeof path === 'string')
      record.reads.push({ path: resolve(cwd, path), evidence })
  }
  function command(id, raw, output, exitCode) {
    if (!id) id = `anonymous-${commands.size}`
    const item = commands.get(id) ?? {
      toolId: id,
      raw,
      argv: words(raw ?? ''),
      output: '',
      exitCode: null,
    }
    if (raw) {
      item.raw = raw
      item.argv = words(raw)
    }
    if (output !== undefined)
      item.output = typeof output === 'string' ? output : JSON.stringify(output)
    if (exitCode !== undefined) item.exitCode = exitCode
    commands.set(id, item)
  }
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('Reading additional input from stdin'))
      continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      record.malformed++
      continue
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      record.malformed++
      continue
    }
    const content = Array.isArray(event.message?.content)
      ? event.message.content
      : typeof event.message?.content === 'string'
        ? [{ type: 'text', text: event.message.content }]
        : []
    if (
      event.message?.content !== undefined &&
      typeof event.message.content !== 'string' &&
      !Array.isArray(event.message.content)
    )
      record.malformed++
    if (agent === 'claude') {
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          record.malformed++
          continue
        }
        if (item.type === 'tool_use') {
          if (item.name === 'Bash') command(item.id, item.input?.command)
          if (['Read', 'ReadFile'].includes(item.name))
            read(item.input?.file_path ?? item.input?.path, item.id)
        }
        if (item.type === 'tool_result') {
          const output = event.tool_use_result?.stdout ?? item.content
          if (commands.has(item.tool_use_id))
            command(item.tool_use_id, undefined, output, item.is_error ? 1 : 0)
          if (item.is_error)
            record.errors.push({ type: 'tool_error', id: item.tool_use_id })
        }
        if (event.type === 'assistant' && item.type === 'text')
          record.finalMessage =
            typeof item.text === 'string' ? item.text : record.finalMessage
      }
      if (
        event.type === 'assistant' &&
        content.some((item) => item?.type === 'tool_use')
      )
        cycle(event.message?.id ?? event)
      if (event.type === 'result') {
        record.complete = event.subtype === 'success' && !event.is_error
        record.finalMessage =
          typeof event.result === 'string' ? event.result : record.finalMessage
        if (!record.complete)
          record.errors.push({
            type: event.subtype ?? 'result_error',
            message: event.result,
          })
      }
    } else if (agent === 'codex') {
      const item = event.item
      if (item?.type === 'command_execution') {
        command(item.id, item.command, item.aggregated_output, item.exit_code)
        if (event.type === 'item.completed') cycle(item.id)
      }
      if (item?.type === 'agent_message')
        record.finalMessage =
          typeof item.text === 'string' ? item.text : record.finalMessage
      if (event.type === 'turn.completed') record.complete = true
      if (['error', 'turn.failed'].includes(event.type))
        record.errors.push({
          type: event.type,
          message: event.message ?? event.error?.message,
        })
    } else if (agent === 'cursor') {
      const shell = event.tool_call?.shellToolCall
      const id = event.call_id ?? event.tool_call_id ?? event.id
      if (shell)
        command(id, shell.args?.command, shell.result, shell.result?.exitCode)
      const nativeRead = event.tool_call?.readToolCall
      if (nativeRead) read(nativeRead.args?.path, id)
      if (
        event.type === 'tool_call' &&
        event.subtype === 'completed' &&
        (shell || nativeRead)
      )
        cycle(id)
      if (event.type === 'assistant')
        record.finalMessage = content
          .filter(
            (item) => item?.type === 'text' && typeof item.text === 'string',
          )
          .map((item) => item.text)
          .join('\n')
      if (event.type === 'result') {
        record.complete = !event.is_error
        record.finalMessage =
          typeof event.result === 'string' ? event.result : record.finalMessage
        if (event.is_error) record.errors.push({ type: 'result_error' })
      }
    }
  }
  record.commands = [...commands.values()]
  for (const item of record.commands) {
    let argv = item.argv
    if (
      argv &&
      ['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh'].includes(
        argv[0],
      ) &&
      ['-c', '-lc'].includes(argv[1])
    )
      argv = words(argv.slice(2).join(' '))
    if (argv && ['cat', 'head', 'tail', 'sed', 'rg'].includes(argv[0]))
      for (const arg of argv.slice(1))
        if (/\.(?:md|mdc|txt|html)$/u.test(arg) && !arg.startsWith('-'))
          read(arg, item.toolId)
  }
  if (
    record.malformed ||
    record.commands.some(
      (entry) => entry.exitCode === null || typeof entry.raw !== 'string',
    ) ||
    record.errors.some((error) =>
      ['turn.failed', 'error', 'result_error'].includes(error.type),
    )
  )
    record.complete = false
  record.referencesRead = [
    ...new Set(
      record.reads
        .filter((item) => item.path.includes('/references/'))
        .map((item) => item.path),
    ),
  ]
  return record
}
const outcome = (status, evidence) => ({ status, evidence })
const decide = (value, evidence) => outcome(value ? 'pass' : 'fail', evidence)
function recoveryEnvelope(output) {
  if (typeof output !== 'string') return undefined
  const lines = output.split('\n')
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].trimStart().startsWith('{')) continue
    let candidate = ''
    for (let end = start; end < lines.length; end++) {
      candidate += `${lines[end]}\n`
      try {
        const parsed = JSON.parse(candidate)
        if (parsed.error?.recovery) return parsed
        // Skip a complete unrelated document, including its nested objects.
        start = end
        break
      } catch {
        /* Keep collecting a pretty-printed envelope; retain raw warnings. */
      }
    }
  }
}
function recoveryAction(argv) {
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string'))
    return null
  const positionals = []
  const flags = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i))
      break
    }
    // Current recovery commands use these boolean flags. Only --json changes
    // output rather than the action; its presence is graded independently.
    if (arg === '--json') continue
    if (['--help', '-h', '--version', '-v'].includes(arg))
      flags.push(arg === '-h' ? '--help' : arg === '-v' ? '--version' : arg)
    else positionals.push(arg)
  }
  // Preserve all other arguments, including values and repetitions. Do not
  // assume an unrecognized option or an additional positional is harmless.
  return JSON.stringify([positionals, flags.sort()])
}
function urlKey(value) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href.replace(/\/$/u, '')
  } catch {
    return null
  }
}
export function score({
  record,
  actions = [],
  server = {},
  scenario,
  status = 'completed',
}) {
  const unknown = (reason) => outcome('unknown', reason)
  const eligible = record.complete && status === 'completed'
  const checks = {}
  checks.json = actions.length
    ? decide(
        actions.every((action) => {
          const argv = action.argv ?? []
          const terminator = argv.indexOf('--')
          const options = terminator < 0 ? argv : argv.slice(0, terminator)
          return options.includes('--json')
        }),
        actions.map((action) => action.argv),
      )
    : eligible
      ? decide(false, 'No CLI invocations')
      : unknown('No complete invocation evidence')
  const recoveries = []
  for (let i = 0; i < actions.length; i++) {
    let body
    for (const output of [actions[i].stdout, actions[i].stderr]) {
      const parsed = recoveryEnvelope(output)
      if (parsed) body = parsed
    }
    const recovery = body?.error?.recovery
    if (!recovery) continue
    const next = actions[i + 1]
    if (!next) {
      recoveries.push(unknown('No next CLI action'))
      continue
    }
    if (recovery.kind === 'run_command') {
      const tokens = words(recovery.command ?? '')
      const invocation = tokens?.indexOf('artifactshare') ?? -1
      const expected = invocation >= 0 ? tokens.slice(invocation + 1) : null
      const actual = recoveryAction(next.argv)
      recoveries.push(
        expected?.length && actual !== null
          ? decide(recoveryAction(expected) === actual, {
              recovery,
              next: next.argv,
            })
          : unknown('Unparseable recovery command or next action'),
      )
    } else if (
      recovery.kind === 'ask_human' ||
      recovery.kind === 'report_issue'
    )
      recoveries.push(
        decide(false, 'CLI action occurred before required human intervention'),
      )
    else
      recoveries.push(
        unknown(
          `Recovery ${recovery.kind} requires timing or semantic evidence`,
        ),
      )
  }
  checks.recovery = !recoveries.length
    ? outcome('not-applicable', 'No recovery opportunity')
    : recoveries.some((item) => item.status === 'fail')
      ? outcome('fail', recoveries)
      : recoveries.some((item) => item.status === 'unknown')
        ? unknown(recoveries)
        : outcome('pass', recoveries)
  const after = server.after
  checks.content =
    after?.content !== undefined && !after.truncated
      ? decide(after.content.includes(server.expectedContent), {
          expected: server.expectedContent,
          version: after.version_id,
        })
      : unknown('Persisted source unavailable or truncated')
  checks.identity =
    scenario === 'share'
      ? outcome('not-applicable', 'New share')
      : server.createdIds?.length > 0
        ? outcome('fail', { createdIds: server.createdIds })
        : server.before && after && server.createdIds
          ? decide(
              after.id === server.before.id &&
                urlKey(after.share_url) === urlKey(server.before.share_url) &&
                after.version_id !== server.before.version_id &&
                server.createdIds.length === 0,
              {
                before: server.before.version_id,
                after: after.version_id,
                createdIds: server.createdIds,
              },
            )
          : unknown('Missing before/after server evidence')
  checks.created =
    scenario === 'share'
      ? server.createdIds?.length > 1
        ? outcome('fail', server.createdIds)
        : server.createdIds && after
          ? decide(
              server.createdIds.length === 1 &&
                server.createdIds[0] === after.id,
              server.createdIds,
            )
          : unknown('Missing artifact inventory')
      : outcome('not-applicable', 'Existing artifact')
  const urls = record.finalMessage.match(/https?:\/\/[^\s<>"`\])]+/gu) ?? []
  checks.finalUrl = after?.share_url
    ? decide(
        urls.some(
          (value) =>
            urlKey(
              value.replace(/[*_`\])}"'.,;:!?！？，．；：。、）]+$/u, ''),
            ) === urlKey(after.share_url),
        ),
        { actual: after.share_url, reported: urls },
      )
    : unknown('Missing authoritative URL')
  if (!eligible)
    for (const [name, check] of Object.entries(checks))
      if (check.status === 'pass')
        checks[name] = unknown('Incomplete run cannot establish a pass')
  return checks
}
export function markdown(result) {
  const lines = [
    `# Local skill evaluation — ${result.persona}`,
    '',
    'Pass counts use completed, inspected, uncontaminated runs only. Unknown and not-applicable outcomes are excluded from eligible denominators.',
    '',
  ]
  for (const combination of result.combinations)
    for (const scenario of result.scenarios) {
      lines.push(
        `## ${combination} / ${scenario}`,
        '',
        `| Check | ${result.versions.map((v) => v.label).join(' | ')} |`,
        `| --- | ${result.versions.map(() => '---').join(' | ')} |`,
      )
      const subset = result.runs.filter(
        (run) => run.combination === combination && run.scenario === scenario,
      )
      const names = [
        ...new Set(subset.flatMap((run) => Object.keys(run.checks ?? {}))),
      ]
      for (const name of names)
        lines.push(
          `| ${name} | ${result.versions
            .map((version) => {
              const runs = subset.filter(
                (run) =>
                  run.version === version.label &&
                  run.status === 'completed' &&
                  run.skills?.complete &&
                  !run.skills?.contaminated,
              )
              const counts = Object.fromEntries(
                ['pass', 'fail', 'unknown', 'not-applicable'].map((status) => [
                  status,
                  runs.filter((run) => run.checks[name]?.status === status)
                    .length,
                ]),
              )
              return `${counts.pass}/${counts.pass + counts.fail}; unknown ${counts.unknown}; N/A ${counts['not-applicable']}`
            })
            .join(' | ')} |`,
        )
      for (const version of result.versions) {
        const runs = subset.filter((run) => run.version === version.label)
        lines.push(
          '',
          `${version.label}: incomplete ${runs.filter((run) => run.status !== 'completed' && run.status !== 'contaminated').length}; contaminated ${runs.filter((run) => run.skills?.contaminated).length}.`,
          `Reference reads: ${[...new Set(runs.flatMap((run) => run.record?.referencesRead ?? []))].join(', ') || 'none observed'}.`,
        )
      }
      lines.push('')
    }
  return `${lines.join('\n')}\n`
}
