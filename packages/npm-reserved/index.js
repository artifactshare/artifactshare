#!/usr/bin/env node

console.error(
  'The "artifactshare" npm package name is reserved. Use @artifactshare/cli for the supported Artifact Share CLI.',
)
console.error('Run: npx --yes @artifactshare/cli --help')
process.exitCode = 1
