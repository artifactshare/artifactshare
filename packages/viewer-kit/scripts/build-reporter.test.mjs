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
  formatGenerated,
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

test('retired reporter measurement script is absent', async () => {
  await assert.rejects(
    stat(new URL('./measure-reporter.mjs', import.meta.url)),
    {
      code: 'ENOENT',
    },
  )
})

test('generation is deterministic, formatter-stable, and hashes the exact UTF-8 body', async () => {
  const first = await renderReporter()
  const second = await renderReporter()
  assert.deepEqual(second, first)
  assert.equal(
    first.hash,
    createHash('sha256').update(first.body, 'utf8').digest('base64'),
  )
  assert.equal(formatGenerated(first.source), first.source)
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
        /uncaptured (?:constructor )?call with private message/,
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
  const constants = Object.fromEntries(
    program.body.flatMap((node) => {
      const declaration =
        node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (declaration?.type !== 'VariableDeclaration') return []
      assert.equal(declaration.kind, 'const')
      return declaration.declarations.map((decl) => {
        assert.equal(decl.init.type, 'Literal')
        return [decl.id.name, decl.init.value]
      })
    }),
  )
  const selector =
    'script,style,noscript,template,textarea,select,[data-anchor-ignore],[data-comment-ui],.ash-comment-highlight-badge,.mermaid-diagram'
  assert.deepEqual(constants, {
    TEXT_ANCHOR_EXCLUDED_SELECTOR: selector,
    ANCHOR_IGNORE_ATTRIBUTE: 'data-anchor-ignore',
    COMMENT_UI_ATTRIBUTE: 'data-comment-ui',
    EXCLUSION_CLASS_ATTRIBUTE: 'class',
  })
  for (const attribute of [
    constants.ANCHOR_IGNORE_ATTRIBUTE,
    constants.COMMENT_UI_ATTRIBUTE,
  ]) {
    assert.ok(selector.includes('[' + attribute + ']'))
  }
  assert.match(engine, /closest\(TEXT_ANCHOR_EXCLUDED_SELECTOR\)/)
  assert.match(mutations, /closest\(ignoredMutationSelector\(\)\)/)
  assert.match(mutations, /hasAttribute\(ANCHOR_IGNORE_ATTRIBUTE\)/)
  for (const name of [
    'ANCHOR_IGNORE_ATTRIBUTE',
    'COMMENT_UI_ATTRIBUTE',
    'EXCLUSION_CLASS_ATTRIBUTE',
  ]) {
    assert.ok(mutations.includes('record.attributeName === ' + name))
  }
  assert.match(annotate, /closest\(commentUiSelector\(\)\)/)
  assert.match(annotate, /setAttribute\(ANCHOR_IGNORE_ATTRIBUTE, ''\)/)
  for (const source of [mutations, annotate]) {
    assert.doesNotMatch(
      source,
      /['"]data-(?:anchor-ignore|comment-ui)['"]|\[data-(?:anchor-ignore|comment-ui)\]/,
    )
  }
  assert.doesNotMatch(mutations, /\.(?:concat|map|join|includes)\(/)
  const { body } = await renderReporter()
  assert.equal(body.split(selector).length - 1, 1)
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

test('generated mutation exclusion does not call replaceable array methods', async () => {
  const { body } = await renderReporter()
  const exposeHandler = body.replace(
    'installReporter(window);',
    'return handleMutations;',
  )
  const result = runInNewContext(`
    const handleMutations = ${exposeHandler};
    const root = { nodeType: 1, contains() { return true; }, closest() { return null; } };
    const ignored = { nodeType: 1, hasAttribute(name) { return name === 'data-anchor-ignore'; } };
    const ctx = {
      doc: { body: root, querySelector() { return root; } },
      observedAnchorRoot: root,
      pendingHighlights: [{}], pendingAnchors: [],
      anchorSnapshotGeneration: 0, badgePositionFrame: 1,
    };
    const original = {};
    const methods = ['concat', 'includes', 'map', 'join'];
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
          { type: 'childList', target: root, addedNodes: [ignored], removedNodes: [] },
          { type: 'childList', target: root, addedNodes: [], removedNodes: [ignored] },
          { type: 'attributes', target: root, attributeName: attributes[index] },
        ]);
      }
      handleMutations(ctx, [{ type: 'attributes', target: root, attributeName: 'style' }]);
      ctx.anchorSnapshotGeneration;
    } finally {
      for (let index = 0; index < methods.length; index++) {
        const name = methods[index];
        Array.prototype[name] = original[name];
      }
    }
  `)
  assert.equal(result, 3)
})
