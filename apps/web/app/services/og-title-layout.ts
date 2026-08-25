import { loadDefaultJapaneseParser } from 'budoux'

const parser = loadDefaultJapaneseParser()
const HAS_JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const JAPANESE_CHARACTER =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]'
const JAPANESE_PARTICLE = '[のにをはがへとで]'
const CLOSING_PUNCTUATION = /^[、。，．）」』】〉》〕］｝！？!?]/u
const FORBIDDEN_JAPANESE_LINE_START =
  /^[、。，．）」』】〉》〕］｝！？!?ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー]/u
const FORBIDDEN_JAPANESE_LINE_END = /[（「『【〈《〔［｛]$/u
const NON_JAPANESE_TOKEN =
  /(?:https?:\/\/|www\.)\S+|[\p{Script=Latin}\p{Number}][\p{Script=Latin}\p{Number}._:/?#%&=+@~-]*|./gu

export type OgTitleLayout = {
  fontSize: 48 | 58 | 68 | 76
  lines: string[]
  segments: string[]
  text: string
}

export function layoutOgTitle(
  value: string,
  maxFontSize: OgTitleLayout['fontSize'] = 76,
): OgTitleLayout {
  const whitespaceNormalized = value.trim().replace(/\s+/gu, ' ')
  const japanese = HAS_JAPANESE.test(whitespaceNormalized)
  const normalized = japanese
    ? whitespaceNormalized
        .replace(
          new RegExp(
            `(${JAPANESE_CHARACTER})\\s+(?=${JAPANESE_CHARACTER})`,
            'gu',
          ),
          '$1',
        )
        .replace(new RegExp(`\\s+(${JAPANESE_PARTICLE})`, 'gu'), '$1')
        .replace(new RegExp(`(${JAPANESE_PARTICLE})\\s+`, 'gu'), '$1')
    : whitespaceNormalized
  const maxLength = japanese ? 66 : 96
  const text = truncateAtBoundary(normalized, maxLength, japanese)
  const length = [...text].length
  const naturalFontSize =
    length <= 28 ? 76 : length <= 44 ? 68 : length <= 58 ? 58 : 48
  const fontSize = Math.min(
    naturalFontSize,
    maxFontSize,
  ) as OgTitleLayout['fontSize']

  const segments = japanese
    ? normalizeJapaneseSegments(parser.parse(text))
    : text.split(' ').filter(Boolean)
  return {
    fontSize,
    lines: wrapSegments(segments, fontSize, japanese),
    segments,
    text,
  }
}

function wrapSegments(
  segments: string[],
  fontSize: OgTitleLayout['fontSize'],
  japanese: boolean,
): string[] {
  const maxUnits = 1056 / fontSize
  const wrappableSegments = japanese
    ? segments.flatMap((segment) =>
        measureUnits(segment) > maxUnits
          ? splitJapaneseSegment(segment)
          : [segment],
      )
    : segments
  for (let lineCount = 1; lineCount <= 3; lineCount += 1) {
    const balanced = findBalancedLines(
      wrappableSegments,
      lineCount,
      japanese,
      maxUnits,
    )
    if (balanced) {
      return balanced.map((group) => joinLine(group, japanese))
    }
  }

  // More than three lines are required. Keep the longest token-safe prefix
  // that fits and mark the omission without splitting a URL or identifier.
  const lineGroups: string[][] = []
  let line: string[] = []
  for (const segment of wrappableSegments) {
    if (measureUnits(segment) > maxUnits) {
      if (line.length) lineGroups.push(line)
      return overflowLines(lineGroups, japanese, maxUnits)
    }
    const candidate = [...line, segment]
    if (line.length && measureUnits(joinLine(candidate, japanese)) > maxUnits) {
      lineGroups.push(line)
      if (lineGroups.length === 3) {
        return overflowLines(lineGroups, japanese, maxUnits)
      }
      line = [segment]
    } else {
      line = candidate
    }
  }
  if (line.length) lineGroups.push(line)
  return lineGroups.map((group) => joinLine(group, japanese))
}

function splitJapaneseSegment(value: string): string[] {
  return value.match(NON_JAPANESE_TOKEN) ?? [value]
}

function findBalancedLines(
  segments: string[],
  lineCount: number,
  japanese: boolean,
  maxUnits: number,
): string[][] | null {
  if (segments.length < lineCount) return null
  const totalUnits = measureUnits(joinLine(segments, japanese))
  const targetUnits = totalUnits / lineCount
  const memo = new Map<string, { cost: number; groups: string[][] } | null>()

  function visit(
    start: number,
    remaining: number,
  ): { cost: number; groups: string[][] } | null {
    const key = `${start}:${remaining}`
    if (memo.has(key)) return memo.get(key)!
    if (remaining === 1) {
      const group = segments.slice(start)
      const width = measureUnits(joinLine(group, japanese))
      const result =
        group.length &&
        width <= maxUnits &&
        hasValidJapaneseLineEdges(group, japanese)
          ? { cost: (width - targetUnits) ** 2, groups: [group] }
          : null
      memo.set(key, result)
      return result
    }

    let best: { cost: number; groups: string[][] } | null = null
    const lastEnd = segments.length - remaining + 1
    for (let end = start + 1; end <= lastEnd; end += 1) {
      const group = segments.slice(start, end)
      const width = measureUnits(joinLine(group, japanese))
      if (width > maxUnits) break
      if (!hasValidJapaneseLineEdges(group, japanese)) continue
      const tail = visit(end, remaining - 1)
      if (!tail) continue
      const candidate = {
        cost: (width - targetUnits) ** 2 + tail.cost,
        groups: [group, ...tail.groups],
      }
      if (!best || candidate.cost < best.cost) best = candidate
    }
    memo.set(key, best)
    return best
  }

  return visit(0, lineCount)?.groups ?? null
}

function hasValidJapaneseLineEdges(
  group: string[],
  japanese: boolean,
): boolean {
  if (!japanese) return true
  const rawLine = joinLine(group, true)
  const line = rawLine.trim()
  return (
    rawLine === line &&
    !FORBIDDEN_JAPANESE_LINE_START.test(line) &&
    !FORBIDDEN_JAPANESE_LINE_END.test(line)
  )
}

function overflowLines(
  groups: string[][],
  japanese: boolean,
  maxUnits: number,
): string[] {
  if (!groups.length) return ['…']
  const visible = groups.slice(0, 3)
  const last = visible.at(-1)!
  while (
    last.length &&
    measureUnits(`${joinLine(last, japanese)}…`) > maxUnits
  ) {
    last.pop()
  }
  const lines = visible.map((group) => joinLine(group, japanese))
  lines[lines.length - 1] = `${lines.at(-1) || ''}…`
  return lines
}

function joinLine(segments: string[], japanese: boolean): string {
  return segments.join(japanese ? '' : ' ')
}

function measureUnits(value: string): number {
  let units = 0
  for (const character of value) {
    if (/\s/u.test(character)) units += 0.28
    else if (/[\x20-\x7e]/u.test(character)) units += 0.56
    else if (/[、。，．！？!?]/u.test(character)) units += 0.5
    else units += 1
  }
  return units
}

function normalizeJapaneseSegments(input: string[]): string[] {
  const segments = input.flatMap((segment) => {
    const trimmed = segment.trim()
    return trimmed ? [trimmed] : []
  })
  for (let index = 1; index < segments.length; index += 1) {
    if (CLOSING_PUNCTUATION.test(segments[index]!)) {
      segments[index - 1] += segments[index]
      segments.splice(index, 1)
      index -= 1
    }
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (/[（「『【〈《〔［｛]$/u.test(segments[index]!)) {
      segments[index] += segments[index + 1]
      segments.splice(index + 1, 1)
      index -= 1
    }
  }
  if (segments.length > 1 && [...segments.at(-1)!].length <= 2) {
    segments[segments.length - 2] += segments.pop()
  }
  return segments
}

function truncateAtBoundary(
  value: string,
  maxLength: number,
  japanese: boolean,
): string {
  const characters = [...value]
  if (characters.length <= maxLength) return value
  const slice = characters
    .slice(0, maxLength - 1)
    .join('')
    .trimEnd()
  const boundary = japanese
    ? Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('、'))
    : slice.lastIndexOf(' ')
  if (!japanese && boundary < Math.floor(maxLength * 0.7)) return '…'
  const safe =
    boundary >= Math.floor(maxLength * 0.7) ? slice.slice(0, boundary) : slice
  return `${safe.trimEnd()}…`
}
