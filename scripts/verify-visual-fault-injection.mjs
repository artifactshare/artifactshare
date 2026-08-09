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

function runFault({ fault, testName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-f',
        'compose.playwright.yml',
        'run',
        '--rm',
        '-e',
        `VISUAL_FAULT=${fault}`,
        '-e',
        `VITEST_TEST_NAME=${testName}`,
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
  for (const faultCase of faultCases) {
    const result = await runFault(faultCase)
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
