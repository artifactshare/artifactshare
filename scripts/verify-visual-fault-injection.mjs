import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const faultCases = [
  {
    fault: 'axe',
    testName: 'landing-default',
    diagnostic: /image-alt|violations/u,
  },
  {
    fault: 'geometry',
    testName: 'landing-default',
    diagnostic: /main:0/u,
  },
  {
    fault: 'image',
    testName: 'landing-default',
    diagnostic: /screenshot|Screenshot/u,
  },
  {
    fault: 'runtime',
    testName: 'landing-default',
    diagnostic: /injected runtime failure/u,
  },
  {
    fault: 'header',
    testName: 'viewer-default',
    diagnostic: /screenshot|Screenshot/u,
  },
]

function runVisual({ fault, testName }) {
  const environment = ['-e', `VITEST_TEST_NAME=${testName}`]
  if (fault) environment.push('-e', `VISUAL_FAULT=${fault}`)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-f',
        'compose.playwright.yml',
        'run',
        '--rm',
        ...environment,
        'visual',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

export async function main() {
  for (const testName of new Set(faultCases.map((item) => item.testName))) {
    const control = await runVisual({ testName })
    if (control.code !== 0)
      throw new Error(
        `${testName} clean control failed before fault injection:\n${control.output}`,
      )
    console.log(`visual clean control passed: ${testName}`)
  }
  for (const faultCase of faultCases) {
    const result = await runVisual(faultCase)
    if (result.code === 0)
      throw new Error(`${faultCase.fault} fault injection unexpectedly passed`)
    if (!faultCase.diagnostic.test(result.output))
      throw new Error(
        `${faultCase.fault} fault injection failed without its expected diagnostic:\n${result.output}`,
      )
    console.log(`visual fault injection detected: ${faultCase.fault}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.stack ?? error)
    process.exitCode = 1
  })
