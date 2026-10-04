import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, cp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseSync } from 'oxc-parser'
import {
  entryPath,
  generateReporter,
  renderReporter,
  validateBundle,
} from './build-reporter.mjs'

function chunk(code) {
  return { type: 'chunk', code, imports: [], dynamicImports: [], exports: [] }
}
const minimal = `(() => {
  "use strict";
  function capturePrimordials(win) { const savedParent = win.parent; return { savedParent }; }
  function installReporter(win) {
    if (win.parent === win) return;
    const primordials = capturePrimordials(win);
  }
  installReporter(window);
})();`

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reporter-generator-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('generation is deterministic and hashes the exact UTF-8 body', async () => {
  const first = await renderReporter()
  const second = await renderReporter()
  assert.deepEqual(second, first)
  assert.equal(
    first.hash,
    createHash('sha256').update(first.body, 'utf8').digest('base64'),
  )
  const { program, errors } = parseSync('reporter.generated.ts', first.source)
  assert.deepEqual(errors, [])
  const values = program.body.map(
    (node) => node.declaration.declarations[0].init.value,
  )
  assert.deepEqual(values, [first.body, first.hash])
  assert.doesNotMatch(first.body, /<\/script/i)
  assert.doesNotMatch(
    first.body,
    /#(?:end)?region|packages\/viewer-kit|reporter-generator-/,
  )
})

test('check succeeds on current data and never repairs missing or stale output', async (t) => {
  const directory = await temporary(t)
  const output = join(directory, 'reporter.generated.ts')
  await assert.rejects(
    generateReporter({ output, check: true }),
    /missing or stale/,
  )
  await assert.rejects(stat(output), { code: 'ENOENT' })
  const rendered = await generateReporter({ output })
  const before = await stat(output)
  await generateReporter({ output, check: true })
  assert.equal((await stat(output)).mtimeMs, before.mtimeMs)
  await writeFile(output, rendered.source + '// stale\n')
  const stale = await readFile(output, 'utf8')
  await assert.rejects(
    generateReporter({ output, check: true }),
    /missing or stale/,
  )
  assert.equal(await readFile(output, 'utf8'), stale)
})

test('a changed reporter source fails check without writing tracked or temporary output', async (t) => {
  const directory = await temporary(t)
  await cp(dirname(entryPath), join(directory, 'reporter'), { recursive: true })
  await cp(
    join(dirname(entryPath), '../reporter-constants.ts'),
    join(directory, 'reporter-constants.ts'),
  )
  const entry = join(directory, 'reporter/entry.ts')
  const output = join(directory, 'reporter.generated.ts')
  const before = await generateReporter({ entry, output })
  assert.equal(before.body, (await renderReporter()).body)
  const constants = join(directory, 'reporter-constants.ts')
  await writeFile(
    constants,
    (await readFile(constants, 'utf8')).replace('= 20', '= 21'),
  )
  await assert.rejects(
    generateReporter({ entry, output, check: true }),
    /missing or stale/,
  )
  assert.equal(await readFile(output, 'utf8'), before.source)
})

test('structural guard accepts inert declarations and the frame-guard/capture order', () => {
  assert.equal(validateBundle([chunk(minimal)]), minimal)
})

test('structural guard rejects added initialization, even without a known helper name', () => {
  for (const inserted of [
    'const property = Object.defineProperty;',
    'const innocent = () => Object.assign({}, {});',
    'window.reporter = {};',
    'Object.create(null);',
  ])
    assert.throws(
      () =>
        validateBundle([
          chunk(
            minimal.replace(
              'installReporter(window);',
              inserted + '\ninstallReporter(window);',
            ),
          ),
        ]),
      /Unsafe reporter bundle/,
    )
  assert.throws(
    () =>
      validateBundle([
        chunk(
          minimal.replace(
            'const primordials',
            'const state = {}; const primordials',
          ),
        ),
      ]),
    /capture must immediately follow/,
  )
  assert.throws(
    () =>
      validateBundle([
        chunk(minimal.replace('if (win.parent === win) return;', '')),
      ]),
    /top-level-frame guard/,
  )
  assert.throws(
    () => validateBundle([chunk('window.reporter = ' + minimal)]),
    /IIFE/,
  )
})

test('structural guard rejects unfamiliar helper declarations absent from source', () => {
  const code = minimal.replace(
    'installReporter(window);',
    'function innocentLooking() { return Object.assign({}, {}); } installReporter(window);',
  )
  assert.throws(
    () => validateBundle([chunk(code)]),
    /added function innocentLooking/,
  )
})

test('structural guard rejects transform helpers, imports, exports, and extra chunks/assets', () => {
  for (const name of [
    '__spreadValues',
    '__async',
    '__commonJS',
    '__export',
    '__toESM',
    '__name',
  ])
    assert.throws(
      () =>
        validateBundle([
          chunk(
            minimal.replace(
              'installReporter(window);',
              `function ${name}() {}\ninstallReporter(window);`,
            ),
          ),
        ]),
      /helper/,
    )
  for (const field of ['imports', 'dynamicImports', 'exports'])
    assert.throws(
      () => validateBundle([{ ...chunk(minimal), [field]: ['external'] }]),
      /forbidden/,
    )
  assert.throws(
    () => validateBundle([chunk(minimal), chunk(minimal)]),
    /exactly one/,
  )
  assert.throws(
    () => validateBundle([{ type: 'asset', source: '' }]),
    /exactly one/,
  )
  assert.throws(
    () => validateBundle([chunk('not valid javascript !')]),
    /invalid JavaScript/,
  )
  assert.throws(
    () =>
      validateBundle([
        chunk(
          minimal.replace(
            'installReporter(window);',
            `import('external'); installReporter(window);`,
          ),
        ),
      ]),
    /Unsafe reporter bundle/,
  )
})

// Exercise the bundled AST guard with each sensitive entry point, including
// anonymous callbacks where parent messages and CSP events are processed.
test('security paths reject iterable syntax and uncaptured Object/Array calls', () => {
  for (const name of [
    'createMessagePayload',
    'send',
    'ready',
    'onReadyCheck',
    'installMessageListener',
    'readEventValue',
    'trusted',
    'prepareLinkClick',
    'finishLinkClick',
    'sendSelection',
    'installCspViolations',
    'requestMermaidRendering',
  ]) {
    for (const operation of [
      'for (const key of keys) payload[key] = message[key];',
      'send(...keys);',
      'const copied = [...keys];',
      'const [key] = keys;',
      '[key] = keys;',
      'Object.keys(message);',
      'Object.entries(message);',
      'Array.from(keys);',
    ]) {
      const code = minimal.replace(
        'installReporter(window);',
        `function ${name}() { listen(() => { ${operation} }); } installReporter(window);`,
      )
      assert.throws(
        () =>
          validateBundle(
            [chunk(code)],
            new Set(['installReporter', 'capturePrimordials', name]),
          ),
        new RegExp(`${name}:.*(?:iterators|uncaptured)`),
      )
    }
  }
})

test('security paths reject destructured parameters too', () => {
  const code = minimal.replace(
    'installReporter(window);',
    `
    function createMessagePayload([message]) { return message; }
    installReporter(window);`,
  )
  assert.throws(
    () =>
      validateBundle(
        [chunk(code)],
        new Set([
          'installReporter',
          'capturePrimordials',
          'createMessagePayload',
        ]),
      ),
    /createMessagePayload: ArrayPattern/,
  )
})

test('security paths accept indexed copying through captured primordials', () => {
  const code = minimal.replace(
    'installReporter(window);',
    `
    function createMessagePayload(primitives, message) {
      const payload = primitives.objectCreate(null);
      const keys = primitives.objectKeys(message);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        payload[key] = message[key];
      }
      return payload;
    }
    installReporter(window);`,
  )
  assert.equal(
    validateBundle(
      [chunk(code)],
      new Set([
        'installReporter',
        'capturePrimordials',
        'createMessagePayload',
      ]),
    ),
    code,
  )
})

test('structural guard requires strict mode as the first IIFE statement', () => {
  for (const replacement of [
    '',
    '"use asm";',
    'const inert = 1; "use strict";',
  ]) {
    assert.throws(
      () =>
        validateBundle([chunk(minimal.replace('"use strict";', replacement))]),
      /IIFE must begin with a use strict directive/,
    )
  }
})

test('private values cannot reach replaceable globals, prototypes, coercion, or aliases', () => {
  for (const operation of [
    'JSON.stringify([ctx.documentToken, results]);',
    'JSON.stringify({ challenge: ctx.readyChallenge });',
    'String(ctx.documentToken);',
    'ctx.documentToken.slice(0);',
    "ctx['readyChallenge'].trim();",
    'const secret = ctx.documentToken;',
    'const wrapped = { token: ctx.documentToken };',
    'const signature = `${ctx.documentToken}`;',
    "String(ctx.documentToken || '');",
  ]) {
    const code = minimal.replace(
      'installReporter(window);',
      `function applyHighlights(ctx) { ${operation} } installReporter(window);`,
    )
    assert.throws(
      () =>
        validateBundle(
          [chunk(code)],
          new Set(['installReporter', 'capturePrimordials', 'applyHighlights']),
        ),
      /private token\/challenge/,
    )
  }
})

test('whole private messages can only use captured messaging primitives', () => {
  for (const name of ['send', 'createMessagePayload']) {
    for (const operation of [
      'JSON.stringify(message);',
      'String(message.token);',
      'message.token.slice(0);',
      'console.log(message);',
      'setTimeout(callback, 0, message);',
      'new String(message.token);',
      'new Proxy(message, handler);',
      'new ctx.win.Object(message);',
    ]) {
      const code = minimal.replace(
        'installReporter(window);',
        `function ${name}(ctx, message) { ${operation} } installReporter(window);`,
      )
      assert.throws(
        () =>
          validateBundle(
            [chunk(code)],
            new Set(['installReporter', 'capturePrimordials', name]),
          ),
        /uncaptured (?:constructor )?call with private message|replaceable array method slice|uncaptured Object\/Array\/Reflect\/Function/,
      )
    }
  }
})

test('anchor exclusion consumers share literal definitions and narrow selector helpers', async () => {
  const read = (name) =>
    readFile(join(dirname(entryPath), name + '.ts'), 'utf8')
  const engine = await read('anchor-engine')
  const mutations = await read('mutations')
  const annotate = await read('annotate')
  const { program, errors } = parseSync('anchor-engine.ts', engine)
  assert.deepEqual(errors, [])
  const constants = {}
  function value(node) {
    if (node.type === 'Literal') return node.value
    if (node.type === 'Identifier') return constants[node.name]
    assert.equal(node.type, 'BinaryExpression')
    assert.equal(node.operator, '+')
    return value(node.left) + value(node.right)
  }
  for (const node of program.body) {
    const declaration =
      node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (declaration?.type !== 'VariableDeclaration') continue
    assert.equal(declaration.kind, 'const')
    for (const decl of declaration.declarations)
      constants[decl.id.name] = value(decl.init)
  }
  const selector =
    'script,style,noscript,template,textarea,select,[data-anchor-ignore],[data-comment-ui],.ash-comment-highlight-badge,.mermaid-diagram'
  assert.deepEqual(constants, {
    TEXT_ANCHOR_EXCLUDED_SELECTOR: selector,
    ANCHOR_IGNORE_ATTRIBUTE: 'data-anchor-ignore',
    COMMENT_UI_ATTRIBUTE: 'data-comment-ui',
    EXCLUSION_CLASS_ATTRIBUTE: 'class',
    HIGHLIGHT_STYLE_ID: 'ash-comment-highlight-style',
    IGNORED_MUTATION_SELECTOR:
      '[data-anchor-ignore],#ash-comment-highlight-style',
    COMMENT_UI_SELECTOR: '[data-comment-ui]',
  })
  for (const attribute of [
    constants.ANCHOR_IGNORE_ATTRIBUTE,
    constants.COMMENT_UI_ATTRIBUTE,
  ]) {
    assert.ok(selector.includes('[' + attribute + ']'))
  }
  assert.match(engine, /closest\(TEXT_ANCHOR_EXCLUDED_SELECTOR\)/)
  assert.match(
    mutations,
    /primordials\.closest\(element, ignoredMutationSelector\(\)\)/,
  )
  assert.match(
    mutations,
    /primordials\.hasAttribute\(\s*node as Element,\s*anchorIgnoreAttribute\(\),?\s*\)/,
  )
  for (const name of [
    'anchorIgnoreAttribute()',
    'commentUiAttribute()',
    'EXCLUSION_CLASS_ATTRIBUTE',
  ]) {
    assert.ok(mutations.includes('record.attributeName === ' + name))
  }
  assert.match(
    annotate,
    /primordials\.closest\(target, commentUiSelector\(\)\)/,
  )
  assert.match(annotate, /setAttribute\(anchorIgnoreAttribute\(\), ''\)/)
  for (const source of [
    mutations,
    annotate,
    await read('toc'),
    await read('svg-overlay'),
    await read('highlights'),
  ]) {
    assert.doesNotMatch(
      source,
      /['"]data-(?:anchor-ignore|comment-ui)['"]|\[data-(?:anchor-ignore|comment-ui)\]/,
    )
  }
  for (const source of [mutations, await read('highlights')]) {
    assert.doesNotMatch(source, /['"]ash-comment-highlight-style['"]/)
    assert.match(source, /highlightStyleId\(\)/)
  }
  for (const name of ['ignoredMutationSelector', 'commentUiSelector']) {
    const fn = program.body.find(
      (node) => node.declaration?.id?.name === name,
    ).declaration
    assert.equal(fn.body.body.length, 1)
    assert.equal(fn.body.body[0].argument.type, 'Identifier')
  }
  assert.doesNotMatch(mutations, /\.(?:concat|map|join|includes)\(/)
  const { body } = await renderReporter()
  for (const literal of [
    'data-anchor-ignore',
    'data-comment-ui',
    'ash-comment-highlight-style',
  ])
    assert.equal(body.split(literal).length - 1, 1)
  // Execute the generated helpers without installing a reporter. renderReporter
  // above still runs the production structural/security guard unchanged.
  const helpers = body.replace(
    'installReporter(window);',
    'return [ignoredMutationSelector(), commentUiSelector()];',
  )
  assert.deepEqual(new Function('return ' + helpers)(), [
    '[data-anchor-ignore],#ash-comment-highlight-style',
    '[data-comment-ui]',
  ])
})

test('generated mutation exclusion survives replacement of concat, includes, map, join, some and filter', async () => {
  const { body } = await renderReporter()
  const exposeHandler = body.replace(
    'installReporter(window);',
    'rebuildAfterMutations = function(ctx) { ctx.rebuilds++; }; return handleMutations;',
  )
  const result = runInNewContext(`
    const handleMutations = ${exposeHandler};
    const root = { nodeType: 1, contains() { return true; }, closest() { throw new Error('replaceable closest called'); } };
    const ignored = { nodeType: 1, ignored: true, closest() { throw new Error('replaceable closest called'); }, hasAttribute() { throw new Error('replaceable hasAttribute called'); } };
    const ctx = {
      doc: { body: root, querySelector() { return root; } },
      observedAnchorRoot: root,
      primordials: {
        closest(element, selector) { return element.ignored ? element : null; },
        hasAttribute(element, name) { return element.ignored && name === 'data-anchor-ignore'; },
      },
      pendingHighlights: [{}], pendingAnchors: [],
      anchorSnapshotGeneration: 0, badgePositionFrame: 1, rebuilds: 0,
    };
    const original = {};
    const methods = ['concat', 'includes', 'map', 'join', 'some', 'filter'];
    for (let index = 0; index < methods.length; index++) {
      const name = methods[index];
      original[name] = Array.prototype[name];
      Array.prototype[name] = function () { throw new Error('replaceable ' + name + ' called'); };
    }
    try {
      // Both added and removed nodes must be examined without concat. Ignored
      // child lists must not rebuild the snapshot, but exclusion attributes do
      // invalidate its generation even in the same observer batch.
      const attributes = ['data-anchor-ignore', 'data-comment-ui', 'class'];
      for (let index = 0; index < attributes.length; index++) {
        handleMutations(ctx, [
          { type: 'childList', target: ignored, addedNodes: [{ nodeType: 3 }], removedNodes: [] },
          { type: 'childList', target: root, addedNodes: [ignored], removedNodes: [] },
          { type: 'childList', target: root, addedNodes: [], removedNodes: [ignored] },
          { type: 'attributes', target: root, attributeName: attributes[index] },
        ]);
      }
      handleMutations(ctx, [{ type: 'attributes', target: root, attributeName: 'style' }]);
      handleMutations(ctx, [{ type: 'childList', target: root, addedNodes: [{ nodeType: 3 }], removedNodes: [] }]);
      handleMutations(ctx, [{ type: 'childList', target: root, addedNodes: [], removedNodes: [{ nodeType: 3 }] }]);
      handleMutations(ctx, [{ type: 'characterData', target: { nodeType: 3, parentElement: root } }]);
      JSON.stringify([ctx.anchorSnapshotGeneration, ctx.rebuilds]);
    } finally {
      for (let index = 0; index < methods.length; index++) {
        const name = methods[index];
        Array.prototype[name] = original[name];
      }
    }
  `)
  assert.equal(result, '[3,3]')
})

test('generated annotation exclusion uses captured closest after page replacement', async () => {
  const { body } = await renderReporter()
  const annotateTargetFrom = new Function(
    'return ' +
      body.replace('installReporter(window);', 'return annotateTargetFrom;'),
  )()
  const commentUi = {
    nodeType: 1,
    closest() {
      throw new Error('page closest called')
    },
  }
  const content = {
    nodeType: 1,
    closest() {
      throw new Error('page closest called')
    },
  }
  const ctx = {
    doc: { body: {}, documentElement: {} },
    primordials: {
      closest(element, selector) {
        assert.equal(selector, '[data-comment-ui]')
        return element === commentUi ? commentUi : null
      },
    },
  }
  assert.equal(annotateTargetFrom(ctx, commentUi), null)
  assert.equal(annotateTargetFrom(ctx, content), content)
})

function withOperation(operation, name = 'inspect') {
  const code = minimal.replace(
    'installReporter(window);',
    `function helper(ctx) {} function ${name}(ctx) { ${operation} } installReporter(window);`,
  )
  return () =>
    validateBundle(
      [chunk(code)],
      new Set(['installReporter', 'capturePrimordials', 'helper', name]),
    )
}

test('secret flow confines ctx to members, matching bundle function parameters and the install return', () => {
  for (const operation of [
    'const { documentToken } = ctx;',
    'const [value] = ctx;',
    '({ documentToken } = ctx);',
    '([value] = ctx);',
    'const alias = ctx;',
    'alias = ctx;',
    "ctx['field'];",
    'ctx[key];',
    'const object = {...ctx};',
    'const array = [...ctx];',
    'helper(...ctx);',
    'return ctx;',
    'const object = {ctx};',
    'helper({ ctx });',
    '({ ctx } = value);',
    '({ ctx = other } = value);',
    'const { [ctx]: value } = other;',
    'const { value = ctx } = other;',
    'ctx && helper();',
    'new Helper(ctx);',
    'ctx = other;',
    'const text = `${ctx}`;',
    'const f = () => ctx;',
    'return ctx.documentToken;',
  ])
    assert.throws(
      withOperation(operation),
      /ctx value reference|private token\/challenge/,
      operation,
    )
  for (const operation of [
    'const value = ctx.field; helper(ctx);',
    'const ctx = {}; helper(ctx);',
    'const { state: ctx } = value; helper(ctx);',
    'const { ctx } = options; helper(ctx);',
    'const { ctx = fallback } = options; helper(ctx);',
    'const { nested: { ctx } } = options; helper(ctx);',
    'const f = function ({ ctx }) { helper(ctx); };',
    'const f = ({ ctx = fallback }) => helper(ctx);',
    'try {} catch ({ ctx }) { helper(ctx); }',
    'const [ctx] = values; helper(ctx);',
    'const value = {ctx: 1}; value.ctx;',
    'const value = { ctx() {} }; value.ctx();',
    'class Value { ctx() {} }',
    'class ctx {}',
    'ctx: while (true) { break ctx; }',
  ]) {
    // Local binding fixtures use a separate scope from the ctx parameter.
    assert.doesNotThrow(withOperation(`{ ${operation} }`))
  }
  const returning = minimal.replace(
    'const primordials = capturePrimordials(win);',
    'const primordials = capturePrimordials(win); const ctx = {}; return ctx;',
  )
  assert.doesNotThrow(() => validateBundle([chunk(returning)]))
  for (const returned of [
    'return (() => { return ctx; })();',
    'return (function installReporter() { return ctx; })();',
  ]) {
    assert.throws(
      () => validateBundle([chunk(returning.replace('return ctx;', returned))]),
      /ctx value reference/,
    )
  }
})

test('decision-path lint rejects realm built-ins and Array.prototype own names except constructor and length', () => {
  for (const operation of [
    'ctx.win.Object.keys(value);',
    '(ctx.win.Object).keys(value);',
    '(0, ctx.win.Object).keys(value);',
    '(Object).keys(value);',
    '(0, Object).keys(value);',
    '(0, win.Object.keys)(value);',
    "ctx.win['Object']['keys'](value);",
    'win.Array.from(value);',
    'globalThis.Object.entries(value);',
    "Object['keys'](value);",
    "Array['from'](value);",
    'ctx.win.Array.isArray(value);',
    'win[`Object`][`keys`](value);',
    'Object.keys.call(null, value);',
    'Object.keys.apply(null, value);',
    'Object.keys.bind(null)(value);',
    'const k = Object.keys; k(value);',
    'Reflect.ownKeys(value);',
    'const invoke = Function.prototype.call;',
    'const builtin = Array;',
    'const builtin = Reflect;',
    'Array.isArray.call(null, value);',
    'const check = Array.isArray;',
    'win.Reflect.ownKeys.call(null, value);',
    'win.Function.call(null, value);',
    'const builtin = {Object};',
  ])
    assert.throws(
      withOperation(operation, 'cssPath'),
      /uncaptured Object\/Array/,
      operation,
    )
})

test('decision-path denylist does not change with build runtime prototype additions', async () => {
  const name = 'syntheticFutureMethod'
  const original = Object.getOwnPropertyDescriptor(Array.prototype, name)
  try {
    Object.defineProperty(Array.prototype, name, {
      configurable: true,
      value() {},
    })
    const { validateBundle: validateFreshBundle } =
      await import('./build-reporter.mjs?synthetic-runtime-method')
    const code = minimal.replace(
      'installReporter(window);',
      `function cssPath(ctx) { value.${name}(); } installReporter(window);`,
    )
    assert.doesNotThrow(() =>
      validateFreshBundle(
        [chunk(code)],
        new Set(['installReporter', 'capturePrimordials', 'cssPath']),
      ),
    )
  } finally {
    if (original) Object.defineProperty(Array.prototype, name, original)
    else delete Array.prototype[name]
  }
})

test('fixed decision-path denylist covers every current Array.prototype method', () => {
  for (const method of Object.getOwnPropertyNames(Array.prototype).filter(
    (name) => name !== 'constructor' && name !== 'length',
  )) {
    for (const expression of [
      `items.${method}(callback)`,
      `(items.${method})(callback)`,
      `(0, items.${method})(callback)`,
      `(items.${method}).call(items, callback)`,
      `(0, items.${method}).call(items, callback)`,
      `items['${method}'](callback)`,
      'items[`' + method + '`](callback)',
      `items.${method}.call(items, callback)`,
      `items['${method}'].apply(items, args)`,
      `items.${method}.bind(items)(callback)`,
      `items.${method}.call.apply(null, args)`,
    ]) {
      assert.throws(
        withOperation(`helper(() => { ${expression}; });`, 'cssPath'),
        /replaceable array method/,
      )
    }
  }
  assert.doesNotThrow(
    withOperation(
      "Array['isArray'](value); (Array).isArray(value); (0, Array.isArray)(value); (primitives.objectKeys)(value); for (let i = 0; i < value.length; i++) copy[i] = value[i];",
      'cssPath',
    ),
  )
})

test('decision-path lint rejects realm built-in references, destructuring and constructors', () => {
  for (const builtin of ['Object', 'Array', 'Reflect', 'Function']) {
    for (const operation of [
      `win.${builtin}.prototype.hasOwnProperty.call(value, key);`,
      `const builtin = ctx.win.${builtin};`,
      `const { ${builtin}: builtin } = win;`,
      `({ ${builtin}: builtin } = win);`,
      `const { ['${builtin}']: builtin } = win;`,
      `new win.${builtin}(value);`,
      `new ctx.win.${builtin}(value);`,
      `new win['${builtin}'](value);`,
    ]) {
      assert.throws(
        withOperation(`helper(() => { ${operation} });`, 'cssPath'),
        /uncaptured Object\/Array\/Reflect\/Function/,
        operation,
      )
    }
  }
  assert.throws(
    withOperation('new Array.isArray(value);', 'cssPath'),
    /uncaptured Object\/Array/,
  )
  assert.doesNotThrow(
    withOperation(
      'new primitives.SavedArray(); Array.isArray(value);',
      'cssPath',
    ),
  )
})

test('decision-path lint resolves wrapped computed property names', () => {
  for (const key of ["('Object')", '(0, "Object")', '(`Object`)']) {
    assert.throws(
      withOperation(`win[${key}].create(value);`, 'cssPath'),
      /uncaptured Object\/Array/,
      key,
    )
  }
  for (const method of [
    'forEach',
    'some',
    'map',
    'filter',
    'every',
    'reduce',
    'find',
    'includes',
    'indexOf',
    'join',
    'concat',
  ]) {
    for (const key of [
      `('${method}')`,
      `(0, '${method}')`,
      '(`' + method + '`)',
    ]) {
      assert.throws(
        withOperation(`helper(() => items[${key}](callback));`, 'cssPath'),
        /replaceable array method/,
        key,
      )
    }
  }
  for (const key of [
    "('documentToken')",
    '(0, "readyChallenge")',
    '(`readyChallenge`)',
  ]) {
    assert.throws(
      withOperation(`state[${key}];`),
      /private token\/challenge member access requires ctx/,
      key,
    )
  }
  assert.doesNotThrow(withOperation("Array[('isArray')](value);", 'cssPath'))
})

test('decision-path lint resolves parenthesized optional callees and receivers', () => {
  for (const operation of [
    '(win?.Object.keys)(value);',
    '(win?.Object).keys(value);',
    '(0, win?.Object.keys)(value);',
    '(win?.Array).isArray(value);',
    '(win?.Array.from)?.(value);',
    '(win?.Object.keys).call(null, value);',
  ]) {
    assert.throws(
      withOperation(operation, 'cssPath'),
      /uncaptured Object\/Array/,
      operation,
    )
  }
  for (const operation of [
    '(items?.some)(callback);',
    '(0, items?.some)(callback);',
    '(items?.some)?.(callback);',
    '(items?.some).call(items, callback);',
    '(items?.some)[("apply")](items, args);',
    '(items?.[("some")])(callback);',
  ]) {
    assert.throws(
      withOperation(`helper(() => { ${operation} });`, 'cssPath'),
      /replaceable array method/,
      operation,
    )
  }
  assert.doesNotThrow(
    withOperation(
      '(Array?.isArray)(value); (primitives?.objectKeys)(value);',
      'cssPath',
    ),
  )
})

test('inert strings concatenate only previously declared owned constants', () => {
  for (const declarations of [
    "const attr = 'owned'; const selector = '[' + attr + ']';",
    "const attr = 'owned', selector = '[' + attr + ']';",
  ])
    assert.doesNotThrow(() =>
      validateBundle([
        chunk(
          minimal.replace(
            'function capturePrimordials',
            declarations + ' function capturePrimordials',
          ),
        ),
      ]),
    )
  for (const declarations of [
    "let attr = 'owned'; const selector = '[' + attr + ']';",
    "const selector = '[' + attr + ']'; const attr = 'owned';",
    "const selector = '[' + value.attr + ']';",
    "const selector = '[' + read() + ']';",
    "const count = 1; const selector = '[' + count + ']';",
    "const attr = 'owned'; let selector = '[' + attr + ']';",
  ])
    assert.throws(
      () =>
        validateBundle([
          chunk(
            minimal.replace(
              'function capturePrimordials',
              declarations + ' function capturePrimordials',
            ),
          ),
        ]),
      /only inert/,
    )
})

test('generated cssPath preserves invalid inputs, ancestor order and separators', async () => {
  const { body } = await renderReporter()
  const cssPath = new Function(
    'return ' + body.replace('installReporter(window);', 'return cssPath;'),
  )()
  const root = { nodeType: 1 }
  const ctx = { doc: { body: root } }
  assert.equal(cssPath(ctx, null), null)
  assert.equal(cssPath(ctx, { nodeType: 3 }), null)
  assert.equal(cssPath(ctx, root), 'body')
  const main = { nodeType: 1, nodeName: 'MAIN', parentElement: root }
  const previous = { nodeType: 1, nodeName: 'P' }
  const element = {
    nodeType: 1,
    nodeName: 'P',
    previousElementSibling: previous,
    parentElement: main,
  }
  assert.equal(
    cssPath(ctx, element),
    'body > main:nth-of-type(1) > p:nth-of-type(2)',
  )
})

test('generated SVG character mapping survives throwing page Array.some', async () => {
  const { body } = await renderReporter()
  const expose = body.replace(
    'installReporter(window);',
    'return svgTextRange;',
  )
  const result = runInNewContext(`
    const svgTextRange = ${expose};
    const text = {getNumberOfChars() {return 3;}};
    const node = {nodeValue: 'a   b', parentElement: {closest() {return text;}}};
    const ctx = {
      win: {NodeFilter: {SHOW_TEXT: 4}},
      doc: {createTreeWalker() {
        let visited = false;
        return {nextNode() {if (visited) return null; visited = true; return node;}};
      }},
    };
    const range = {startContainer: node, startOffset: 2, endOffset: 5};
    const initial = svgTextRange(ctx, [range]);
    Array.prototype.some = function() {throw new Error('page some called');};
    const collapsed = svgTextRange(ctx, [range]);
    text.getNumberOfChars = function() {return 5;};
    const raw = svgTextRange(ctx, [range]);
    range.startOffset = 5;
    const empty = svgTextRange(ctx, [range]);
    JSON.stringify([initial, collapsed, raw, empty].map(groups =>
      groups.map(group => ({start: group.start, end: group.end, sameText: group.text === text}))));
  `)
  assert.deepEqual(JSON.parse(result), [
    [{ start: 1, end: 3, sameText: true }],
    [{ start: 1, end: 3, sameText: true }],
    [{ start: 2, end: 5, sameText: true }],
    [],
  ])
})

test('generated verification scans text anchors without page Array.some', async () => {
  const { body } = await renderReporter()
  const expose = body.replace(
    'installReporter(window);',
    `
    createTextAnchorEngine = function(root) {
      return {text: root.text, resolve(anchor) { return anchor.quotedText === root.text ? {} : null; }};
    };
    send = function(ctx, message) { ctx.messages.push(message); };
    scheduleChecking = function() {};
    applyHighlights = function() {};
    invalidateChangedPaint = function() {};
    return [verifyAnchors, rebuildAfterMutations];
  `,
  )
  for (const replacement of [
    'return false;',
    "throw new Error('page some called');",
  ]) {
    const result = runInNewContext(`
      const [verify, rebuild] = ${expose};
      const root = {text: 'selected words'};
      const ctx = {
        doc: {body: root, querySelector() {return root;}},
        win: {clearTimeout() {}, setTimeout(callback) {callback();}},
        anchorSnapshotGeneration: 0, resolutionGeneration: 0,
        pendingHighlights: [], checkingDeadlines: {attached: 1, missing: 1}, messages: [],
      };
      const anchors = [
        {kind: 'text', thread: 'attached', quotedText: 'selected words'},
        {kind: 'text', thread: 'missing', quotedText: 'absent words'},
      ];
      Array.prototype.some = function() { ${replacement} };
      verify(ctx, anchors);
      root.text = 'absent words';
      rebuild(ctx);
      JSON.stringify(ctx.messages.map(message => message.verdicts.map(verdict => verdict.attached)));
    `)
    assert.equal(result, '[[true,false],[false,true]]')
  }
})

test('generated copy fallback and highlight styles retain their exclusion attributes', async () => {
  const { body } = await renderReporter()
  const [installCodeCopy, ensureCommentStyles] = new Function(
    'return ' +
      body.replace(
        'installReporter(window);',
        'return [installCodeCopy, ensureCommentStyles];',
      ),
  )()
  let click
  const created = []
  const doc = {
    addEventListener(kind, listener) {
      assert.equal(kind, 'click')
      click = listener
    },
    getElementById() {
      return null
    },
    createElement(tag) {
      const element = {
        tag,
        style: {},
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        select() {},
        remove() {},
      }
      created.push(element)
      return element
    },
    body: { appendChild() {} },
    head: { appendChild() {} },
    execCommand() {
      return false
    },
  }
  const ctx = { doc, win: { navigator: {} } }
  installCodeCopy(ctx)
  const code = { textContent: 'example' }
  const button = {
    closest() {
      return {
        querySelector() {
          return code
        },
      }
    },
  }
  click({
    target: {
      closest() {
        return button
      },
    },
    preventDefault() {},
    stopPropagation() {},
  })
  ensureCommentStyles(ctx)
  assert.deepEqual(
    created.map((element) => [element.tag, element.attributes]),
    [
      ['textarea', { 'data-anchor-ignore': '' }],
      ['style', { 'data-anchor-ignore': '' }],
    ],
  )
  assert.equal(created[0].value, 'example')
  assert.equal(created[1].id, 'ash-comment-highlight-style')
})

test('secret flow rejects ctx arguments to non-declarations and mismatched parameters', () => {
  for (const operation of [
    '[].push(ctx);',
    'Object.keys(ctx);',
    'foo(ctx);',
    '(foo)(ctx);',
    '(0, foo)(ctx);',
    '(holder.helper)(ctx);',
    '(0, holder.helper)(ctx);',
    'const foo = value => value; foo(ctx);',
    'const foo = function(ctx) {}; foo(ctx);',
    'helper.call(null, ctx);',
    'holder.helper(ctx);',
    'helper(1, ctx);',
  ])
    assert.throws(
      withOperation(operation),
      /ctx call argument requires/,
      operation,
    )
  for (const parameter of ['state', '...ctx', '{ctx}', 'ctx = fallback']) {
    const code = minimal.replace(
      'installReporter(window);',
      `function helper(${parameter}) {} function inspect(ctx) { helper(ctx); } installReporter(window);`,
    )
    assert.throws(
      () =>
        validateBundle(
          [chunk(code)],
          new Set([
            'capturePrimordials',
            'installReporter',
            'helper',
            'inspect',
          ]),
        ),
      /ctx call argument requires/,
      parameter,
    )
  }
  const code = minimal.replace(
    'installReporter(window);',
    'function helper(value, ctx) {} function inspect(ctx) { helper(1, ctx); } installReporter(window);',
  )
  assert.doesNotThrow(() =>
    validateBundle(
      [chunk(code)],
      new Set(['capturePrimordials', 'installReporter', 'helper', 'inspect']),
    ),
  )
})

test('secret flow rejects arguments identifiers and secret members on non-ctx objects', () => {
  for (const operation of [
    'arguments;',
    'arguments[0];',
    'arguments[0].documentToken;',
    'const value = {arguments: 1};',
    'value.arguments;',
  ])
    assert.throws(
      withOperation(operation),
      /arguments is forbidden|private token\/challenge member access requires ctx/,
      operation,
    )
  for (const operation of [
    'state.documentToken;',
    'state.readyChallenge;',
    "state['documentToken'];",
    'state[`readyChallenge`];',
    'state.documentToken = value;',
    'if (state.readyChallenge === value) return;',
  ])
    assert.throws(
      withOperation(operation),
      /private token\/challenge member access requires ctx/,
      operation,
    )
})

test('generated cssPath and Mermaid collection survive throwing unshift and push', async () => {
  const { body } = await renderReporter()
  const expose = body.replace(
    'installReporter(window);',
    'send = function(ctx, message) { ctx.message = message; }; return [cssPath, requestMermaidRendering];',
  )
  const result = runInNewContext(`
    const [cssPath, requestMermaidRendering] = ${expose};
    const root = {nodeType: 1, hasAttribute() {return true;}};
    const main = {nodeType: 1, nodeName: 'MAIN', parentElement: root};
    const element = {nodeType: 1, nodeName: 'P', parentElement: main};
    const blocks = [
      {textContent: '', closest() {return {};}},
      {textContent: 'graph TD; A-->B', closest() {return {};}},
      {textContent: 'graph TD; B-->C', closest() {return {};}},
    ];
    const ctx = {doc: {body: root, querySelectorAll() {return blocks;}}, mermaidBlocks: {}, readyChallenge: 'synthetic-v1'};
    Array.prototype.unshift = Array.prototype.push = function() {throw new Error('page array method called');};
    const path = cssPath(ctx, element);
    requestMermaidRendering(ctx);
    JSON.stringify({path, requested: ctx.mermaidRequested, message: ctx.message});
  `)
  assert.deepEqual(JSON.parse(result), {
    path: 'body > main:nth-of-type(1) > p:nth-of-type(1)',
    requested: true,
    message: {
      kind: 'mermaid-render-request',
      renderToken: 'synthetic-v1',
      diagrams: [
        { id: 'artifactshare-mermaid-1', source: 'graph TD; A-->B' },
        { id: 'artifactshare-mermaid-2', source: 'graph TD; B-->C' },
      ],
    },
  })
})

test('generated selection uses captured Range text and preserves whitespace rejection', async () => {
  const { body } = await renderReporter()
  const sendSelection = new Function(
    'return ' +
      body.replace(
        'installReporter(window);',
        `
      send = function(ctx, message) { ctx.message = message; };
      createTextAnchorEngine = function() {
        return {describe() {return {quotedText: 'selected words'};}};
      };
      return sendSelection;
    `,
      ),
  )()
  const root = { nodeType: 1 }
  const range = {
    commonAncestorContainer: root,
    toString() {
      throw new Error('page Range.toString called')
    },
    getBoundingClientRect() {
      return { top: 1, left: 2, width: 3, height: 4 }
    },
  }
  let text = 'selected words'
  let reads = 0
  const ctx = {
    textAnchorsEnabled: true,
    doc: {
      body: root,
      querySelector() {
        return root
      },
    },
    win: {
      getSelection() {
        return {
          rangeCount: 1,
          isCollapsed: false,
          getRangeAt() {
            return range
          },
        }
      },
    },
    primordials: {
      rangeToString(value) {
        assert.equal(value, range)
        reads++
        return text
      },
    },
  }
  sendSelection(ctx)
  assert.equal(ctx.message.kind, 'text-selection')
  assert.equal(ctx.message.quotedText, 'selected words')
  assert.equal(ctx.message.cssPath, 'body')
  assert.deepEqual(ctx.message.rect, { top: 1, left: 2, width: 3, height: 4 })
  text = ' \n\t'
  sendSelection(ctx)
  assert.deepEqual(ctx.message, { kind: 'text-selection-cleared' })
  assert.equal(reads, 2)
})

test('secret flow rejects shadowing of bundle function bindings', () => {
  for (const operation of [
    'const helper = ctx.win.leak; helper(ctx);',
    'const helper = ctx.win.leak; (helper)(ctx);',
    'const helper = ctx.win.leak; (0, helper)(ctx);',
    'var helper = ctx.win.leak; helper(ctx);',
    'helper(ctx); var helper = ctx.win.leak;',
    'const {leak: helper} = ctx.win; helper(ctx);',
    'const [helper] = callbacks; helper(ctx);',
    'const invoke = (helper) => helper(ctx);',
    'const invoke = ({helper}) => helper(ctx);',
    'try {} catch (helper) { helper(ctx); }',
    'try {} catch ({helper}) { helper(ctx); }',
    'function helper(state) { leak(state); } helper(ctx);',
    'const invoke = function helper(state) { helper(ctx); };',
    'class helper {} helper(ctx);',
    'const invoke = class helper { run() { helper(ctx); } };',
    'const {...helper} = callbacks; helper(ctx);',
    'for (let helper of callbacks) helper(ctx);',
    'switch (value) { case 1: let helper = leak; helper(ctx); }',
  ])
    assert.throws(
      withOperation(operation),
      /bundle function binding helper.*shadowed/,
      operation,
    )
})

test('secret flow rejects writes to bundle function bindings', () => {
  for (const operation of [
    'helper = ctx.win.leak; helper(ctx);',
    'helper(ctx); helper = ctx.win.leak;',
    'helper ||= ctx.win.leak; helper(ctx);',
    'helper++; helper(ctx);',
    '(helper) = ctx.win.leak; helper(ctx);',
    '(helper)++; helper(ctx);',
    '({leak: helper} = ctx.win); helper(ctx);',
    '({helper = leak} = value); helper(ctx);',
    '[helper] = callbacks; helper(ctx);',
    '[...helper] = callbacks; helper(ctx);',
    'for (helper of callbacks) helper(ctx);',
    'for (helper in callbacks) helper(ctx);',
    'const mutate = () => { helper = leak; }; helper(ctx);',
  ])
    assert.throws(
      withOperation(operation),
      /bundle function binding helper.*reassigned/,
      operation,
    )
})

test('secret flow rejects passing ctx as the implicit call or tag receiver', () => {
  for (const operation of [
    'ctx.leak();',
    'ctx.leak?.();',
    '(ctx.leak)();',
    'ctx?.leak();',
    'ctx.leak`value`;',
    '(ctx.leak)`value`;',
  ])
    assert.throws(
      withOperation(operation),
      /ctx must not be a call or tag receiver/,
      operation,
    )
})

test('secret flow rejects eval and Function identifiers outside the initial call.bind capture', () => {
  for (const operation of [
    `eval('leak(ctx)');`,
    `(eval)('leak(ctx)');`,
    `((eval))('helper = leak');`,
    `const invoke = () => eval('helper = leak');`,
    `(0, eval)('helper = leak');`,
    'const run = eval; run(source);',
    'window.eval(source);',
    'Function(source);',
    'new Function(source);',
    'const Constructor = Function;',
    'window.Function(source);',
    'const object = { eval: source };',
    'const object = { Function: source };',
  ])
    assert.throws(
      withOperation(operation),
      /dynamic code identifier (?:eval|Function) is forbidden/,
      operation,
    )
  for (const operation of [
    'win.Function(source);',
    'new win.Function(source);',
    'const Constructor = win.Function;',
    'const prototype = win.Function.prototype;',
    'const bind = win.Function.prototype.call.bind;',
    'const invoke = () => win.Function.prototype.call.bind(callback);',
    'eval(source);',
  ]) {
    const code = minimal.replace(
      'return { savedParent };',
      `${operation} return { savedParent };`,
    )
    assert.throws(
      () => validateBundle([chunk(code)]),
      /dynamic code identifier (?:eval|Function) is forbidden/,
      operation,
    )
  }
  assert.doesNotThrow(() =>
    validateBundle([
      chunk(
        minimal.replace(
          'return { savedParent };',
          'const post = win.Function.prototype.call.bind(savedParent.postMessage); return { savedParent };',
        ),
      ),
    ]),
  )
})

test('stable bundle function calls remain valid through callbacks and unrelated properties', () => {
  assert.doesNotThrow(
    withOperation(`
    const invoke = () => helper(ctx);
    const object = {helper: ctx.field};
    object.helper = other;
    const {helper: local} = object;
    for (object.helper of callbacks) helper(ctx);
    helper(ctx);
    (helper)(ctx);
    (0, helper)(ctx);
  `),
  )
})
