import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TLA_TOOLS_VERSION = '1.7.4'
const TLA_TOOLS_SHA256 =
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar`

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tlaTools() {
  const cacheDir = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'artifactshare',
  )
  const jar = join(cacheDir, `tla2tools-${TLA_TOOLS_VERSION}.jar`)
  if (!existsSync(jar) || sha256(jar) !== TLA_TOOLS_SHA256) {
    mkdirSync(cacheDir, { recursive: true })
    console.log(`Downloading tla2tools ${TLA_TOOLS_VERSION} to ${jar}`)
    execFileSync('curl', ['-fsSL', '-o', jar, TLA_TOOLS_URL], {
      stdio: 'inherit',
    })
    const actual = sha256(jar)
    if (actual !== TLA_TOOLS_SHA256) {
      rmSync(jar)
      throw new Error(
        `tla2tools.jar checksum ${actual} does not match ${TLA_TOOLS_SHA256}`,
      )
    }
  }
  return jar
}

function configFor(baseConfig, invariants, constants = {}) {
  let text = baseConfig.replace(
    /\nINVARIANTS[\s\S]*$/,
    `\nINVARIANTS\n${invariants.map((name) => `    ${name}\n`).join('')}`,
  )
  for (const [name, value] of Object.entries(constants)) {
    const pattern = new RegExp(`(\\n\\s*${name}\\s*=\\s*)[^\\n]+`)
    if (!pattern.test(text))
      throw new Error(`constant ${name} is not in the config`)
    text = text.replace(pattern, `$1${value}`)
  }
  return text
}

function invariantsInConfig(baseConfig) {
  const block = baseConfig.split(/\nINVARIANTS\s*\n/)[1] ?? ''
  return block
    .split('\n')
    .map((line) => line.replace(/\\\*.*$/, '').trim())
    .filter(Boolean)
}

function mutate(spec, mutation) {
  const count = spec.split(mutation.find).length - 1
  if (count !== 1) return null
  return spec.replace(mutation.find, mutation.replace)
}

function runTlc(MODULE, jar, root, label, specText, configText, workers = '1') {
  const dir = join(root, label)
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFileSync(join(dir, `${MODULE}.tla`), specText)
  writeFileSync(join(dir, `${MODULE}.cfg`), configText)
  return new Promise((resolve) => {
    const child = spawn(
      'java',
      [
        '-XX:+UseParallelGC',
        `-Djava.io.tmpdir=${join(dir, 'tmp')}`,
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        workers,
        '-metadir',
        join(dir, 'states'),
        '-config',
        `${MODULE}.cfg`,
        `${MODULE}.tla`,
      ],
      { cwd: dir },
    )
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('error', (error) =>
      resolve({ dir, out: String(error), verdict: 'error' }),
    )
    child.on('close', () => {
      writeFileSync(join(dir, 'tlc.out'), out)
      const violated = out.match(/Invariant (\w+) is violated/)
      const states = [...out.matchAll(/([\d,]+) distinct states found/g)].at(-1)
      const verdict = violated
        ? 'violated'
        : out.includes('Model checking completed. No error has been found.')
          ? 'pass'
          : 'error'
      resolve({
        dir,
        out,
        verdict,
        violated: violated?.[1],
        states: states?.[1],
      })
    })
  })
}

function tracePath(out) {
  if (/is violated by the initial state/.test(out)) return 'the initial state'
  return [...out.matchAll(/^State (\d+): <(\w+)/gm)]
    .map(([, n, action]) => `${n}. ${action}`)
    .join('  ')
}

export async function runModelChecks({
  modelDir,
  module: MODULE,
  knownFindings: KNOWN_FINDINGS = {},
  scopedBaselines: SCOPED_BASELINES = [],
  mutations: MUTATIONS = [],
}) {
  const spec = readFileSync(join(modelDir, `${MODULE}.tla`), 'utf8')
  const baseConfig = readFileSync(join(modelDir, `${MODULE}.cfg`), 'utf8')

  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' })
  } catch {
    console.error('Java 11 or later is required on PATH to run TLC.')
    process.exit(2)
  }
  const jar = tlaTools()
  const root = mkdtempSync(join(tmpdir(), `tlc-${MODULE}-`))
  const invariants = invariantsInConfig(baseConfig)
  const holding = invariants.filter((name) => !KNOWN_FINDINGS[name])
  const baseline = {
    job: { kind: 'baseline', invariant: holding.join(', '), expect: 'pass' },
    result: await runTlc(
      MODULE,
      jar,
      root,
      'baseline',
      spec,
      configFor(baseConfig, holding),
      'auto',
    ),
  }
  const jobs = []
  for (const invariant of invariants.filter((name) => KNOWN_FINDINGS[name]))
    jobs.push({
      kind: 'known finding',
      invariant,
      expect: 'violated',
      run: () =>
        runTlc(
          MODULE,
          jar,
          root,
          `finding-${invariant}`,
          spec,
          configFor(baseConfig, [invariant]),
        ),
    })
  for (const scoped of SCOPED_BASELINES)
    jobs.push({
      kind: 'scoped baseline',
      invariant: `${scoped.invariant} with ${JSON.stringify(scoped.constants)}`,
      expect: 'pass',
      run: () =>
        runTlc(
          MODULE,
          jar,
          root,
          `scoped-${scoped.invariant}${scoped.label ? `-${scoped.label}` : ''}`,
          spec,
          configFor(baseConfig, [scoped.invariant], scoped.constants),
        ),
    })
  for (const mutation of MUTATIONS)
    jobs.push({
      kind: 'mutation',
      invariant: mutation.breaks,
      name: mutation.name,
      code: mutation.code,
      expect: 'violated',
      run: () => {
        const mutated = mutate(spec, mutation)
        if (mutated === null)
          return Promise.resolve({
            verdict: 'error',
            dir: root,
            out: '',
            note: `The text this mutation replaces is not in the model exactly once: ${mutation.find}. Update MUTATIONS in check.mjs to match the model.`,
          })
        return runTlc(
          MODULE,
          jar,
          root,
          `mutation-${mutation.name}`,
          mutated,
          configFor(baseConfig, [mutation.breaks], mutation.constants),
        )
      },
    })

  const results = [baseline]
  const queue = [...jobs]
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(availableParallelism(), queue.length)) },
      async () => {
        for (let job = queue.shift(); job; job = queue.shift())
          results.push({ job, result: await job.run() })
      },
    ),
  )
  let unexpected = 0
  for (const { job, result } of results) {
    const ok =
      result.verdict === job.expect &&
      (job.expect !== 'violated' ||
        result.violated === job.invariant.split(' ')[0])
    if (!ok) unexpected++
    const mark = ok ? 'ok  ' : 'FAIL'
    if (job.kind === 'mutation') {
      console.log(`${mark} mutation ${job.name}: ${job.code}`)
      console.log(
        `       expected ${job.invariant} to break; got ${result.verdict}${result.violated ? ` (${result.violated})` : ''}`,
      )
    } else {
      const finding =
        job.kind === 'known finding' && KNOWN_FINDINGS[job.invariant]
      console.log(
        `${mark} ${job.kind} ${job.invariant}: ${result.verdict}${result.violated ? ` (${result.violated})` : ''}${result.states ? `, ${result.states} states` : ''}`,
      )
      if (finding) console.log(`       known finding: ${finding}`)
    }
    if (result.verdict === 'violated' && (!ok || job.kind !== 'mutation'))
      console.log(`       path: ${tracePath(result.out)}`)
    if (result.note) console.log(`       ${result.note}`)
    else if (!ok) {
      console.log(`       TLC output: ${join(result.dir, 'tlc.out')}`)
      if (result.verdict === 'error')
        for (const line of result.out.trimEnd().split('\n').slice(-20))
          console.log(`       | ${line}`)
    }
  }
  if (!process.argv.includes('--keep') && unexpected === 0)
    rmSync(root, { recursive: true, force: true })
  console.log(
    unexpected === 0
      ? 'All checks behaved as recorded.'
      : `${unexpected} check(s) did not behave as recorded.`,
  )
  process.exit(unexpected === 0 ? 0 : 1)
}
