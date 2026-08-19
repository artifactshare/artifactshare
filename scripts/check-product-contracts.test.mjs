import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkProductContracts,
  productContractProblems,
} from './check-product-contracts.mjs'

const aligned = {
  canonical: `
    export const ARTIFACT_KEY_MAX_LENGTH = 128
    export const REFRESH_CREDENTIAL_TTL_DAYS = 180
  `,
  cli: 'const MAX_SHARE_KEY_LENGTH = 128',
  en: 'The credential expires after 180 days without activity.',
  ja: '資格情報は 180 日間無活動で期限切れになります。',
  api: '`publish_key must be 1-${ARTIFACT_KEY_MAX_LENGTH} characters`',
}

test('accepts aligned cross-package and localized product contracts', () => {
  assert.deepEqual(productContractProblems(aligned), [])
})

test('rejects CLI publish-key drift and stale API guidance', () => {
  const problems = productContractProblems({
    ...aligned,
    cli: 'const MAX_SHARE_KEY_LENGTH = 129',
    api: 'publish_key must be 1-128 characters',
  })
  assert.deepEqual(problems, [
    'CLI artifact key length 129 does not match 128',
    'API artifact key error does not derive from the contract',
  ])
})

test('rejects stale English and Japanese credential lifetime copy', () => {
  const problems = productContractProblems({
    ...aligned,
    en: 'The credential expires after 90 days without activity.',
    ja: '資格情報は 90 日間無活動で期限切れになります。',
  })
  assert.deepEqual(problems, [
    'English refresh credential copy is stale',
    'Japanese refresh credential copy is stale',
  ])
})

test('the repository product contracts are aligned', async () => {
  assert.deepEqual(await checkProductContracts(process.cwd()), [])
})
