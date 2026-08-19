import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

function numericConstant(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)\\b`))
  return match ? Number(match[1]) : null
}

export function productContractProblems({ canonical, cli, en, ja, api }) {
  const problems = []
  const keyLength = numericConstant(canonical, 'ARTIFACT_KEY_MAX_LENGTH')
  const cliKeyLength = numericConstant(cli, 'MAX_SHARE_KEY_LENGTH')
  const refreshDays = numericConstant(canonical, 'REFRESH_CREDENTIAL_TTL_DAYS')

  if (keyLength === null) {
    problems.push('canonical artifact key length is missing')
  } else {
    if (cliKeyLength !== keyLength) {
      problems.push(
        `CLI artifact key length ${cliKeyLength ?? 'missing'} does not match ${keyLength}`,
      )
    }
    if (!api.includes('${ARTIFACT_KEY_MAX_LENGTH}')) {
      problems.push('API artifact key error does not derive from the contract')
    }
  }

  if (refreshDays === null) {
    problems.push('canonical refresh credential lifetime is missing')
  } else {
    if (!en.includes(`${refreshDays} days`)) {
      problems.push('English refresh credential copy is stale')
    }
    if (!ja.includes(`${refreshDays} 日`)) {
      problems.push('Japanese refresh credential copy is stale')
    }
  }

  return problems
}

export async function checkProductContracts(root) {
  const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
  const [canonical, cli, en, ja, api] = await Promise.all([
    read('apps/web/app/lib/product-contracts.ts'),
    read('packages/cli/src/command-runners/share.ts'),
    read('apps/web/app/i18n/en.json'),
    read('apps/web/app/i18n/ja.json'),
    read('apps/web/app/routes/api.shareables.uploads.tsx'),
  ])
  return productContractProblems({ canonical, cli, en, ja, api })
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMain) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const problems = await checkProductContracts(root)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`)
    process.exitCode = 1
  } else {
    console.log('product contract check ok')
  }
}
