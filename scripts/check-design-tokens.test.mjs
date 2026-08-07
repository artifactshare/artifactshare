import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  APP_CSS,
  findBreakpointDocumentationViolations,
  findDesignSystemVersionViolations,
  findFontSourceViolations,
  collectDefinedVariables,
  collectLayoutPrimitiveImportNames,
  collectThemeBreakpointNames,
  findDuplicateSelectors,
  findColorBracketViolations,
  findForbiddenGlobalSelectors,
  findForbiddenLayoutPrimitiveClasses,
  findForbiddenRingTokenDefinitions,
  findLayoutPrimitiveClassNameViolations,
  findLiteralBracketViolations,
  findNumericBreakpointVariants,
  findRawWidthMediaQueries,
  findUndefinedThemeBreakpointReferences,
  findUnknownBreakpointVariants,
  findUndefinedVarReferences,
  findSettingsRouteSpacingViolationsFromReport,
  isColorBracketScanPath,
  reportClassNameEntries,
  stripTsxComments,
  findInteractiveSpacingAnnotationViolations,
  findInteractiveSpacingAnnotationViolationsInApp,
} from './check-design-tokens.mjs'

test('interactive spacing annotation is restricted to registered shared components', () => {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-tokens-'))
    try {
      const files = [
        'apps/web/app/components/ui/input-group.tsx',
        'apps/web/app/components/ui/segmented-control.tsx',
        'apps/web/app/routes/example.tsx',
        'apps/web/app/components/example.tsx',
        'apps/web/app/components/ui/other.tsx',
      ]
      await Promise.all(
        files.map(async (file) => {
          const path = join(root, file)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, 'data-gap-audit-composite')
        }),
      )
      const violations = findInteractiveSpacingAnnotationViolations(
        files.map((file) => join(root, file)),
        root,
      )
      assert.equal(violations.length, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })()
})

test('interactive annotation integration scans the shared UI directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-tokens-'))
  try {
    const files = [
      'apps/web/app/components/ui/unregistered.tsx',
      'apps/web/app/components/ui/unregistered.test.tsx',
      'apps/web/app/components/ui/unregistered.spec.ts',
    ]
    await Promise.all(
      files.map(async (file) => {
        const path = join(root, file)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, 'data-gap-audit-composite')
      }),
    )
    assert.deepEqual(
      findInteractiveSpacingAnnotationViolationsInApp(
        join(root, 'apps/web/app'),
        root,
      ).map((violation) => violation.file),
      [files[0]],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('spacing scanner resolves static const chains and cn/clsx arrays and ignores prose', () => {
  const source = `
import { Stack as Column } from '~/components/layout/stack'
const base = 'mt-2'
const classes = [base, 'gap-4']
const prose = 'mt-99'
export function Example() {
  return <Column className={clsx(classes, { 'mb-3': condition })} data-label={prose} />
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [
    'Column className: mt-2',
    'Column className: gap-4',
    'Column className: mb-3',
  ])
})

test('settings spacing deny uses pure route fixtures and explicit exclusions', () => {
  const entries = [
    ...['settings/billing.tsx', 'settings/nested/route.tsx'].map((file) => ({
      file: `apps/web/app/routes/_protected/${file}`,
      category: 'ownership-review',
      class: 'mt-4',
    })),
    ...[
      'settings/+components/fixture.tsx',
      'settings/route.test.tsx',
      'settings/route.spec.tsx',
      'settings/route.story.tsx',
    ].map((file) => ({
      file: `apps/web/app/routes/_protected/${file}`,
      category: 'ownership-review',
      class: 'mt-4',
    })),
    ...['settings/route.tsx'].flatMap((file) =>
      ['m-0', 'mt-auto', '-mt-2', 'mt-4'].map((className) => ({
        file: `apps/web/app/routes/_protected/${file}`,
        category: 'ownership-review',
        class: className,
      })),
    ),
    {
      file: 'apps/web/app/routes/_protected/settings/route.tsx',
      category: 'geometry',
      class: 'mt-4',
    },
    {
      file: 'apps/web/app/routes/_protected/settings/route.tsx',
      category: 'dynamic-review',
      class: '<dynamic>',
      potentialSpacing: true,
    },
    {
      file: 'apps/web/app/routes/_protected/settings/route.tsx',
      category: 'dynamic-review',
      class: '<dynamic>',
      potentialSpacing: false,
    },
  ]
  assert.deepEqual(
    findSettingsRouteSpacingViolationsFromReport(entries).map(
      (entry) => entry.class,
    ),
    ['mt-4', 'mt-4', 'mt-4', '<dynamic>'],
  )
})

test('spacing resolver covers literals, templates, arrays, object keys, and dynamic negatives', () => {
  const source = `
import { Stack } from '~/components/layout/stack'
const base = 'mt-2'
const classes = ['gap-4']
const template = \`mb-3\`
const dynamic = \`mt-\${size}\`
export function Example() { return <Stack className={cn(base, classes, template, { 'mb-3': true }, dynamic)} /> }
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [
    'Stack className: mt-2',
    'Stack className: gap-4',
    'Stack className: mb-3',
  ])
})

test('spacing report retains dynamic review when static and dynamic classes are mixed', () => {
  const source = `
import { Stack } from '~/components/layout/stack'
const base = 'mt-2'
export function Example({ dynamic }) {
  return <div className={cn(base, dynamic)} />
}
`
  const entries = reportClassNameEntries(
    new URL('../apps/web/app/components/fixture.tsx', import.meta.url).pathname,
    source,
  )
  assert.deepEqual(
    entries.map(({ class: className, category }) => ({ className, category })),
    [
      { className: 'mt-2', category: 'ownership-review' },
      { className: '<dynamic>', category: 'dynamic-review' },
    ],
  )
})

test('settings spacing deny resolves quoted arbitrary-value object keys', () => {
  const file = new URL(
    '../apps/web/app/routes/_protected/settings/fixture.tsx',
    import.meta.url,
  ).pathname
  const entries = reportClassNameEntries(
    file,
    `<div className={cn({ 'mt-[var(--spacing-4)]': condition })} />`,
  )
  assert.deepEqual(
    findSettingsRouteSpacingViolationsFromReport(entries).map(
      (entry) => entry.class,
    ),
    ['mt-[var(--spacing-4)]'],
  )
})

test('settings spacing deny does not let a sibling reset hide a positive margin', () => {
  const file = new URL(
    '../apps/web/app/routes/_protected/settings/fixture.tsx',
    import.meta.url,
  ).pathname
  const entries = reportClassNameEntries(
    file,
    `<div className="mt-4 [&_p]:m-0" />`,
  )
  assert.deepEqual(
    entries.map(({ class: className, category }) => ({ className, category })),
    [
      { className: 'mt-4', category: 'ownership-review' },
      { className: 'm-0', category: 'internal-reset' },
    ],
  )
  assert.deepEqual(
    findSettingsRouteSpacingViolationsFromReport(entries).map(
      (entry) => entry.class,
    ),
    ['mt-4'],
  )
})

test('design system sync checks reject stale font, version, and breakpoint sources', () => {
  assert.deepEqual(
    findFontSourceViolations(
      '--font-sans: Inter, sans-serif;\n--font-sans: Geist;',
      '<link href="https://fonts.googleapis.com">',
    ),
    [
      {
        file: APP_CSS,
        detail:
          "app.css must import @fontsource-variable/geist and define --font-sans once with 'Geist Variable' first",
      },
      {
        file: new URL('../apps/web/app/root.tsx', import.meta.url).pathname,
        detail: 'root.tsx must not load Google Fonts globally',
      },
    ],
  )
  assert.deepEqual(
    findDesignSystemVersionViolations(
      '現行仕様 v0.15\n| 2026 | v0.16 | change |',
    ),
    ['current version v0.15 does not match latest history v0.16'],
  )
  assert.deepEqual(findDesignSystemVersionViolations('変更履歴なし'), [
    'current version and latest history version must both be present',
  ])
  assert.deepEqual(
    findBreakpointDocumentationViolations(
      '## 10. Breakpoints\n- wide (1040px)',
    ),
    ['Breakpoints section must not duplicate px values'],
  )
  assert.deepEqual(findBreakpointDocumentationViolations('## 10. Responsive'), [
    'Breakpoints section must be present',
  ])
})

test('design system sync checks allow the current sources', () => {
  assert.deepEqual(
    findFontSourceViolations(
      "@import '@fontsource-variable/geist';\n--font-sans: 'Geist Variable', system-ui;",
      'export const links = () => []',
    ),
    [],
  )
  assert.deepEqual(
    findFontSourceViolations(
      "@import '@fontsource-variable/geist';\n--font-sans: 'Geist', system-ui;",
      'export const links = () => []',
    ),
    [
      {
        file: APP_CSS,
        detail:
          "app.css must import @fontsource-variable/geist and define --font-sans once with 'Geist Variable' first",
      },
    ],
  )
  assert.deepEqual(
    findFontSourceViolations(
      "/* @import '@fontsource-variable/geist'; */\n--font-sans: 'Geist Variable', system-ui;",
      'export const links = () => []',
    ),
    [
      {
        file: APP_CSS,
        detail:
          "app.css must import @fontsource-variable/geist and define --font-sans once with 'Geist Variable' first",
      },
    ],
  )
  assert.deepEqual(
    findFontSourceViolations(
      "@import '@fontsource-variable/geist';\n/* --font-sans: Inter; */\n--font-sans: 'Geist Variable', system-ui;",
      'export const links = () => []',
    ),
    [],
  )
  assert.deepEqual(
    findDesignSystemVersionViolations(
      '現行仕様 v0.17\n| 2026 | v0.17 | change |',
    ),
    [],
  )
  assert.deepEqual(
    findBreakpointDocumentationViolations(
      '## 10. Breakpoints\n- **wide**: 表形式',
    ),
    [],
  )
})

test('check 1: denies numeric literals in spacing/sizing bracket arbitrary values', () => {
  assert.deepEqual(findLiteralBracketViolations('className="p-[13px]"'), [
    'p-[13px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="size-[18px]"'), [
    'size-[18px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="rounded-[3px]"'), [
    'rounded-[3px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="z-[1]"'), ['z-[1]'])
  assert.deepEqual(
    findLiteralBracketViolations('className="duration-[160ms]"'),
    ['duration-[160ms]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="brightness-[0.88]"'),
    ['brightness-[0.88]'],
  )
  assert.deepEqual(findLiteralBracketViolations('className="stroke-[2.5]"'), [
    'stroke-[2.5]',
  ])
})

test('check 1: denies unlisted utilities, calc, var() mixes, and slash arbitrary values', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-[calc(0.02em)]"'),
    ['tracking-[calc(0.02em)]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="z-[calc(var(--z-topbar)+1)]"'),
    ['z-[calc(var(--z-topbar)+1)]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="p-[var(--spacing-2)_13px]"'),
    ['p-[var(--spacing-2)_13px]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="shadow-[0_0_0_2px_var(--blue)]"'),
    ['shadow-[0_0_0_2px_var(--blue)]'],
  )
  assert.deepEqual(findLiteralBracketViolations('className="text-sm/[1.65]"'), [
    'text-sm/[1.65]',
  ])
  assert.deepEqual(
    findLiteralBracketViolations('className="text-[length:12px]"'),
    ['text-[length:12px]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-[length:-0.01em]"'),
    ['tracking-[length:-0.01em]'],
  )
})

test('check 1: denies quote edge cases and invalid-length hex literals', () => {
  assert.deepEqual(findLiteralBracketViolations('className="p-[\'x\'_13px]"'), [
    "p-['x'_13px]",
  ])
  assert.deepEqual(findLiteralBracketViolations('className="p-[\'x]"'), [
    "p-['x]",
  ])
  assert.deepEqual(findLiteralBracketViolations('className="bg-[#12]"'), [
    'bg-[#12]',
  ])
})

test('check 1: allows token refs, scale utilities, and non-numeric variant brackets', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="p-[var(--spacing-2)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="top-[var(--as-popover-arrow-top,-7px)]"',
    ),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('className="p-2 gap-3.5"'), [])
  assert.deepEqual(
    findLiteralBracketViolations('className="data-[state=open]:opacity-100"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="supports-[backdrop-filter]:backdrop-blur"',
    ),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="[&_svg]:size-4"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="[&_h1]:text-3xl"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="max-520:[padding-inline:var(--spacing-2)]"',
    ),
    [],
  )
})

test('check 1: allows hex, color functions, quoted content, and non-numeric arbitrary values', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[var(--red)]"'),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('className="text-[#fff]"'), [])
  assert.deepEqual(findLiteralBracketViolations('className="bg-[#123456]"'), [])
  assert.deepEqual(findLiteralBracketViolations('className="bg-[#1234]"'), [])
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[#12345678]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="bg-[color-mix(in_srgb,var(--blue)_10%,var(--bg))]"',
    ),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[rgb(0_0_0)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[rgba(0,0,0,0.5)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[hsl(200_50%_50%)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[hsla(200,50%,50%,0.5)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[oklch(0.7_0.1_200)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[oklab(0.7_0.1_0.05)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[lab(50%_10_20)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[lch(50%_30_200)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="bg-[linear-gradient(to_right,var(--bg),var(--fg))]"',
    ),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="bg-[radial-gradient(circle,var(--bg),var(--fg))]"',
    ),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="bg-[conic-gradient(var(--bg),var(--fg))]"',
    ),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[color(display-p3_1_0_0)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[url(/image.png)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="bg-[url:image2.png]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="content-[\'v2\']"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations("className=\"content-['it\\'s']\""),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('className="ease-[ease]"'), [])
  assert.deepEqual(
    findLiteralBracketViolations('className="transition-[border-color]"'),
    [],
  )
})

test('check 1: denies text/leading/tracking/indent numeric literals', () => {
  assert.deepEqual(findLiteralBracketViolations('className="text-[11px]"'), [
    'text-[11px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="text-[0.8rem]"'), [
    'text-[0.8rem]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="leading-[18px]"'), [
    'leading-[18px]',
  ])
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-[0.4em]"'),
    ['tracking-[0.4em]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-[-0.01em]"'),
    ['tracking-[-0.01em]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="indent-[0.5rem]"'),
    ['indent-[0.5rem]'],
  )
})

test('check 1: allows type token refs and scale utilities', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="text-[var(--red)]"'),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('className="text-xs"'), [])
  assert.deepEqual(
    findLiteralBracketViolations('className="leading-tight"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-[var(--tracking-otp)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="indent-[var(--tracking-otp)]"'),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('className="tracking-otp"'), [])
  assert.deepEqual(
    findLiteralBracketViolations('className="tracking-tight"'),
    [],
  )
})

test('check 1: covers logical-property and axis-inset prefixes', () => {
  assert.deepEqual(findLiteralBracketViolations('className="inset-x-[10px]"'), [
    'inset-x-[10px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="ps-[10px]"'), [
    'ps-[10px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="me-[10px]"'), [
    'me-[10px]',
  ])
})

test('check 1: distinguishes variant position from value-position max-width', () => {
  assert.deepEqual(findLiteralBracketViolations('className="max-w-[95vw]"'), [
    'max-w-[95vw]',
  ])
})

test('check 1: allows grid-cols, grid-rows, auto-cols, and auto-rows structural track definitions', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="grid-cols-[26px_minmax(0,1fr)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="grid-rows-[48px_1fr]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="auto-cols-[minmax(0,1fr)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="auto-rows-[48px_1fr]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="-grid-cols-[26px_minmax(0,1fr)]"'),
    [],
  )
})

test('check 1: denies numeric literals in variant-position and arbitrary-property brackets', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="max-[520px]:flex"'),
    ['max-[520px]:'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="min-[1rem]:flex"'),
    ['min-[1rem]:'],
  )
  assert.deepEqual(findLiteralBracketViolations('className="[height:30px]"'), [
    '[height:30px]',
  ])
  assert.deepEqual(findLiteralBracketViolations('className="[--x:1px]"'), [
    '[--x:1px]',
  ])
  assert.deepEqual(
    findLiteralBracketViolations('className="[-webkit-line-clamp:2]"'),
    ['[-webkit-line-clamp:2]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="[padding-inline:14px]"'),
    ['[padding-inline:14px]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="[&_svg]:[height:17px]"'),
    ['[height:17px]'],
  )
})

test('check 1: allows arbitrary properties with token refs and color functions', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="[height:var(--x)]"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations(
      'className="[background:linear-gradient(to_right,var(--bg),var(--fg))]"',
    ),
    [],
  )
})

test('check 1: a URL on the same line does not hide a violation', () => {
  assert.deepEqual(
    findLiteralBracketViolations(
      '<a href="https://x.com" className="p-[13px]">',
    ),
    ['p-[13px]'],
  )
})

test('check 1: quote-aware bracket scanning in arbitrary values', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="content-[\'x]\']"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="content-[\'[13\']"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="content-[\'x]\'_13px]"'),
    ["content-['x]'_13px]"],
  )
})

test('check 1: scans only inside string literals', () => {
  assert.deepEqual(
    findLiteralBracketViolations('const RE = /^slug-[0-9]{4}$/'),
    [],
  )
  assert.deepEqual(findLiteralBracketViolations('const cls = `p-[13px]`'), [
    'p-[13px]',
  ])
  assert.deepEqual(
    findLiteralBracketViolations(
      'const cls = `p-[13px] ${x} gap-[var(--spacing-2)]`',
    ),
    ['p-[13px]'],
  )
})

test('check 1: scans nested string literals inside template interpolations', () => {
  assert.deepEqual(
    findLiteralBracketViolations("const c = `a ${cond ? 'p-[13px]' : ''} b`"),
    ['p-[13px]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations("const c = `a ${cond ? `p-[13px]` : ''} b`"),
    ['p-[13px]'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('const c = `w ${items[13]} x`'),
    [],
  )
})

test('check 1: denies bracket arbitrary values split across template interpolations', () => {
  assert.deepEqual(findLiteralBracketViolations('const c = `p-[${size}px]`'), [
    'p-[',
  ])
  assert.deepEqual(findLiteralBracketViolations('const c = `w-[13${x}]`'), [
    'w-[13',
  ])
  assert.deepEqual(
    findLiteralBracketViolations('const c = `[height:${size}px]`'),
    ['[height:'],
  )
  assert.deepEqual(
    findLiteralBracketViolations('const c = `[&_.item-${x}]:block`'),
    ['[&_.item-'],
  )
})

test('check 1: allows structural selector integers in bracket variants', () => {
  assert.deepEqual(
    findLiteralBracketViolations('className="[&:nth-child(3)]:mt-2"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="[&:nth-of-type(2n+1)]:bg-muted"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="aria-[level=2]:font-bold"'),
    [],
  )
  assert.deepEqual(
    findLiteralBracketViolations('className="data-[count=3]:flex"'),
    [],
  )
})

test('check 2: detects undefined CSS variable references', () => {
  const defined = collectDefinedVariables([':root { --spacing-6: 24px; }'])
  assert.deepEqual(findUndefinedVarReferences('color: var(--nope);', defined), [
    '--nope',
  ])
})

test('check 2: ignores fallback, defined vars, and template interpolation', () => {
  const defined = collectDefinedVariables([':root { --spacing-6: 24px; }'])
  assert.deepEqual(
    findUndefinedVarReferences('color: var(--nope, 0);', defined),
    [],
  )
  assert.deepEqual(
    findUndefinedVarReferences('padding: var(--spacing-6);', defined),
    [],
  )
  assert.deepEqual(
    findUndefinedVarReferences('color: var(--avatar-${i});', defined),
    [],
  )
})

test('check 2: an unrelated interpolation does not exempt a hard-coded var', () => {
  const defined = collectDefinedVariables([':root { --spacing-6: 24px; }'])
  assert.deepEqual(
    findUndefinedVarReferences('`id-${i}` and color: var(--nope);', defined),
    ['--nope'],
  )
})

test('check 2: vars defined in the same file are not reported as undefined', () => {
  const globalDefined = collectDefinedVariables([
    ':root { --spacing-6: 24px; }',
  ])
  const selfContained = `
    const css = \`
      :root { --md-body: 1rem; }
      .prose { font-size: var(--md-body); }
    \`
  `
  const fileDefined = collectDefinedVariables([selfContained])
  const effectiveDefined = new Set([...globalDefined, ...fileDefined])
  assert.deepEqual(
    findUndefinedVarReferences(selfContained, effectiveDefined, {
      stripComments: stripTsxComments,
    }),
    [],
  )
})

test('check 2: undefined vars are still reported when not defined in the file', () => {
  const globalDefined = collectDefinedVariables([
    ':root { --spacing-6: 24px; }',
  ])
  const source = `
    const css = \`
      :root { --md-body: 1rem; }
      .prose { color: var(--md-missing); }
    \`
  `
  const fileDefined = collectDefinedVariables([source])
  const effectiveDefined = new Set([...globalDefined, ...fileDefined])
  assert.deepEqual(
    findUndefinedVarReferences(source, effectiveDefined, {
      stripComments: stripTsxComments,
    }),
    ['--md-missing'],
  )
})

test('stripTsxComments keeps `//` inside string literals', () => {
  const stripped = stripTsxComments(
    'const u = "https://x.com" // trailing note',
  )
  assert.ok(stripped.includes('https://x.com'))
  assert.ok(!stripped.includes('trailing note'))
})

test('check 3: detects duplicate top-level selectors', () => {
  const css = `
.foo { color: red; }
@media (min-width: 768px) {
  .foo { color: blue; }
}
.foo { color: green; }
`
  assert.deepEqual(findDuplicateSelectors(css), ['.foo'])
})

test('check 3: passes with a single top-level selector', () => {
  const css = `
.foo { color: red; }
.bar { color: blue; }
`
  assert.deepEqual(findDuplicateSelectors(css), [])
})

test('check 3: a brace inside a string value does not desync detection', () => {
  const css = '.foo { content: "{"; color: red; }\n.foo { color: blue; }'
  assert.deepEqual(findDuplicateSelectors(css), ['.foo'])
})

test('check 4: flags class and id selectors in global CSS preludes', () => {
  assert.deepEqual(findForbiddenGlobalSelectors('.some-card { color: red }'), [
    '.some-card',
  ])
  assert.deepEqual(findForbiddenGlobalSelectors('#hero { color: red }'), [
    '#hero',
  ])
  // `as-*` is a class selector — the retired baseline is subsumed by this check.
  assert.deepEqual(findForbiddenGlobalSelectors('.as-foo { color: red }'), [
    '.as-foo',
  ])
  assert.deepEqual(findForbiddenGlobalSelectors('html .card { color: red }'), [
    'html .card',
  ])
  // Escaped and non-ASCII class/id selectors are valid CSS and must not bypass.
  assert.deepEqual(findForbiddenGlobalSelectors('.カード { color: red }'), [
    '.カード',
  ])
  assert.deepEqual(findForbiddenGlobalSelectors('.\\31 23 { color: red }'), [
    '.\\31 23',
  ])
  // CSS identifiers may begin with `--`; single-hyphen handling must not miss them.
  assert.deepEqual(findForbiddenGlobalSelectors('.--card { color: red }'), [
    '.--card',
  ])
  assert.deepEqual(findForbiddenGlobalSelectors('#--hero { color: red }'), [
    '#--hero',
  ])
  assert.deepEqual(findForbiddenGlobalSelectors('.-- { color: red }'), ['.--'])
})

test('check 4: does not flag fractional keyframe percentage selectors', () => {
  assert.deepEqual(
    findForbiddenGlobalSelectors(
      '@keyframes spin { 12.5% { opacity: 0.5 } .5% { opacity: 1 } }',
    ),
    [],
  )
})

test('check 4: allows token, base, and view-transition selectors', () => {
  const allowed = `
:root { --background: #ffffff; }
html, body { color: red }
* { box-sizing: border-box }
html[data-theme='dark'] { --background: #111315 }
html:has(main[data-guide]) { scroll-behavior: smooth }
html:has(main[data-smooth-scroll]) { scroll-behavior: smooth }
::view-transition-group(root) { animation-duration: 180ms }
html:active-view-transition-type(forward)::view-transition-old(root) {
  animation-name: as-slide-to-left;
}
`
  assert.deepEqual(findForbiddenGlobalSelectors(allowed), [])
})

test('check 4: ignores hex, keyframe names, declaration values, and attribute strings', () => {
  const css = `
/* .as-comment-only should be ignored */
:root { --card: #fff; content: ".as-decl-fake"; }
@keyframes as-slide-to-left { to { opacity: 0.92 } }
::view-transition-old(root) { animation-name: as-slide-to-left; }
[data-kind=".as-attr-fake"] { color: green }
`
  assert.deepEqual(findForbiddenGlobalSelectors(css), [])
})

test('check 4: flags nested class selectors inside @media and @layer', () => {
  assert.deepEqual(
    findForbiddenGlobalSelectors(
      '@media (min-width: 600px) { .card { color: red } }',
    ),
    ['.card'],
  )
  assert.deepEqual(
    findForbiddenGlobalSelectors('@layer base { .btn { color: red } }'),
    ['.btn'],
  )
})

test('check 4: reports one violation per prelude with the normalized prelude', () => {
  assert.deepEqual(findForbiddenGlobalSelectors('.a, .b { color: red }'), [
    '.a, .b',
  ])
  assert.deepEqual(
    findForbiddenGlobalSelectors('.card  >  .title { color: red }'),
    ['.card > .title'],
  )
})

test('check 4: denies @scope but not @supports feature-test selectors', () => {
  assert.deepEqual(
    findForbiddenGlobalSelectors('@scope (.foo) { img { color: red } }'),
    ['@scope (.foo)'],
  )
  // CSS at-keywords are case-insensitive; @SCOPE must not bypass the check.
  assert.deepEqual(
    findForbiddenGlobalSelectors('@SCOPE (.foo) { img { color: red } }'),
    ['@SCOPE (.foo)'],
  )
  assert.deepEqual(
    findForbiddenGlobalSelectors(
      '@supports selector(.foo) { html { color: red } }',
    ),
    [],
  )
})

test('check 4: `;` resets the prelude so a class after a top-level @import is flagged', () => {
  assert.deepEqual(
    findForbiddenGlobalSelectors('@import "x.css";\n.card { color: red }'),
    ['.card'],
  )
})

test('check 5: detects forbidden layout classes on canonical Stack imports', () => {
  const source = `
import { Stack } from '~/components/layout/stack'

export function Example() {
  return (
    <Stack
      gap="3"
      className="max-w-md p-4 mt-4"
    >
      <span>one</span>
    </Stack>
  )
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [
    'Stack className: mt-4',
  ])
})

test('check 5: detects responsive and cn() string literal violations', () => {
  const source = `
import { Inline } from '~/components/layout/inline'
import { cn } from '~/lib/utils'

export function Example() {
  return (
    <Inline gap="2" className={cn('sm:flex-wrap', 'w-full')} />
  )
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [
    'Inline className: sm:flex-wrap',
  ])
})

test('check 5: ignores unrelated Stack identifiers without canonical import', () => {
  const source = `
function Stack({ children }) {
  return <div className="flex flex-col gap-3">{children}</div>
}

export function Example() {
  return <Stack className="flex gap-4">x</Stack>
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [])
})

test('check 5: detects aliased canonical imports', () => {
  const source = `
import { Stack as Column } from '~/components/layout/stack'

export function Example() {
  return <Column gap="2" className="flex gap-4" />
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(source), [
    'Column className: flex',
    'Column className: gap-4',
  ])
})

test('check 5: classifies forbidden layout utility tokens', () => {
  assert.deepEqual(findForbiddenLayoutPrimitiveClasses('w-full p-4'), [])
  assert.deepEqual(
    findForbiddenLayoutPrimitiveClasses('flex gap-3 items-center'),
    ['flex', 'gap-3', 'items-center'],
  )
  assert.deepEqual(
    findForbiddenLayoutPrimitiveClasses(
      'hidden flex-wrap-reverse self-end content-center content-center-safe place-items-center place-content-between place-self-end md:table-cell list-item',
    ),
    [
      'hidden',
      'flex-wrap-reverse',
      'self-end',
      'content-center',
      'content-center-safe',
      'place-items-center',
      'place-content-between',
      'place-self-end',
      'md:table-cell',
      'list-item',
    ],
  )
  assert.deepEqual(
    findForbiddenLayoutPrimitiveClasses('table table-row table-caption'),
    ['table', 'table-row', 'table-caption'],
  )
  assert.deepEqual(
    findForbiddenLayoutPrimitiveClasses(
      'flex-1 flex-auto flex-none grow shrink grow-0 shrink-0',
    ),
    [],
  )
  assert.deepEqual(
    findForbiddenLayoutPrimitiveClasses(
      'content-none after:content-[""] space-x-4 -space-x-4 space-y-2 -space-y-2 mt-4 -mx-2',
    ),
    ['space-x-4', '-space-x-4', 'space-y-2', '-space-y-2', 'mt-4', '-mx-2'],
  )
  assert.deepEqual(
    [
      ...collectLayoutPrimitiveImportNames(`
import { Stack, type LayoutGap } from '~/components/layout/stack'
import { Inline } from '~/components/layout/inline'
`),
    ].sort(),
    ['Inline', 'Stack'],
  )
  assert.deepEqual(
    [
      ...collectLayoutPrimitiveImportNames(`
import { Stack } from './stack'
import { Inline } from './inline'
`),
    ].sort(),
    ['Inline', 'Stack'],
  )
})

test('check 5: does not flag dynamic className synthesis', () => {
  const dynamicVar = `
import { Stack } from '~/components/layout/stack'

export function Example({ layoutClass }: { layoutClass: string }) {
  return <Stack gap="2" className={layoutClass} />
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(dynamicVar), [])

  const templateInterpolation = `
import { Inline } from '~/components/layout/inline'

export function Example({ breakpoint }: { breakpoint: string }) {
  return <Inline gap="2" className={\`\${breakpoint}:flex gap-3\`} />
}
`
  assert.deepEqual(
    findLayoutPrimitiveClassNameViolations(templateInterpolation),
    [],
  )

  const functionReturn = `
import { Stack } from '~/components/layout/stack'

function stackSurfaceClass() {
  return 'flex flex-col gap-4'
}

export function Example() {
  return <Stack gap="2" className={stackSurfaceClass()} />
}
`
  assert.deepEqual(findLayoutPrimitiveClassNameViolations(functionReturn), [])
})

test('check 6: denies numeric breakpoint variants and allows semantic names', () => {
  assert.deepEqual(
    findNumericBreakpointVariants('className="max-520:flex gap-2"'),
    ['max-520:'],
  )
  assert.deepEqual(
    findNumericBreakpointVariants('className="min-600:grid max-1040:hidden"'),
    ['min-600:', 'max-1040:'],
  )
  assert.deepEqual(
    findNumericBreakpointVariants(
      'className="max-phone:flex max-stack:hidden"',
    ),
    [],
  )
  assert.deepEqual(
    findNumericBreakpointVariants('className="max-nav:p-4 max-wide:grid"'),
    [],
  )
})

test('check 6: does not flag non-Tailwind colon patterns', () => {
  assert.deepEqual(
    findNumericBreakpointVariants('const msg = "Error 404: Not Found"'),
    [],
  )
  assert.deepEqual(
    findNumericBreakpointVariants('const ratio = "1920:1080"'),
    [],
  )
  assert.deepEqual(
    findNumericBreakpointVariants('className="max-520:hidden"'),
    ['max-520:'],
  )
  assert.deepEqual(findNumericBreakpointVariants('className="dark:520:flex"'), [
    '520:',
  ])
})

test('check 6b: denies unknown breakpoint name variants', () => {
  const defined = new Set(['phone', 'stack', 'nav', 'wide'])
  assert.deepEqual(
    findUnknownBreakpointVariants('className="max-phon:hidden"', defined),
    ['max-phon:'],
  )
  assert.deepEqual(
    findUnknownBreakpointVariants('className="max-phone:hidden"', defined),
    [],
  )
  assert.deepEqual(
    findUnknownBreakpointVariants('className="max-lg:hidden"', defined),
    [],
  )
  assert.deepEqual(
    findUnknownBreakpointVariants('className="max-nv:hidden"', defined),
    ['max-nv:'],
  )
  assert.deepEqual(
    findUnknownBreakpointVariants('const css = "max-width: 860px;"', defined),
    [],
  )
  assert.deepEqual(
    findUnknownBreakpointVariants('className="hover:max-typo:hidden"', defined),
    ['max-typo:'],
  )
})

test('check 7: denies raw px width media queries and allows theme() breakpoints', () => {
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (max-width: 700px) { .x { color: red; } }',
    ),
    ['@media (max-width: 700px)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (min-width: 520px) { .x { color: red; } }',
    ),
    ['@media (min-width: 520px)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (width <= theme(--breakpoint-stack)) { .x { color: red; } }',
    ),
    [],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (width >= theme(--breakpoint-phone)) { .x { color: red; } }',
    ),
    [],
  )
  assert.deepEqual(findRawWidthMediaQueries('.foo { max-width: 700px; }'), [])
})

test('check 7: flags whitespace-less @media and non-theme width conditions', () => {
  assert.deepEqual(
    findRawWidthMediaQueries('@media(max-width:700px){ .x { color: red; } }'),
    ['@media (max-width:700px)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (max-width: 48rem) { .x { color: red; } }',
    ),
    ['@media (max-width: 48rem)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (width <= calc(theme(--breakpoint-stack) + 10px)) { .x { color: red; } }',
    ),
    ['@media (width <= calc(theme(--breakpoint-stack) + 10px))'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries('@media (width <= 520px) { .x { color: red; } }'),
    ['@media (width <= 520px)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries('@media (720px <= width) { .x { color: red; } }'),
    ['@media (720px <= width)'],
  )
  assert.deepEqual(
    findRawWidthMediaQueries(
      '@media (width <= theme(--breakpoint-stack)) { .x { color: red; } }',
    ),
    [],
  )
  assert.deepEqual(
    findRawWidthMediaQueries('@media (hover: hover) { .x { color: red; } }'),
    [],
  )
})

test('check 9: denies scalar color brackets across heads and modifiers', () => {
  const denied = [
    'bg-[var(--link)]',
    'text-[#37352f]',
    'border-[rgba(0,0,0,.1)]',
    'outline-[color:var(--link)]',
    'hover:bg-[var(--link)]',
    'bg-[var(--link)]!',
    'border-t-[var(--border)]',
    'divide-x-[var(--divider)]',
  ]
  for (const utility of denied) {
    assert.deepEqual(findColorBracketViolations(`className="${utility}"`), [
      utility,
    ])
  }
  assert.deepEqual(
    findColorBracketViolations('className={`outline-[color:var(--${token})]`}'),
    ['outline-[color:var(--'],
  )
})

test('check 9: allows composites, named colors, shadow, and non-color heads', () => {
  const allowed = [
    'bg-[color-mix(in_srgb,var(--link)_10%,var(--background))]',
    'bg-[linear-gradient(180deg,color-mix(in_srgb,var(--link)_10%,var(--background)),var(--background)_42%)]',
    '[background:var(--landing-shell-bg)]',
    'shadow-[var(--shadow-sm)]',
    'bg-primary',
    'bg-agent-soft',
    'p-[var(--spacing-2)]',
  ]
  for (const utility of allowed) {
    assert.deepEqual(findColorBracketViolations(`className="${utility}"`), [])
  }
})

test('check 9: scans ui files and honors only explicit path exceptions', () => {
  assert.equal(isColorBracketScanPath('/app/components/ui/badge.tsx'), true)
  assert.equal(isColorBracketScanPath('/app/lib/csp-reporter.ts'), false)
  assert.equal(isColorBracketScanPath('/app/emails/example.tsx'), false)
  assert.equal(isColorBracketScanPath('/app/routes/example.tsx'), true)
  const source = 'className="text-[#37352f]"'
  assert.deepEqual(findColorBracketViolations(source), ['text-[#37352f]'])
})

test('check 10: detects forbidden --ring-* token definitions in tokens.css', () => {
  const css = `
:root {
  --ring: var(--blue);
  --ring-hairline: 0 0 0 1px var(--border-strong);
  --ring-focus-x: 0 0 0 2px var(--blue);
}
`
  assert.deepEqual(findForbiddenRingTokenDefinitions(css), ['--ring-focus-x'])
})

test('check 10: allows --ring and --ring-hairline token definitions', () => {
  const css = `
:root {
  --ring: var(--blue);
  --ring-hairline: 0 0 0 1px var(--border-strong);
}
`
  assert.deepEqual(findForbiddenRingTokenDefinitions(css), [])
})

test('check 10: ignores --ring-* text inside quoted CSS string values', () => {
  const css = `
:root {
  --label: "--ring-focus: demo";
}
`
  assert.deepEqual(findForbiddenRingTokenDefinitions(css), [])
})

test('check 8: denies undefined theme() breakpoint refs; @theme is the only valid source', () => {
  const appCss = `
@theme {
  --breakpoint-phone: 520px;
  --breakpoint-stack: 780px;
}
`
  const localOnlyCss = `
:root { --breakpoint-foo: 500px; }
@media (width <= theme(--breakpoint-foo)) { .x { color: red; } }
`
  const validCss = `
@media (width <= theme(--breakpoint-stack)) { .x { color: red; } }
`
  const localCssPath = new URL(
    './fixtures/local-breakpoint.css',
    import.meta.url,
  ).pathname

  const undefinedRefs = findUndefinedThemeBreakpointReferences([
    { path: APP_CSS, content: appCss },
    { path: localCssPath, content: localOnlyCss },
  ])
  assert.equal(undefinedRefs.length, 1)
  assert.equal(undefinedRefs[0].detail, 'theme(--breakpoint-foo)')
  assert.ok(undefinedRefs[0].file.endsWith('fixtures/local-breakpoint.css'))

  assert.deepEqual(
    findUndefinedThemeBreakpointReferences([
      { path: APP_CSS, content: appCss },
      { path: localCssPath, content: validCss },
    ]),
    [],
  )
  assert.throws(
    () =>
      findUndefinedThemeBreakpointReferences([
        { path: localCssPath, content: localOnlyCss },
      ]),
    /app\.css not found in cssSources/,
  )
  assert.deepEqual(
    collectThemeBreakpointNames(appCss),
    new Set(['phone', 'stack']),
  )
})
