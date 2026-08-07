import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPACING_OWNERSHIP_POLICY } from './spacing-ownership-policy.mjs'
import {
  INTERACTIVE_SPACING_ANNOTATION,
  isAllowedInteractiveSpacingSource,
} from './interactive-spacing-annotation-policy.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const APP_DIR = join(ROOT, 'apps/web/app')
const STYLES_DIR = join(APP_DIR, 'styles')
export const APP_CSS = join(APP_DIR, 'app.css')
const CATALOG_TS = join(APP_DIR, 'components/catalog.ts')
const TOKENS_CSS = join(STYLES_DIR, 'tokens.css')
const ROOT_TSX = join(APP_DIR, 'root.tsx')
const DESIGN_SYSTEM_MD = join(ROOT, 'docs/reference/design-system.md')
export { SPACING_OWNERSHIP_POLICY }

export function findInteractiveSpacingAnnotationViolations(files, root = ROOT) {
  const violations = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    if (
      content.includes(INTERACTIVE_SPACING_ANNOTATION) &&
      !isAllowedInteractiveSpacingSource(file, root)
    )
      violations.push({
        file: relative(root, file).split('\\').join('/'),
        detail: `${INTERACTIVE_SPACING_ANNOTATION} is restricted to owning shared UI components`,
      })
  }
  return violations
}

export function findInteractiveSpacingAnnotationViolationsInApp(
  appDir,
  root = ROOT,
) {
  return findInteractiveSpacingAnnotationViolations(
    walkSourceFiles(appDir, false).filter(
      (file) => !/\.(?:test|spec)\.tsx?$/.test(file),
    ),
    root,
  )
}

export function findFontSourceViolations(appCss, rootTsx) {
  const activeAppCss = stripCssComments(appCss)
  const definitions = [...activeAppCss.matchAll(/--font-sans\s*:/g)].length
  const violations = []
  if (
    definitions !== 1 ||
    !/--font-sans\s*:\s*['"]Geist Variable['"]/.test(activeAppCss) ||
    !/@import\s+['"]@fontsource-variable\/geist['"]\s*;/.test(activeAppCss)
  ) {
    violations.push({
      file: APP_CSS,
      detail:
        "app.css must import @fontsource-variable/geist and define --font-sans once with 'Geist Variable' first",
    })
  }
  if (/https:\/\/fonts\.(googleapis|gstatic)\.com/i.test(rootTsx)) {
    violations.push({
      file: ROOT_TSX,
      detail: 'root.tsx must not load Google Fonts globally',
    })
  }
  return violations
}

export function findDesignSystemVersionViolations(document) {
  const current = document.match(/現行仕様\s+v(\d+\.\d+)/)?.[1]
  const history = [...document.matchAll(/\|\s*[^|]+\|\s*v(\d+\.\d+)\s*\|/g)]
  const latest = history.at(-1)?.[1]
  if (!current || !latest) {
    return ['current version and latest history version must both be present']
  }
  return current !== latest
    ? [`current version v${current} does not match latest history v${latest}`]
    : []
}

export function findBreakpointDocumentationViolations(document) {
  const section = document.match(
    /## 10\. Breakpoints([\s\S]*?)(?=\n## |$)/,
  )?.[1]
  if (section === undefined) {
    return ['Breakpoints section must be present']
  }
  return /\b\d+px\b/.test(section)
    ? ['Breakpoints section must not duplicate px values']
    : []
}

// Grid track definitions are structural values, not spacing token targets.
const NUMERIC_LITERAL_ALLOW_HEADS = new Set([
  'grid-cols',
  'grid-rows',
  'auto-cols',
  'auto-rows',
])

// Unlisted CSS color functions default to deny. Add new ones (e.g. hwb) here
// when they cause false positives.
const COLOR_FUNCTIONS = [
  'color-mix',
  'color',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'oklch',
  'oklab',
  'lab',
  'lch',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
]

const COLOR_FUNCTION_RES = COLOR_FUNCTIONS.map(
  (fn) => new RegExp(`\\b${fn.replace(/-/g, '\\-')}\\(`, 'g'),
)

const EXEMPT_LITERAL_PATTERNS = [/\bvar\(/g, /\burl\(/gi, ...COLOR_FUNCTION_RES]

const HEX_LITERAL_RE =
  /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/g

const VAR_DEF_RE = /--([A-Za-z0-9_-]+)\s*:/g
const VAR_REF_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g

const VAR_REF_WHITELIST_PREFIXES = ['--tw-', '--radix-']
const VAR_REF_WHITELIST_EXACT = new Set(['--spacing'])

// Strip comments while respecting string literals, so `/*` or `//` inside a
// string (a URL like `https://…`, a CSS `content` value) is not mistaken for a
// comment and does not swallow real tokens on the same line. `lineComments`
// enables `//` handling for TSX; CSS has only `/* */`.
function stripCommentsRespectingStrings(text, { lineComments }) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      out += char
      if (char === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || (lineComments && char === '`')) {
      quote = char
      out += char
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 1
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1
      }
      i += 1
      continue
    }
    if (lineComments && char === '/' && text[i + 1] === '/') {
      i += 1
      while (
        i + 1 < text.length &&
        text[i + 1] !== '\n' &&
        text[i + 1] !== '\r'
      ) {
        i += 1
      }
      continue
    }
    out += char
  }
  return out
}

export function stripCssComments(text) {
  return stripCommentsRespectingStrings(text, { lineComments: false })
}

export function stripTsxComments(text) {
  return stripCommentsRespectingStrings(text, { lineComments: true })
}

function scanBalanced(text, openIndex, open, close) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') {
        i += 1
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) {
      depth += 1
    } else if (char === close) {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

function extractBalancedParens(text, openParenIndex) {
  const closeIndex = scanBalanced(text, openParenIndex, '(', ')')
  if (closeIndex === -1) {
    return null
  }
  return text.slice(openParenIndex, closeIndex + 1)
}

function findClosingBracket(text, openBracketIndex) {
  return scanBalanced(text, openBracketIndex, '[', ']')
}

function* iterateQuotedStringContents(text, quoteIndex) {
  const quote = text[quoteIndex]
  const start = quoteIndex + 1
  let i = start
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) {
      yield text.slice(start, i)
      return i + 1
    }
    i += 1
  }
  return i
}

function* iterateTemplateLiteralContents(text, backtickIndex) {
  let segmentStart = backtickIndex + 1
  let i = segmentStart
  let interpolationDepth = 0

  while (i < text.length) {
    if (interpolationDepth === 0) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '$' && text[i + 1] === '{') {
        yield text.slice(segmentStart, i)
        i += 2
        interpolationDepth = 1
        continue
      }
      if (text[i] === '`') {
        yield text.slice(segmentStart, i)
        return i + 1
      }
      i += 1
      continue
    }

    const char = text[i]
    if (char === '"' || char === "'") {
      i = yield* iterateQuotedStringContents(text, i)
      continue
    }
    if (char === '`') {
      i = yield* iterateTemplateLiteralContents(text, i)
      continue
    }
    if (char === '{') {
      interpolationDepth += 1
    } else if (char === '}') {
      interpolationDepth -= 1
      if (interpolationDepth === 0) {
        segmentStart = i + 1
      }
    }
    i += 1
  }

  return i
}

function* iterateStringLiteralContents(text) {
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '"' || char === "'") {
      i = yield* iterateQuotedStringContents(text, i)
      continue
    }
    if (char === '`') {
      i = yield* iterateTemplateLiteralContents(text, i)
      continue
    }
    i += 1
  }
}

function getUtilityHeadRange(text, bracketOpenIndex) {
  const prev = text[bracketOpenIndex - 1]
  if (prev !== '-' && prev !== '/') {
    return null
  }

  const separatorIndex = bracketOpenIndex - 1
  let start = separatorIndex - 1
  while (start >= 0 && /[a-zA-Z0-9_-]/.test(text[start])) {
    start -= 1
  }
  start += 1
  const head = text.slice(start, separatorIndex)

  if (!head) {
    return null
  }
  if (start > 0 && /[\w.]/.test(text[start - 1])) {
    return null
  }

  return { start, head }
}

function stripQuotedStringsFromValue(text) {
  let remaining = ''
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '"' || char === "'") {
      const quote = char
      i += 1
      let closed = false
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === quote) {
          closed = true
          i += 1
          break
        }
        i += 1
      }
      if (!closed) {
        return { unclosed: true, remaining: '' }
      }
      continue
    }
    remaining += char
    i += 1
  }
  return { unclosed: false, remaining }
}

function findLeftmostExemptLiteral(text) {
  let earliest = null

  for (const pattern of EXEMPT_LITERAL_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const openParenIndex = match.index + match[0].length - 1
      const extracted = extractBalancedParens(text, openParenIndex)
      if (extracted) {
        const candidate = {
          index: match.index,
          length: openParenIndex - match.index + extracted.length,
        }
        if (!earliest || candidate.index < earliest.index) {
          earliest = candidate
        }
      }
    }
  }

  for (const match of text.matchAll(HEX_LITERAL_RE)) {
    const candidate = { index: match.index, length: match[0].length }
    if (!earliest || candidate.index < earliest.index) {
      earliest = candidate
    }
  }

  return earliest
}

function stripExemptedLiterals(text) {
  let remaining = text
  while (true) {
    const match = findLeftmostExemptLiteral(remaining)
    if (!match) {
      return remaining
    }
    remaining =
      remaining.slice(0, match.index) +
      remaining.slice(match.index + match.length)
  }
}

// quote/exempt の前処理を共通化する。unclosed (${} 分割) は安全側に倒すため null を返す。
function prepareValueForNumericCheck(value) {
  const quoted = stripQuotedStringsFromValue(value)
  if (quoted.unclosed) {
    return null
  }
  return stripExemptedLiterals(quoted.remaining)
}

function valueContainsNumericLiteral(value) {
  const typeHintMatch = value.match(/^([a-z-]+):/)
  if (typeHintMatch?.[1] === 'url') {
    return false
  }

  const remaining = prepareValueForNumericCheck(value.replace(/^[a-z-]+:/, ''))
  if (remaining === null) {
    return true
  }
  return /[0-9]/.test(remaining)
}

// 先頭境界 (^|[^a-zA-Z]) が要点: `&_h1` の h1 のような「英字直後の数字」(セレクタ内の
// 要素名) を除外し、`520px` / `.5` / `(3)` のような独立した数値だけを拾う。
const VARIANT_NUMERIC_LITERAL_RE = /(?:^|[^a-zA-Z])(\d+\.?\d*|\.\d+)/

const ARBITRARY_PROPERTY_RE = /^(-{0,2}[a-zA-Z][a-zA-Z0-9_-]*):(.*)$/s

function variantValueContainsNumericLiteral(value) {
  let remaining = prepareValueForNumericCheck(value)
  if (remaining === null) {
    return true
  }
  // セレクタ variant の構造値は長さリテラルではないので除外する:
  // 擬似クラス関数の引数 (:nth-child(3) 等) と属性値 ([aria-level=2] 等)。
  remaining = remaining
    .replace(/:[a-zA-Z-]+\([^)]*\)/g, '')
    .replace(/=[^\]&]*/g, '')
  return VARIANT_NUMERIC_LITERAL_RE.test(remaining)
}

function arbitraryPropertyValue(segment, openIndex, closeIndex) {
  const content = segment.slice(openIndex + 1, closeIndex)
  const match = content.match(ARBITRARY_PROPERTY_RE)
  if (!match) {
    return null
  }
  return match[2]
}

function findLiteralBracketViolationsInSegment(segment) {
  const matches = []
  const lastColonIndex = segment.lastIndexOf(':')

  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] !== '[') {
      continue
    }

    const headRange = getUtilityHeadRange(segment, i)

    // head なし bracket の違反 (variant / 任意プロパティ) は : を必要とするため、
    // 以降に : が無ければ違反になり得ない。scanBalanced を払う前に O(1) で弾く。
    // 例外: ${} 分割され得るセレクタ variant (`[&...`) は : が次 segment に落ちるので通す。
    if (!headRange && i > lastColonIndex && segment[i + 1] !== '&') {
      continue
    }
    const closeIndex = findClosingBracket(segment, i)
    if (closeIndex === -1) {
      // Template-literal ${} can split an arbitrary value across segments; we cannot
      // statically inspect the full bracket, so deny unconditionally on the safe side.
      if (headRange) {
        matches.push(segment.slice(headRange.start))
      } else if (
        // head なしでも [prop:...${x}...] の任意プロパティと [&...${x}...] の
        // セレクタ variant は同様に deny する。
        ARBITRARY_PROPERTY_RE.test(segment.slice(i + 1)) ||
        segment[i + 1] === '&'
      ) {
        matches.push(segment.slice(i))
      }
      continue
    }

    const isVariant = segment[closeIndex + 1] === ':'
    const bracketValue = segment.slice(i + 1, closeIndex)
    const violationEnd = isVariant ? closeIndex + 2 : closeIndex + 1
    const matchStart = headRange ? headRange.start : i

    if (isVariant) {
      if (variantValueContainsNumericLiteral(bracketValue)) {
        matches.push(segment.slice(matchStart, violationEnd))
      }
      continue
    }

    if (!headRange) {
      const propValue = arbitraryPropertyValue(segment, i, closeIndex)
      if (propValue !== null && valueContainsNumericLiteral(propValue)) {
        matches.push(segment.slice(i, violationEnd))
      }
      continue
    }

    const normalizedHead = headRange.head.replace(/^-+/, '')
    if (NUMERIC_LITERAL_ALLOW_HEADS.has(normalizedHead)) {
      continue
    }

    if (valueContainsNumericLiteral(bracketValue)) {
      matches.push(segment.slice(headRange.start, closeIndex + 1))
    }
  }

  return matches
}

export function findLiteralBracketViolations(text) {
  const stripped = stripTsxComments(text)
  const matches = []

  for (const literalContent of iterateStringLiteralContents(stripped)) {
    matches.push(...findLiteralBracketViolationsInSegment(literalContent))
  }

  return matches
}

const COLOR_UTILITY_HEAD_RE =
  /^(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|divide(?:-[xy])?|decoration|caret|accent|placeholder|from|to|via)-\[/
const COMPOSITE_COLOR_RE =
  /^(?:color-mix|linear-gradient|radial-gradient|conic-gradient)\(/i

function splitTokenVariantsAndUtility(token) {
  let bracketDepth = 0
  let lastColon = -1
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i]
    if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth -= 1
    } else if (char === ':' && bracketDepth === 0) {
      lastColon = i
    }
  }
  if (lastColon === -1) {
    return { variants: '', utility: token }
  }
  return {
    variants: token.slice(0, lastColon),
    utility: token.slice(lastColon + 1),
  }
}

function normalizeColorUtility(utility) {
  return utility.replace(/^!+/, '').replace(/!+$/, '')
}

function findColorBracketViolationsInSegment(segment) {
  const matches = []
  for (const token of segment.split(/\s+/).filter(Boolean)) {
    const { utility } = splitTokenVariantsAndUtility(token)
    const normalizedUtility = normalizeColorUtility(utility)
    const bracketIndex = normalizedUtility.indexOf('[')
    if (bracketIndex === -1 || !COLOR_UTILITY_HEAD_RE.test(normalizedUtility)) {
      continue
    }
    const closeIndex = findClosingBracket(normalizedUtility, bracketIndex)
    if (closeIndex === -1) {
      matches.push(token)
      continue
    }
    let value = normalizedUtility.slice(bracketIndex + 1, closeIndex)
    if (value.startsWith('length:')) continue
    if (value.startsWith('color:')) value = value.slice('color:'.length)
    if (COMPOSITE_COLOR_RE.test(value)) continue
    if (
      HEX_LITERAL_RE.test(value) ||
      /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(/i.test(value) ||
      /\bvar\(/.test(value)
    ) {
      matches.push(token)
    }
    HEX_LITERAL_RE.lastIndex = 0
  }
  return matches
}

export function findColorBracketViolations(text) {
  const stripped = stripTsxComments(text)
  const matches = []
  for (const literalContent of iterateStringLiteralContents(stripped)) {
    matches.push(...findColorBracketViolationsInSegment(literalContent))
  }
  return matches
}

export function isColorBracketScanPath(file) {
  const normalized = file.replaceAll('\\', '/')
  return !(
    normalized.includes('/emails/') ||
    normalized.endsWith('/lib/markdown-render.ts') ||
    normalized.endsWith('/lib/csp-reporter.ts') ||
    normalized.endsWith('/components/app/google-mark.tsx') ||
    normalized.endsWith('/components/app/microsoft-mark.tsx') ||
    normalized.endsWith('/components/catalog.ts')
  )
}

export function findForbiddenRingTokenDefinitions(cssText) {
  const stripped = stripCssComments(cssText)
  const quoted = stripQuotedStringsFromValue(stripped)
  const scanText = quoted.unclosed ? stripped : quoted.remaining
  const violations = []
  for (const match of scanText.matchAll(VAR_DEF_RE)) {
    const name = `--${match[1]}`
    if (name.startsWith('--ring-') && name !== '--ring-hairline') {
      violations.push(name)
    }
  }
  return violations
}

export function collectDefinedVariables(cssTexts) {
  const defined = new Set()
  for (const css of cssTexts) {
    const stripped = stripCssComments(css)
    for (const match of stripped.matchAll(VAR_DEF_RE)) {
      defined.add(`--${match[1]}`)
    }
  }
  return defined
}

function isWhitelistedVar(varName) {
  if (VAR_REF_WHITELIST_EXACT.has(varName)) {
    return true
  }
  return VAR_REF_WHITELIST_PREFIXES.some((prefix) => varName.startsWith(prefix))
}

// A dynamic var name (`var(--avatar-${i})`) can't be resolved statically, so it
// is skipped. Scope the check to this var() call — from `var(` to its closing
// paren — so an unrelated `${…}` elsewhere on the line does not exempt a
// genuinely hard-coded undefined var. The var-name capture stops at `$`, so
// `${` sits at or just after the match end when the name is interpolated.
function hasTemplateInterpolation(text, matchIndex, matchLength) {
  const callEnd = text.indexOf(')', matchIndex)
  const scanEnd = callEnd === -1 ? matchIndex + matchLength + 2 : callEnd
  return text.slice(matchIndex, scanEnd).includes('${')
}

function extractAtThemeBlock(css) {
  const stripped = stripCssComments(css)
  const match = stripped.match(/@theme\s*\{/)
  if (!match) {
    return null
  }
  const braceStart = match.index + match[0].length - 1
  const closeIndex = scanBalanced(stripped, braceStart, '{', '}')
  if (closeIndex === -1) {
    return null
  }
  return stripped.slice(braceStart + 1, closeIndex)
}

export function collectThemeBreakpointNames(appCss) {
  const themeBlock = extractAtThemeBlock(appCss)
  if (!themeBlock) {
    return new Set()
  }
  const names = new Set()
  for (const varName of collectDefinedVariables([themeBlock])) {
    if (varName.startsWith('--breakpoint-')) {
      names.add(varName.slice('--breakpoint-'.length))
    }
  }
  return names
}

const NUMERIC_MAX_MIN_BREAKPOINT_RE = /\b(?:max|min)-(\d+):/g
// Breakpoint px values are 520+; require 3+ digits to avoid `step 1:` false positives.
// Lookahead limits matches to Tailwind utility starts after the colon.
const BARE_NUMERIC_BREAKPOINT_RE = /(?:^|[\s/`"'{:])(\d{3,}):(?=[a-z![-])/g
const UNKNOWN_BREAKPOINT_VARIANT_RE =
  /(?:^|[\s"'`{:])((?:max|min)-([a-z][A-Za-z0-9_-]*):)(?=[a-z![-])/g
const TAILWIND_DEFAULT_BREAKPOINTS = new Set(['sm', 'md', 'lg', 'xl', '2xl'])

export function findNumericBreakpointVariants(source) {
  const stripped = stripTsxComments(source)
  const violations = []
  const seen = new Set()

  for (const literalContent of iterateStringLiteralContents(stripped)) {
    for (const pattern of [
      NUMERIC_MAX_MIN_BREAKPOINT_RE,
      BARE_NUMERIC_BREAKPOINT_RE,
    ]) {
      pattern.lastIndex = 0
      for (const match of literalContent.matchAll(pattern)) {
        const token =
          pattern === NUMERIC_MAX_MIN_BREAKPOINT_RE
            ? match[0].trim()
            : `${match[1]}:`
        if (seen.has(token)) {
          continue
        }
        seen.add(token)
        violations.push(token)
      }
    }
  }

  return violations
}

export function findUnknownBreakpointVariants(source, definedBreakpointNames) {
  const stripped = stripTsxComments(source)
  const violations = []
  const seen = new Set()

  for (const literalContent of iterateStringLiteralContents(stripped)) {
    UNKNOWN_BREAKPOINT_VARIANT_RE.lastIndex = 0
    for (const match of literalContent.matchAll(
      UNKNOWN_BREAKPOINT_VARIANT_RE,
    )) {
      const name = match[2]
      // Skip @theme breakpoints and Tailwind defaults; flag everything else.
      if (
        definedBreakpointNames.has(name) ||
        TAILWIND_DEFAULT_BREAKPOINTS.has(name)
      ) {
        continue
      }
      const token = match[1]
      if (seen.has(token)) {
        continue
      }
      seen.add(token)
      violations.push(token)
    }
  }

  return violations
}

const MEDIA_RULE_RE = /@media\b\s*([^{]+)\{/g

const ALLOWED_MIN_MAX_WIDTH_RE =
  /^\(\s*(?:min-width|max-width)\s*:\s*theme\(--breakpoint-[A-Za-z0-9_-]+\)\s*\)$/i
const ALLOWED_WIDTH_COMPARISON_RE =
  /^\(\s*width\s*(?:<=|>=|<|>)\s*theme\(--breakpoint-[A-Za-z0-9_-]+\)\s*\)$/i

function isAllowedWidthCondition(unit) {
  return (
    ALLOWED_MIN_MAX_WIDTH_RE.test(unit) ||
    ALLOWED_WIDTH_COMPARISON_RE.test(unit)
  )
}

function mediaConditionHasDisallowedWidth(condition) {
  const text = condition.trim()
  if (!/\bwidth\b/i.test(text)) {
    return false
  }

  const segments = text.split(/\band\b/i).map((segment) => segment.trim())
  for (const segment of segments) {
    if (!/\bwidth\b/i.test(segment)) {
      continue
    }
    if (!isAllowedWidthCondition(segment)) {
      return true
    }
  }

  return false
}

export function findRawWidthMediaQueries(cssSource) {
  const stripped = stripCssComments(cssSource)
  const violations = []
  const seen = new Set()

  for (const match of stripped.matchAll(MEDIA_RULE_RE)) {
    const condition = match[1].trim()
    if (!mediaConditionHasDisallowedWidth(condition)) {
      continue
    }
    const detail = `@media ${condition}`
    if (seen.has(detail)) {
      continue
    }
    seen.add(detail)
    violations.push(detail)
  }

  return violations
}

const THEME_BREAKPOINT_REF_RE = /theme\(\s*--breakpoint-([A-Za-z0-9_-]+)\s*\)/g

export function findUndefinedThemeBreakpointReferences(cssSources) {
  const appCssEntry = cssSources.find((entry) => entry.path === APP_CSS)
  if (!appCssEntry) {
    throw new Error('app.css not found in cssSources')
  }
  const defined = collectThemeBreakpointNames(appCssEntry.content)
  const violations = []
  const seen = new Set()

  for (const { path, content } of cssSources) {
    const stripped = stripCssComments(content)
    for (const match of stripped.matchAll(THEME_BREAKPOINT_REF_RE)) {
      const name = match[1]
      if (defined.has(name)) {
        continue
      }
      const detail = `theme(--breakpoint-${name})`
      const key = `${rel(path)}@${detail}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      violations.push({ file: rel(path), detail })
    }
  }

  return violations
}

export function findUndefinedVarReferences(
  text,
  definedVars,
  { stripComments = stripCssComments } = {},
) {
  const stripped = stripComments(text)
  const violations = []
  const seen = new Set()

  for (const match of stripped.matchAll(VAR_REF_RE)) {
    const varName = match[1]
    const hasFallback = match[2] === ','
    const key = `${varName}@${match.index}`

    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    if (hasFallback) {
      continue
    }
    if (hasTemplateInterpolation(stripped, match.index, match[0].length)) {
      continue
    }
    if (isWhitelistedVar(varName)) {
      continue
    }
    if (varName.includes('--line-height') && varName.startsWith('--text-')) {
      continue
    }
    if (!definedVars.has(varName)) {
      violations.push(varName)
    }
  }

  return violations
}

export function normalizeSelector(selector) {
  return selector.replace(/\s+/g, ' ').trim()
}

export function findDuplicateSelectors(css) {
  const stripped = stripCssComments(css)
  const counts = new Map()
  const duplicates = []
  let depth = 0
  let blockStart = 0
  let quote = null

  for (let i = 0; i < stripped.length; i += 1) {
    const char = stripped[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      if (depth === 0) {
        const prelude = stripped.slice(blockStart, i).trim()
        if (prelude && !prelude.startsWith('@')) {
          const normalized = normalizeSelector(prelude)
          const count = (counts.get(normalized) ?? 0) + 1
          counts.set(normalized, count)
          if (count === 2) {
            duplicates.push(normalized)
          }
        }
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        blockStart = i + 1
      }
    }
  }

  return duplicates
}

// Remove quoted substrings so a class-shaped token inside a string (an attribute
// selector value `[data-kind=".as-fake"]`) is not mistaken for a real selector.
function stripQuotedRanges(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    out += char
  }
  return out
}

// A `.name` class or `#name` id selector. In a real rule prelude (after comment +
// quoted-range stripping) a `.`/`#` can only introduce a class/id selector —
// declaration values and attribute-value strings never reach here. The one non-
// class/id use of `.` in a prelude is a keyframe percentage (`12.5%`); since CSS
// identifiers cannot start with a digit, a `.`/`#` followed by a digit is that
// percentage (or hex/decimal noise), not a selector, and everything else — letters,
// `_`, `-`/`--` custom-ident names, non-ASCII (`.カード`), escapes (`.\31 23`) — is.
const CLASS_OR_ID_SELECTOR_RE = /[.#](?![0-9])/

// Global CSS (app.css + styles/*.css) is limited to token definitions, a few base
// styles, and document-level view-transition rules — all of which target :root,
// elements, attributes, or view-transition pseudo-elements, never a class or id.
// Report any rule prelude that carries a class/id selector (component-style CSS),
// which subsumes the retired `as-*` baseline (an `as-*` class is a class selector).
// The walker uses the same string-aware brace walk as `findDuplicateSelectors`,
// with comments stripped up front and quoted ranges stripped per prelude. Like the
// retired `collectAsClasses`, `;` also resets the prelude (not just `}`) so a class
// rule right after a top-level `@import "x";` is not judged as part of the @import.
// At-rule blocks are walked into (their nested rules are
// judged at their own `{`); an at-rule's own prelude — a media/feature/layer/
// keyframe header, not a component definition — is not scanned, so
// `@supports selector(.foo)` (a feature test) does not false-positive. `@scope` is
// the one exception: its prelude selector defines an active style scope, a bypass,
// so `@scope` usage itself is denied. Element/attribute-only rules (`article > h1`)
// are not flagged — that is a detection limit, not a normative allowance; the
// global-css-scope.md placement rules still apply and are enforced in review.
export function findForbiddenGlobalSelectors(css) {
  const stripped = stripCssComments(css)
  const violations = []
  let blockStart = 0
  let quote = null

  for (let i = 0; i < stripped.length; i += 1) {
    const char = stripped[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      const rawPrelude = stripQuotedRanges(stripped.slice(blockStart, i))
      const prelude = rawPrelude.trim()
      if (prelude.startsWith('@')) {
        // CSS at-keywords are ASCII case-insensitive, so match `@scope` with /i
        // — otherwise `@SCOPE (.foo)` skips both this check and the class scan.
        if (/^@scope\b/i.test(prelude)) {
          violations.push(normalizeSelector(rawPrelude))
        }
      } else if (prelude && CLASS_OR_ID_SELECTOR_RE.test(prelude)) {
        violations.push(normalizeSelector(rawPrelude))
      }
      blockStart = i + 1
    } else if (char === '}' || char === ';') {
      // Reset at every statement terminator — a top-level `@import "x";` or an
      // in-block declaration must not bleed into the next selector's prelude.
      blockStart = i + 1
    }
  }

  return violations
}

function excludeThemeInlineBlock(css) {
  const marker = '@theme inline'
  const start = css.indexOf(marker)
  if (start === -1) {
    return css
  }
  const braceStart = css.indexOf('{', start)
  if (braceStart === -1) {
    return css
  }

  let depth = 0
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1
    } else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(0, start) + css.slice(i + 1)
      }
    }
  }

  return css
}

function walkSourceFiles(dir, skipUi = false) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      if (skipUi && entry === 'ui' && fullPath.includes('components/ui')) {
        continue
      }
      if (skipUi && fullPath.endsWith('components/ui')) {
        continue
      }
      files.push(...walkSourceFiles(fullPath, skipUi))
    } else if (/\.tsx?$/.test(entry)) {
      if (skipUi && fullPath.includes('/components/ui/')) {
        continue
      }
      files.push(fullPath)
    }
  }
  return files
}

function rel(path) {
  return relative(ROOT, path)
}

const LAYOUT_PRIMITIVE_IMPORT_RE =
  /import\s*\{([^}]+)\}\s*from\s*['"](?:~\/components\/layout\/(?:stack|inline)|\.\/(?:stack|inline)|(?:\.\.?\/)+(?:[^'"]*\/)?layout\/(?:stack|inline))['"]/g

const LAYOUT_DISPLAY_CLASSES = new Set([
  'flex',
  'inline-flex',
  'block',
  'inline-block',
  'inline',
  'grid',
  'inline-grid',
  'contents',
  'flow-root',
  'hidden',
  'list-item',
  'table',
  'inline-table',
])

const LAYOUT_FLEX_SIZING_CLASSES = new Set([
  'flex-1',
  'flex-auto',
  'flex-none',
  'flex-initial',
  'grow',
  'shrink',
])

const LAYOUT_ALIGNMENT_PREFIXES = [
  'items-',
  'justify-',
  'self-',
  'place-items-',
  'place-content-',
  'place-self-',
]

const LAYOUT_CONTENT_ALIGNMENT_RE =
  /^content-(?:normal|center|start|end|between|around|evenly|baseline|stretch)(?:-(?:safe|unsafe))?$/

function parseLayoutPrimitiveImportNames(importClause) {
  const names = []
  for (const part of importClause.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) {
      continue
    }
    const aliasMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/)
    if (aliasMatch) {
      const [, imported, local] = aliasMatch
      if (imported === 'Stack' || imported === 'Inline') names.push(local)
      continue
    }
    const nameMatch = trimmed.match(/^(\w+)$/)
    if (!nameMatch) {
      continue
    }
    const name = nameMatch[1]
    if (name === 'Stack' || name === 'Inline') {
      names.push(name)
    }
  }
  return names
}

export function collectLayoutPrimitiveImportNames(content) {
  const stripped = stripTsxComments(content)
  const names = new Set()
  for (const match of stripped.matchAll(LAYOUT_PRIMITIVE_IMPORT_RE)) {
    for (const name of parseLayoutPrimitiveImportNames(match[1])) {
      names.add(name)
    }
  }
  return names
}

function extractBalancedExpression(text, openBraceIndex) {
  let depth = 0
  let quote = null
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') {
        i += 1
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(openBraceIndex + 1, i)
      }
    }
  }
  return null
}

function extractClassNameValuesFromTag(tagText) {
  const values = []
  let index = 0
  while (index < tagText.length) {
    const match = tagText.slice(index).match(/\bclassName\s*=\s*/)
    if (!match || match.index === undefined) {
      break
    }
    const valueStart = index + match.index + match[0].length
    const quote = tagText[valueStart]
    if (quote === '"' || quote === "'") {
      const end = tagText.indexOf(quote, valueStart + 1)
      if (end === -1) {
        break
      }
      values.push(tagText.slice(valueStart + 1, end))
      index = end + 1
      continue
    }
    if (tagText[valueStart] === '{') {
      const expr = extractBalancedExpression(tagText, valueStart)
      if (expr === null) {
        break
      }
      const trimmed = expr.trim()
      const directString = trimmed.match(/^(['"])([\s\S]*)\1$/)
      if (directString) {
        values.push(directString[2])
      } else {
        const cnMatch = trimmed.match(/^(?:cn|clsx)\s*\(([\s\S]*)\)$/)
        if (cnMatch) {
          values.push(...extractStringLiteralsFromCnArgs(cnMatch[1]))
        }
      }
      index = valueStart + expr.length + 2
      continue
    }
    break
  }
  return values
}

function collectStaticClassConstants(content) {
  const constants = new Map()
  const stripped = stripTsxComments(content)
  for (const match of stripTsxComments(content).matchAll(
    /\bconst\s+(\w+)\s*=\s*(['"`])([^'"`$]*)\2\s*;?/g,
  )) {
    constants.set(match[1], match[3])
  }
  for (const match of stripped.matchAll(
    /\bconst\s+(\w+)\s*=\s*\[([\s\S]*?)\]\s*;?/g,
  )) {
    const values = splitCallArguments(match[2]).flatMap((value) => {
      const literal = value.trim().match(/^(['"`])([^'"`$]*)\1$/)
      return literal ? [literal[2]] : (constants.get(value.trim()) ?? [])
    })
    if (values.length) constants.set(match[1], values.join(' '))
  }
  return constants
}

function resolveStaticClassExpression(expression, constants, depth = 0) {
  if (depth > 4) return []
  const trimmed = expression.trim()
  const literal = trimmed.match(/^(['"`])([^'"`$]*)\1$/)
  if (literal) return [literal[2]]
  const reference = constants.get(trimmed)
  if (reference !== undefined) return [reference]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitCallArguments(trimmed.slice(1, -1)).flatMap((arg) =>
      resolveStaticClassExpression(arg, constants, depth + 1),
    )
  }
  const call = trimmed.match(/^(?:cn|clsx)\s*\(([\s\S]*)\)$/)
  if (!call) {
    return [...trimmed.matchAll(/(['"])([^'"]*)\1/g)].map((match) => match[2])
  }
  const result = []
  for (const arg of splitCallArguments(call[1])) {
    const object = arg.match(/^\{([\s\S]*)\}$/)
    if (object) {
      result.push(...extractStaticObjectKeys(object[1]))
    } else {
      result.push(...resolveStaticClassExpression(arg, constants, depth + 1))
    }
  }
  return result
}

function extractStaticObjectKeys(content) {
  const keys = []
  for (const match of content.matchAll(
    /(?:^|,)\s*(?:(['"])(.*?)\1|([\w:-]+))\s*:/g,
  )) {
    keys.push(match[2] ?? match[3])
  }
  return keys
}

function isStaticClassExpression(expression, constants, depth = 0) {
  if (depth > 4) return false
  const trimmed = expression.trim()
  if (/^(['"`])([^'"`$]*)\1$/.test(trimmed)) return true
  if (constants.has(trimmed)) return true
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitCallArguments(trimmed.slice(1, -1)).every((arg) =>
      isStaticClassExpression(arg, constants, depth + 1),
    )
  }
  const call = trimmed.match(/^(?:cn|clsx)\s*\(([\s\S]*)\)$/)
  if (!call) return false
  return splitCallArguments(call[1]).every((arg) => {
    const object = arg.trim().match(/^\{([\s\S]*)\}$/)
    return object
      ? extractStaticObjectKeys(object[1]).length > 0
      : isStaticClassExpression(arg, constants, depth + 1)
  })
}

function splitCallArguments(text) {
  const args = []
  let start = 0
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ',' && depth === 0) {
      args.push(text.slice(start, i))
      start = i + 1
    }
  }
  args.push(text.slice(start))
  return args
}

function extractResolvedClassNameValues(tagText, constants) {
  const values = []
  let index = 0
  while (index < tagText.length) {
    const match = tagText.slice(index).match(/\bclassName\s*=\s*/)
    if (!match || match.index === undefined) break
    const start = index + match.index + match[0].length
    if (tagText[start] === '"' || tagText[start] === "'") {
      const end = tagText.indexOf(tagText[start], start + 1)
      if (end < 0) break
      values.push(tagText.slice(start + 1, end))
      index = end + 1
      continue
    }
    if (tagText[start] === '{') {
      const expr = extractBalancedExpression(tagText, start)
      if (expr === null) break
      values.push(...resolveStaticClassExpression(expr, constants))
      index = start + expr.length + 2
      continue
    }
    break
  }
  return values
}

function hasUnresolvedClassNameExpression(tagText, constants) {
  const match = tagText.match(/\bclassName\s*=\s*/)
  if (!match || match.index === undefined) return false
  const start = match.index + match[0].length
  if (tagText[start] !== '{') return false
  const expression = extractBalancedExpression(tagText, start)
  return expression === null || !isStaticClassExpression(expression, constants)
}

function extractStringLiteralsFromCnArgs(argsText) {
  const literals = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < argsText.length; i += 1) {
    const char = argsText[i]
    if (quote) {
      if (char === '\\') {
        current += char
        const next = argsText[i + 1]
        if (next !== undefined) {
          current += next
          i += 1
        }
        continue
      }
      if (char === quote) {
        literals.push(current)
        current = ''
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      if (depth === 0) {
        quote = char
        current = ''
      }
      continue
    }
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
    }
  }
  return literals
}

function stripResponsiveVariantPrefix(token) {
  const idx = token.lastIndexOf(':')
  if (idx === -1) {
    return token
  }
  return token.slice(idx + 1)
}

function isLayoutFlexSizingClass(base) {
  if (LAYOUT_FLEX_SIZING_CLASSES.has(base)) {
    return true
  }
  return base.startsWith('grow-') || base.startsWith('shrink-')
}

function isTableDisplayClass(base) {
  return base.startsWith('table-')
}

function isForbiddenLayoutPrimitiveClass(token) {
  const base = stripResponsiveVariantPrefix(token)
  if (!base) {
    return false
  }
  if (isLayoutFlexSizingClass(base)) {
    return false
  }
  if (LAYOUT_DISPLAY_CLASSES.has(base)) {
    return true
  }
  if (isTableDisplayClass(base)) {
    return true
  }
  if (/^flex-(col|row)(-reverse)?$/.test(base)) {
    return true
  }
  if (
    base === 'flex-wrap' ||
    base === 'flex-nowrap' ||
    base === 'flex-wrap-reverse'
  ) {
    return true
  }
  if (
    base.startsWith('gap-') ||
    base.startsWith('gap-x-') ||
    base.startsWith('gap-y-')
  ) {
    return true
  }
  if (/^-?space-[xy]-/.test(base)) {
    return true
  }
  if (
    LAYOUT_ALIGNMENT_PREFIXES.some((prefix) => base.startsWith(prefix)) ||
    LAYOUT_CONTENT_ALIGNMENT_RE.test(base)
  ) {
    return true
  }
  if (/^-?m([trblxyse]|x|y)?-/.test(base) || base === 'm' || base === '-m') {
    return true
  }
  return false
}

export function findForbiddenLayoutPrimitiveClasses(classString) {
  const violations = []
  for (const token of classString.split(/\s+/)) {
    if (!token) {
      continue
    }
    if (isForbiddenLayoutPrimitiveClass(token)) {
      violations.push(token)
    }
  }
  return violations
}

export function scanOpeningTags(content) {
  const stripped = stripTsxComments(content)
  const tags = []
  let index = 0
  while (index < stripped.length) {
    const marker = stripped.slice(index).match(/<[A-Za-z][\w.]*/)
    const start = marker?.index === undefined ? -1 : index + marker.index
    if (start === -1) {
      break
    }
    const componentName = stripped.slice(start + 1).match(/^[A-Za-z][\w.]*/)[0]
    const afterName = start + componentName.length + 1
    const boundary = stripped[afterName]
    if (boundary && !/[\s/>]/.test(boundary)) {
      index = afterName
      continue
    }
    let cursor = afterName
    let quote = null
    let braceDepth = 0
    while (cursor < stripped.length) {
      const char = stripped[cursor]
      if (quote) {
        if (char === '\\') {
          cursor += 2
          continue
        }
        if (char === quote) {
          quote = null
        }
        cursor += 1
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        cursor += 1
        continue
      }
      if (char === '{') {
        braceDepth += 1
      } else if (char === '}') {
        braceDepth -= 1
      } else if ((char === '>' || char === '/') && braceDepth === 0) {
        const end =
          char === '/' && stripped[cursor + 1] === '>' ? cursor + 2 : cursor + 1
        tags.push({
          text: stripped.slice(start, end),
          offset: start,
          componentName,
        })
        index = end
        break
      }
      cursor += 1
    }
    if (cursor >= stripped.length) {
      break
    }
  }
  return tags
}

function extractOpeningTags(content, componentName) {
  return scanOpeningTags(content).filter(
    (tag) => tag.componentName === componentName,
  )
}

export function findLayoutPrimitiveClassNameViolations(content) {
  const importNames = collectLayoutPrimitiveImportNames(content)
  if (importNames.size === 0) {
    return []
  }
  const violations = []
  const seen = new Set()
  const constants = collectStaticClassConstants(content)
  for (const componentName of importNames) {
    for (const { text: tagText } of extractOpeningTags(
      content,
      componentName,
    )) {
      for (const classString of extractResolvedClassNameValues(
        tagText,
        constants,
      )) {
        for (const token of findForbiddenLayoutPrimitiveClasses(classString)) {
          const violation = `${componentName} className: ${token}`
          if (!seen.has(violation)) {
            seen.add(violation)
            violations.push(violation)
          }
        }
      }
    }
  }
  return violations
}

const SPACING_TOKEN_RE =
  /(?:^|[\s:])(-?m(?:[trblxyse]|x|y)?-(?:\[[^\]]+\]|[\w.]+)|-?m(?:-?\d+|auto))(?=$|[\s"'`}])/g
const REPORT_EXCLUSIONS = [
  {
    test: (file) => file.includes('/components/ui/'),
    category: 'excluded-surface',
    reason: 'shadcn/ui surface',
  },
  {
    test: (file, text) => /\bprose(?:[-\s]|$)/.test(text),
    category: 'excluded-surface',
    reason: 'prose surface',
  },
]

function classifySpacingCandidate(file, text, token) {
  for (const exclusion of REPORT_EXCLUSIONS)
    if (exclusion.test(file, text))
      return { category: exclusion.category, reason: exclusion.reason }
  if (
    /\b(?:absolute|fixed|sticky)\b/.test(text) ||
    /\b(?:scroll-m[trblxy]|scroll-m)\b/.test(text)
  )
    return { category: 'geometry', reason: 'positioning or scroll geometry' }
  if (/^-?m(?:[trblxyse]|x|y)?-0$/.test(token))
    return { category: 'internal-reset', reason: 'typography margin reset' }
  if (/^-m|:-m/.test(token) || /^-?m(?:[trblxyse]|x|y)?-auto$/.test(token))
    return { category: 'geometry', reason: 'negative or automatic margin' }
  return {
    category: 'ownership-review',
    reason: 'positive outer margin requires ownership review',
  }
}

function walkTsx(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (name.startsWith('.') || name === 'node_modules') continue
    if (statSync(path).isDirectory()) files.push(...walkTsx(path))
    else if (/\.(?:tsx?|jsx?)$/.test(name)) files.push(path)
  }
  return files
}

export function isSettingsRouteModule(file) {
  const relativePath = rel(file)
  const routePath = relativePath.replace(
    /^apps\/web\/app\/routes\/_protected\/settings\//,
    '',
  )
  return (
    relativePath.startsWith('apps/web/app/routes/_protected/settings/') &&
    routePath.endsWith('.tsx') &&
    !routePath.split('/').includes('+components') &&
    !/(?:\.test|\.spec|\.story)\.tsx$/.test(routePath)
  )
}

export function reportClassNameEntries(file, text) {
  const constants = collectStaticClassConstants(text)
  const entries = []
  const tagNames = new Set(
    [...text.matchAll(/<([A-Za-z][\w.]*)\b/g)].map((match) => match[1]),
  )
  for (const primitiveName of tagNames) {
    for (const { text: tag, offset } of extractOpeningTags(
      text,
      primitiveName,
    )) {
      for (const classString of extractResolvedClassNameValues(
        tag,
        constants,
      )) {
        for (const match of classString.matchAll(SPACING_TOKEN_RE)) {
          entries.push({
            file: rel(file),
            line: text.slice(0, offset).split(/\r?\n/).length,
            target: primitiveName,
            class: match[1],
            ...classifySpacingCandidate(file, classString, match[1]),
          })
        }
      }
      if (hasUnresolvedClassNameExpression(tag, constants)) {
        entries.push({
          file: rel(file),
          line: text.slice(0, offset).split(/\r?\n/).length,
          target: primitiveName,
          class: '<dynamic>',
          category: 'dynamic-review',
          reason: 'className expression is not statically resolvable',
          potentialSpacing: /(?:^|[\s'"`{(])(?:mt|mb|my|m)-\$\{/.test(tag),
        })
      }
    }
  }
  return entries
}

export function collectSpacingOwnershipReport(appDir = APP_DIR) {
  const report = []
  for (const file of walkTsx(appDir)) {
    if (/(?:\.test|\.spec|\.story)\.[jt]sx?$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    report.push(...reportClassNameEntries(file, text))
  }
  report.push(
    ...SPACING_OWNERSHIP_POLICY.map((entry) => ({
      ...entry,
      line: 0,
      target: entry.component,
      class: '',
      category: 'ownership-policy',
    })),
  )
  return report.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.class ?? '').localeCompare(b.class ?? ''),
  )
}

export function findSettingsRouteSpacingViolations(appDir = APP_DIR) {
  return findSettingsRouteSpacingViolationsFromReport(
    collectSpacingOwnershipReport(appDir),
  )
}

export function findSettingsRouteSpacingViolationsFromReport(entries) {
  return entries.filter(
    (entry) =>
      isSettingsRouteModule(join(ROOT, entry.file)) &&
      ((entry.category === 'dynamic-review' && entry.potentialSpacing) ||
        (entry.category === 'ownership-review' &&
          /^(?:mt|mb|my|m)-/.test(entry.class) &&
          !/^-|-(?:0|auto)$/.test(entry.class))),
  )
}

export function runAllChecks() {
  const violations = []
  const styleCssEntries = readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({
      path: join(STYLES_DIR, name),
      content: readFileSync(join(STYLES_DIR, name), 'utf8'),
    }))
  const styleCssContents = styleCssEntries.map((entry) => entry.content)
  const appCssContent = readFileSync(APP_CSS, 'utf8')
  const rootTsxContent = readFileSync(ROOT_TSX, 'utf8')
  const designSystemContent = readFileSync(DESIGN_SYSTEM_MD, 'utf8')
  for (const violation of findFontSourceViolations(
    appCssContent,
    rootTsxContent,
  )) {
    violations.push({
      check: 'font-source-sync',
      file: rel(violation.file),
      detail: violation.detail,
    })
  }
  for (const detail of findDesignSystemVersionViolations(designSystemContent)) {
    violations.push({
      check: 'design-system-version-sync',
      file: rel(DESIGN_SYSTEM_MD),
      detail,
    })
  }
  for (const detail of findBreakpointDocumentationViolations(
    designSystemContent,
  )) {
    violations.push({
      check: 'breakpoint-documentation-sync',
      file: rel(DESIGN_SYSTEM_MD),
      detail,
    })
  }
  const themeBreakpointNames = collectThemeBreakpointNames(appCssContent)

  // catalog.ts quotes class strings and var names as documentation, not as
  // applied styles, so it is excluded from every source scan.
  const sourceFiles = walkSourceFiles(APP_DIR, true).filter(
    (file) => file !== CATALOG_TS,
  )
  for (const entry of findInteractiveSpacingAnnotationViolationsInApp(APP_DIR))
    violations.push({ check: 'interactive-spacing-annotation', ...entry })
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    const matches = findLiteralBracketViolations(content)
    for (const match of matches) {
      violations.push({
        check: 'literal-bracket',
        file: rel(file),
        detail: match,
      })
    }
    for (const match of findLayoutPrimitiveClassNameViolations(content)) {
      violations.push({
        check: 'layout-primitive-classname',
        file: rel(file),
        detail: match,
      })
    }
    for (const match of findNumericBreakpointVariants(content)) {
      violations.push({
        check: 'numeric-breakpoint-variant',
        file: rel(file),
        detail: match,
      })
    }
    for (const match of findUnknownBreakpointVariants(
      content,
      themeBreakpointNames,
    )) {
      violations.push({
        check: 'unknown-breakpoint-variant',
        file: rel(file),
        detail: match,
      })
    }
  }

  const colorBracketSourceFiles = walkSourceFiles(APP_DIR, false).filter(
    isColorBracketScanPath,
  )
  for (const file of colorBracketSourceFiles) {
    const content = readFileSync(file, 'utf8')
    for (const match of findColorBracketViolations(content)) {
      violations.push({
        check: 'raw-color-bracket',
        file: rel(file),
        detail: match,
      })
    }
  }

  const tokensCssContent = readFileSync(TOKENS_CSS, 'utf8')
  for (const match of findForbiddenRingTokenDefinitions(tokensCssContent)) {
    violations.push({
      check: 'forbidden-ring-token',
      file: rel(TOKENS_CSS),
      detail: match,
    })
  }

  const definedVars = collectDefinedVariables([
    appCssContent,
    ...styleCssContents,
  ])

  const referenceSources = [
    ...styleCssEntries,
    {
      path: APP_CSS,
      content: excludeThemeInlineBlock(appCssContent),
    },
    ...sourceFiles.map((file) => ({
      path: file,
      content: readFileSync(file, 'utf8'),
    })),
  ]

  for (const { path, content } of referenceSources) {
    const isSourceFile = /\.tsx?$/.test(path)
    // Collect self-contained definitions from comment-stripped content so a
    // `--name:` mention in a line comment does not count as a definition.
    const fileDefinedVars = collectDefinedVariables([
      isSourceFile ? stripTsxComments(content) : content,
    ])
    const effectiveDefinedVars = new Set([...definedVars, ...fileDefinedVars])
    const undefinedVars = findUndefinedVarReferences(
      content,
      effectiveDefinedVars,
      {
        stripComments: isSourceFile ? stripTsxComments : stripCssComments,
      },
    )
    for (const varName of undefinedVars) {
      violations.push({
        check: 'undefined-var',
        file: rel(path),
        detail: varName,
      })
    }
  }

  const cssSources = [
    { path: APP_CSS, content: appCssContent },
    ...styleCssEntries,
  ]

  for (const { path, content } of cssSources) {
    for (const match of findRawWidthMediaQueries(content)) {
      violations.push({
        check: 'raw-width-media-query',
        file: rel(path),
        detail: match,
      })
    }
  }

  for (const { file, detail } of findUndefinedThemeBreakpointReferences(
    cssSources,
  )) {
    violations.push({
      check: 'undefined-theme-breakpoint',
      file,
      detail,
    })
  }

  for (const { path, content } of cssSources) {
    for (const selector of findDuplicateSelectors(content)) {
      violations.push({
        check: 'duplicate-selector',
        file: rel(path),
        detail: selector,
      })
    }
  }

  for (const { path, content } of cssSources) {
    for (const selector of findForbiddenGlobalSelectors(content)) {
      violations.push({
        check: 'global-css-selector',
        file: rel(path),
        detail: selector,
      })
    }
  }

  for (const entry of findSettingsRouteSpacingViolations()) {
    violations.push({
      check: 'settings-route-spacing-ownership',
      file: entry.file,
      detail: `${entry.target} className: ${entry.class}`,
    })
  }

  return violations
}

function isMainModule() {
  const argvPath = process.argv[1]
  if (!argvPath) {
    return false
  }
  return fileURLToPath(import.meta.url) === argvPath
}

if (isMainModule()) {
  if (process.argv.includes('--spacing-report')) {
    const report = collectSpacingOwnershipReport()
    const counts = Object.groupBy(report, (entry) => entry.category)
    console.log(`spacing ownership report (${report.length} entries)`)
    for (const category of [
      'ownership-review',
      'internal-reset',
      'geometry',
      'excluded-surface',
      'dynamic-review',
      'ownership-policy',
    ]) {
      console.log(`${category}: ${(counts[category] ?? []).length}`)
    }
    for (const entry of report) {
      console.log(
        `${entry.category}\t${entry.file}:${entry.line}\t${entry.target}\t${entry.class}\t${entry.reason}`,
      )
    }
    process.exit(0)
  }
  const violations = runAllChecks()

  if (violations.length > 0) {
    console.error('design token violations:')
    for (const v of violations) {
      console.error(`- [${v.check}] ${v.file}: ${v.detail}`)
    }
    process.exit(1)
  }
}
