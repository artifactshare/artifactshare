import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))

const APP_ROOT = join('apps', 'web', 'app')
const IMPORT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
]
const MODULE_ALIAS = /^~\/modules\/([^/]+)(?:\/(.*))?$/u

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isInside(directory, file) {
  const child = relative(directory, file)
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

function resolveFile(base) {
  const candidates = [
    base,
    ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]
  return candidates.find(isFile) ?? null
}

function normalizeFilename(root, filename) {
  return isAbsolute(filename) ? resolve(filename) : resolve(root, filename)
}

export function resolveModuleImport({
  root = DEFAULT_ROOT,
  importer,
  specifier,
}) {
  if (typeof specifier !== 'string') return null
  const importerPath = normalizeFilename(root, importer)
  let base
  const alias = specifier.match(MODULE_ALIAS)
  if (alias) {
    if (alias[1] === '.' || alias[1] === '..') return null
    base = join(root, APP_ROOT, 'modules', alias[1], alias[2] ?? '')
  } else if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    base = resolve(dirname(importerPath), specifier)
  } else return null
  return resolveFile(base)
}

export function findModuleBoundary({
  root = DEFAULT_ROOT,
  importer,
  specifier,
}) {
  const rootPath = resolve(root)
  const importerPath = normalizeFilename(rootPath, importer)
  const target = resolveModuleImport({
    root: rootPath,
    importer: importerPath,
    specifier,
  })
  if (!target) return null

  const modulesRoot = join(rootPath, APP_ROOT, 'modules')
  const targetRelative = relative(modulesRoot, target)
  if (targetRelative === '' || !isInside(modulesRoot, target)) return null
  const [moduleName] = targetRelative.split(sep)
  if (!moduleName) return null

  const moduleDirectory = join(modulesRoot, moduleName)
  const publicEntry = join(moduleDirectory, 'index.ts')
  if (!isFile(publicEntry) || !isInside(moduleDirectory, target)) return null
  if (
    resolve(target) === resolve(publicEntry) ||
    isInside(moduleDirectory, importerPath)
  )
    return null

  return {
    importer: importerPath,
    moduleName,
    publicEntry: resolve(publicEntry),
    target: resolve(target),
  }
}

function sourceSpecifier(source) {
  return source?.type === 'Literal' && typeof source.value === 'string'
    ? source.value
    : null
}

function relativeDisplay(root, file) {
  return relative(root, file).replaceAll('\\', '/')
}

export function createModuleBoundaryRule({ root = DEFAULT_ROOT } = {}) {
  const rootPath = resolve(root)
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'keep imports from app module internals behind the module public entry',
      },
      schema: [],
    },
    create(context) {
      function reportSource(source) {
        const specifier = sourceSpecifier(source)
        if (!specifier) return
        const violation = findModuleBoundary({
          root: rootPath,
          importer: context.filename,
          specifier,
        })
        if (!violation) return
        context.report({
          node: source,
          message: `Import "${specifier}" in "${relativeDisplay(rootPath, violation.importer)}" reaches internal app module file "${relativeDisplay(rootPath, violation.target)}"; import "~/modules/${violation.moduleName}" (public entry "${relativeDisplay(rootPath, violation.publicEntry)}") instead.`,
        })
      }

      function check(node) {
        reportSource(node.source)
      }

      function checkMock(node) {
        const callee = node.callee
        if (
          callee?.type !== 'MemberExpression' ||
          callee.object?.type !== 'Identifier' ||
          callee.object.name !== 'vi' ||
          callee.computed ||
          callee.property?.type !== 'Identifier' ||
          callee.property.name !== 'mock'
        )
          return
        reportSource(node.arguments[0])
      }

      return {
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
        ImportExpression: check,
        TSImportType: check,
        CallExpression: checkMock,
      }
    },
  }
}

export default {
  meta: { name: 'module-boundary' },
  rules: {
    'no-internal-imports': createModuleBoundaryRule(),
  },
}
