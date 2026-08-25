import assert from 'node:assert/strict'
import fs from 'node:fs'

const packagePath = 'packages/npm-reserved/package.json'
const readmePath = 'packages/npm-reserved/README.md'
const binPath = 'packages/npm-reserved/index.js'
const supportedPackage = '@artifactshare/cli'

const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const readme = fs.readFileSync(readmePath, 'utf8')
const bin = fs.readFileSync(binPath, 'utf8')

assert.equal(manifest.name, 'artifactshare')
assert.match(manifest.version, /^0\.0\.0-reserved\.\d+$/u)
assert.equal(manifest.license, 'UNLICENSED')
assert.equal(manifest.private, undefined)
assert.deepEqual(manifest.files, ['index.js', 'README.md'])
assert.equal(manifest.bin?.artifactshare, 'index.js')
assert.match(manifest.description, /@artifactshare\/cli/u)
assert.match(manifest.deprecated, /@artifactshare\/cli/u)
assert.match(readme, /@artifactshare\/cli/u)
assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/@artifactshare\/cli/u)
assert.match(
  readme,
  /https:\/\/github\.com\/artifactshare\/artifactshare\/tree\/main\/packages\/cli/u,
)
assert.ok(!readme.includes('techtalkjp'))
assert.equal(bin.startsWith('#!/usr/bin/env node\n'), true)
assert.match(bin, new RegExp(supportedPackage.replace('/', '\\/'), 'u'))
assert.match(bin, /process\.exitCode = 1/u)

console.log('Reserved npm package metadata and recovery guidance are valid.')
