import { expect, test, vi } from 'vitest'
import * as acorn from 'acorn'
import { scriptStrings, jsonStrings, scriptElementStrings } from './literals'

test('keeps literals in source order across deeply nested member expressions', () => {
  expect(
    scriptStrings(
      'const first="先頭"; a' +
        '.x'.repeat(50_000) +
        ';const label="日本語"; const last=`前半${"途中"}後半`;',
    ),
  ).toBe('先頭 日本語 前半 途中 後半')
})

test('discards optional scripts that exhaust the parser stack', () => {
  expect(scriptStrings('("日本語")')).toBe('日本語')
  expect(
    scriptStrings('('.repeat(20_000) + '"日本語"' + ')'.repeat(20_000)),
  ).toBe('')
})

test('extracts Japanese literals and static template fragments without comments or computed output', () => {
  expect(
    scriptStrings(
      '// "コメント"\nconst a="英語 English"; /* "除外" */ const b="English only"; const c=`前半${value}後半`; const d="\\u65e5本";',
    ),
  ).toBe('英語 English 前半 後半 日本')
})
test('extracts nested JSON string values, excluding keys and English-only strings', () => {
  expect(
    jsonStrings('{"日本語キー": ["English", {"a": "日本語"}], "b": 123}'),
  ).toBe('日本語')
})

test('does not mistake regex contents or commented quotes for string literals', () => {
  expect(
    scriptStrings(
      'const r = /["日本語"]+/u; const n = 4 / 2; const label = "採用"; // "除外"',
    ),
  ).toBe('採用')
})

test('isolates malformed JSON while retaining valid asset strings', () => {
  expect(jsonStrings('{broken')).toBe('')
  expect(jsonStrings('{"label":"日本語"}')).toBe('日本語')
})

test('recognizes regex statements after control conditions without hiding following literals', () => {
  for (const condition of [
    'if (enabled)',
    'while (ready())',
    'for (; ready(); step())',
    'with (scope)',
  ]) {
    expect(
      scriptStrings(condition + ' /"/.test(value); const label = "日本語";'),
    ).toBe('日本語')
    expect(
      scriptStrings(
        condition + ' /"偽陽性"/.test(value); const label = "日本語";',
      ),
    ).toBe('日本語')
  }
  expect(
    scriptStrings('const ratio = (count + 1) / 2; const label = "日本語";'),
  ).toBe('日本語')
})

test('distinguishes statement blocks and else/do bodies from expression endings', () => {
  for (const statement of [
    'if (enabled) {} /"/.test(value);',
    'if (enabled) { if (ready) {} } /"偽陽性"/.test(value);',
    'if (enabled) {} else /"/.test(value);',
    'do /"偽陽性"/.test(value); while (enabled);',
  ]) {
    expect(scriptStrings(statement + ' const label = "日本語";')).toBe('日本語')
  }
  expect(scriptStrings('const ratio = {} / 2; const label = "日本語";')).toBe(
    '日本語',
  )
})

test('treats keyword property calls as expressions before division', () => {
  for (const property of [
    'if',
    'while',
    'for',
    'with',
    'switch',
    'catch',
    'else',
    'do',
    'return',
  ]) {
    expect(
      scriptStrings('obj.' + property + '(x) / 2; const label = "日本語";'),
    ).toBe('日本語')
    expect(
      scriptStrings(
        'obj?. /* comment */ ' + property + '(x) / 2; const label = "日本語";',
      ),
    ).toBe('日本語')
  }
})

test('keeps literals after function declarations and postfix division, excluding regex text', () => {
  for (const source of [
    'function f() {} /"/.test(value); const label = "日本語";',
    'function f() {} /"偽陽性"/.test(value); const label = "日本語";',
    'const ratio = count++ / 2; const label = "日本語";',
    'if (enabled) /"/.test(value); const label = "日本語";',
  ])
    expect(scriptStrings(source)).toBe('日本語')
})

test('discards partial strings when optional JavaScript cannot be tokenized', () => {
  expect(scriptStrings('const label = "日本語"; "unterminated')).toBe('')
  expect(scriptStrings('const label = "日本語";')).toBe('日本語')
  expect(scriptStrings('export const label = "日本語";')).toBe('日本語')
})

test('isolates parser stack exhaustion but propagates unexpected parser failures', () => {
  const parser = vi.spyOn(acorn.Parser, 'parse')
  try {
    parser.mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    expect(scriptStrings('const label="日本語";')).toBe('')
    const failure = new Error('unexpected parser failure')
    parser.mockImplementation(() => {
      throw failure
    })
    expect(() => scriptStrings('const label="日本語";')).toThrow(failure)
  } finally {
    parser.mockRestore()
  }
})

test('visits deeply nested JSON values in order without exhausting the stack', () => {
  expect(
    jsonStrings('['.repeat(10_000) + '"日本語"' + ']'.repeat(10_000)),
  ).toBe('日本語')
  expect(jsonStrings('{"a":["先頭",{"b":"途中"}],"c":"末尾"}')).toBe(
    '先頭 途中 末尾',
  )
})

test('isolates JSON parser stack exhaustion and propagates unexpected failures', () => {
  const parser = vi.spyOn(JSON, 'parse')
  try {
    parser.mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    expect(jsonStrings('[]')).toBe('')
    const failure = new Error('unexpected parser failure')
    parser.mockImplementation(() => {
      throw failure
    })
    expect(() => jsonStrings('[]')).toThrow(failure)
  } finally {
    parser.mockRestore()
  }
})

test('selects JavaScript parsing for default, module and HTML JavaScript MIME types', () => {
  for (const type of [
    '',
    '  ',
    'module',
    ' Text/JavaScript ; charset=utf-8 ',
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript',
    'text/javascript1.0',
    'text/javascript1.1',
    'text/javascript1.2',
    'text/javascript1.3',
    'text/javascript1.4',
    'text/javascript1.5',
    'text/jscript',
    'text/livescript',
    'text/x-ecmascript',
    'text/x-javascript',
  ])
    expect(scriptElementStrings('const label="日本語"; // "除外"', type)).toBe(
      '日本語',
    )
})

test('selects JSON values for structured script types', () => {
  for (const type of [
    'application/json',
    'application/ld+json',
    'importmap',
    'speculationrules',
    ' Application/Custom+JSON ; charset=utf-8 ',
  ])
    expect(
      scriptElementStrings(
        '{"props":{"label":"日本語"},"日本語キー":"English"}',
        type,
      ),
    ).toBe('日本語')
})

test('retains Japanese plain text runs for non-code script types', () => {
  for (const type of ['text/template', 'text/x-template', 'custom'])
    expect(
      scriptElementStrings('日本語の案内 English only "未完了', type),
    ).toBe('日本語の案内 "未完了')
})
