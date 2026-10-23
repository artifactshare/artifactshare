import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkBundles,
  checkAndRemoveBundles,
} from './check-production-dependency-bundles.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dependency-bundles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await chunk(root, 'server/index.js', 'export const server = true', [
    'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',
  ])
  await chunk(root, 'client/index.js', 'export const client = true', [
    'app/entry.client.tsx',
  ])
  return root
}

async function chunk(root, name, code, sources) {
  const file = path.join(root, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, code)
  await writeFile(
    `${file}.map`,
    JSON.stringify({ version: 3, sources, names: [], mappings: 'AAAA' }),
  )
}

test('accepts server-only SDK evidence and reports both targets', async (t) => {
  const report = await checkBundles(await fixture(t))
  assert(report.some((line) => line.includes('server: 1 chunks')))
  assert(report.some((line) => line.includes('client: 1 chunks')))
})

test('removes the entire evidence build after successful analysis', async (t) => {
  const root = await fixture(t)
  const report = await checkAndRemoveBundles(root)
  assert(report.some((line) => line.includes('server: 1 chunks')))
  assert(report.some((line) => line.includes('client: 1 chunks')))
  await assert.rejects(stat(root), { code: 'ENOENT' })
})

test('removes the entire evidence build when analysis fails', async (t) => {
  const root = await fixture(t)
  await chunk(root, 'server/assets/lazy.js', 'export const bad = true', [
    'node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js',
  ])
  await assert.rejects(checkAndRemoveBundles(root), /MCP OAuth client/u)
  await assert.rejects(stat(root), { code: 'ENOENT' })
})

test('fails on missing build directory and missing or malformed maps', async (t) => {
  const root = await fixture(t)
  await assert.rejects(checkBundles(path.join(root, 'missing')), /ENOENT/u)
  await rm(path.join(root, 'server/index.js.map'))
  await assert.rejects(checkBundles(root), /ENOENT/u)
  await writeFile(path.join(root, 'server/index.js.map'), '{}')
  await assert.rejects(checkBundles(root), /Invalid source map/u)
})

test('rejects OAuth client modules in lazy server chunks', async (t) => {
  const root = await fixture(t)
  await chunk(root, 'server/assets/lazy.js', 'export const bad = true', [
    'node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js',
  ])
  await assert.rejects(checkBundles(root), /MCP OAuth client/u)
})

for (const code of [
  'import "@modelcontextprotocol/sdk"',
  'import(`@modelcontextprotocol/sdk/client/auth.js`)',
  'import "@modelcontextprotocol/sdk/client/auth.js"',
  'export * from "@modelcontextprotocol/sdk/client/auth.js"',
  'import("@modelcontextprotocol/sdk/client/auth.js")',
  'require("@modelcontextprotocol/sdk/client/auth.js")',
  'import "@modelcontextprotocol/sdk/server/mcp.js"',
]) {
  test(`rejects external SDK graph: ${code}`, async (t) => {
    const root = await fixture(t)
    await chunk(root, 'server/external.js', code, ['app/entry.ts'])
    await assert.rejects(
      checkBundles(root),
      /MCP OAuth client|Unbundled MCP SDK/u,
    )
  })
}

test('accepts mapless re-export facades only with analyzed local targets', async (t) => {
  const root = await fixture(t)
  const facade = path.join(root, 'server/facade.js')
  await writeFile(
    facade,
    'import { server as loader } from "./index.js"; export { loader };',
  )
  assert(
    (await checkBundles(root)).some((line) =>
      line.includes('mapless import/re-export facade'),
    ),
  )
  await writeFile(facade, 'export * from "./missing.js"')
  await assert.rejects(checkBundles(root), /Unresolved mapless facade/u)
  await writeFile(facade, 'import "./index.js"; console.log("runtime code")')
  await assert.rejects(checkBundles(root), /ENOENT/u)
})

test('reports unresolved runtime imports instead of claiming they were analyzed', async (t) => {
  const root = await fixture(t)
  await chunk(root, 'server/routes.js', 'import(route.module)', [
    'framework/router.js',
  ])
  assert(
    (await checkBundles(root)).some((line) =>
      line.includes('runtime-selected import (unresolved): route.module'),
    ),
  )
  await chunk(
    root,
    'server/routes.js',
    'import("@modelcontextprotocol/sdk/" + name)',
    ['app/entry.ts'],
  )
  await assert.rejects(checkBundles(root), /Dynamic MCP SDK import/u)
})

test('accepts empty chunks but rejects runtime filename spoofing without maps', async (t) => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'client/empty.js'), '')
  assert(
    (await checkBundles(root)).some((line) =>
      line.includes('mapless empty chunk'),
    ),
  )
  await writeFile(
    path.join(root, 'server/rolldown-runtime.js'),
    'export const runtime = true',
  )
  await assert.rejects(checkBundles(root), /ENOENT/u)
})

test('accepts JSON route manifests but rejects executable manifest payloads', async (t) => {
  const root = await fixture(t)
  const file = path.join(root, 'client/manifest.js')
  await writeFile(file, 'window.__reactRouterManifest={"routes":{}};')
  assert(
    (await checkBundles(root)).some((line) =>
      line.includes('JSON route manifest'),
    ),
  )
  await writeFile(file, 'window.__reactRouterManifest=loadRoutes();')
  await assert.rejects(checkBundles(root), SyntaxError)
})

// Reviewed interop-only runtime emitted by the pinned Rolldown 1.2.14.
const reviewedRuntime =
  '//#region \\0rolldown/runtime.js\nvar __create = Object.create;\nvar __defProp = Object.defineProperty;\nvar __getOwnPropDesc = Object.getOwnPropertyDescriptor;\nvar __getOwnPropNames = Object.getOwnPropertyNames;\nvar __getProtoOf = Object.getPrototypeOf;\nvar __hasOwnProp = Object.prototype.hasOwnProperty;\nvar __esmMin = (fn, res, err) => () => {\n\tif (err) throw err[0];\n\ttry {\n\t\treturn fn && (res = fn(fn = 0)), res;\n\t} catch (e) {\n\t\tthrow err = [e], e;\n\t}\n};\nvar __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);\nvar __exportAll = (all, no_symbols) => {\n\tlet target = {};\n\tfor (var name in all) __defProp(target, name, {\n\t\tget: all[name],\n\t\tenumerable: true\n\t});\n\tif (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });\n\treturn target;\n};\nvar __copyProps = (to, from, except, desc) => {\n\tif (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {\n\t\tkey = keys[i];\n\t\tif (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {\n\t\t\tget: ((k) => from[k]).bind(null, key),\n\t\t\tenumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable\n\t\t});\n\t}\n\treturn to;\n};\nvar __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {\n\tvalue: mod,\n\tenumerable: true\n}) : target, mod));\nvar __toCommonJS = (mod) => __hasOwnProp.call(mod, "module.exports") ? mod["module.exports"] : __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n//#endregion\nexport { __toESM as a, __toCommonJS as i, __esmMin as n, __exportAll as r, __commonJSMin as t };\n'

test('accepts the reviewed mapless runtime but rejects modified code', async (t) => {
  const root = await fixture(t)
  const file = path.join(root, 'server/rolldown-runtime.js')
  await writeFile(file, reviewedRuntime)
  assert(
    (await checkBundles(root)).some((line) =>
      line.includes('reviewed Rolldown runtime'),
    ),
  )
  await writeFile(
    file,
    reviewedRuntime + '\nimport("@modelcontextprotocol/sdk/client/auth.js")',
  )
  await assert.rejects(checkBundles(root), /ENOENT/u)
})

for (const target of ['server', 'client']) {
  for (const dependency of [
    'vitest/dist/index.js',
    '@vitest/mocker/dist/index.js',
    'vite-plus/test',
    'vite-plus/test/index.js',
    '@voidzero-dev/vite-plus-test',
    '@voidzero-dev/vite-plus-test/dist/index.js',
  ]) {
    test(`rejects bundled ${dependency} in ${target} lazy chunks`, async (t) => {
      const root = await fixture(t)
      await chunk(root, `${target}/assets/test.js`, 'export const bad = true', [
        `node_modules/${dependency}`,
      ])
      await assert.rejects(checkBundles(root), /Vitest module or import/u)
    })
    test(`rejects external ${dependency} in ${target}`, async (t) => {
      const root = await fixture(t)
      await chunk(root, `${target}/external.js`, `import("${dependency}")`, [
        'app/entry.ts',
      ])
      await assert.rejects(checkBundles(root), /Vitest module or import/u)
    })
  }
  test(`rejects runtime-selected Vitest imports in ${target}`, async (t) => {
    const root = await fixture(t)
    await chunk(root, `${target}/external.js`, 'import("@vitest/" + name)', [
      'app/entry.ts',
    ])
    await assert.rejects(checkBundles(root), /Dynamic Vitest import/u)
  })
}
