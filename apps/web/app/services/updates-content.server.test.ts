import { describe, expect, test } from 'vitest'

import {
  buildUpdateRecords,
  getAllUpdates,
  getUpdateBySlug,
  parseUpdateFile,
  parseUpdateFrontmatter,
  splitUpdateBody,
  validateUpdateFilename,
} from './updates-content.server'

const VALID_FRONTMATTER = `---
title: Sample update
date: 2026-07-01
products: [web]
kind: new
---
`

function entry(filename: string, body = 'Body text.'): string {
  return `${VALID_FRONTMATTER}${body}`
}

describe('committed updates entries', () => {
  test('all committed entries parse without error', () => {
    expect(() => getAllUpdates('en')).not.toThrow()
    expect(() => getAllUpdates('ja')).not.toThrow()
    expect(getAllUpdates('en').length).toBeGreaterThanOrEqual(4)
  })
})

describe('getAllUpdates', () => {
  test('sorts by date descending and slug descending on the same day', () => {
    const records = buildUpdateRecords([
      {
        filename: '2026-07-10-alpha.en.md',
        content: entry('2026-07-10-alpha.en.md'),
      },
      {
        filename: '2026-07-10-beta.en.md',
        content: entry('2026-07-10-beta.en.md'),
      },
      {
        filename: '2026-07-11-gamma.en.md',
        content: entry('2026-07-11-gamma.en.md'),
      },
    ])

    expect(records.map((record) => record.slug)).toEqual([
      '2026-07-11-gamma',
      '2026-07-10-beta',
      '2026-07-10-alpha',
    ])
  })

  test('filters by product when requested', () => {
    const cliOnly = getAllUpdates('en', 'cli')
    const webEntries = getAllUpdates('en', 'web')

    expect(cliOnly.map((item) => item.slug)).toContain(
      '2026-07-10-mermaid-static-site',
    )
    expect(cliOnly.every((item) => item.products.includes('cli'))).toBe(true)
    expect(webEntries.length).toBeGreaterThan(0)
    expect(webEntries.every((item) => item.products.includes('web'))).toBe(true)
  })

  test('falls back to English when Japanese entry is missing', () => {
    const record = buildUpdateRecords([
      {
        filename: 'english-only.en.md',
        content: `---
title: English title
date: 2026-07-01
products: [web]
kind: new
---
English body.`,
      },
    ])[0]!

    const jaEntry = {
      slug: record.slug,
      title: record.ja?.title ?? record.en.title,
      date: record.date,
      products: record.products,
      kind: record.kind,
      bodyHtml: record.ja?.bodyHtml ?? record.en.bodyHtml,
      summaryHtml: record.ja?.summaryHtml ?? record.en.summaryHtml,
      hasMore: record.ja?.hasMore ?? record.en.hasMore,
    }

    expect(jaEntry.title).toBe('English title')
    expect(jaEntry.bodyHtml).toContain('English body')
  })
})

describe('getUpdateBySlug', () => {
  test('returns undefined for unknown slug', () => {
    expect(getUpdateBySlug('does-not-exist', 'en')).toBeUndefined()
  })

  test('returns committed entry by slug', () => {
    const found = getUpdateBySlug('2026-07-10-mermaid-static-site', 'en')
    expect(found?.title).toContain('Mermaid')
    expect(found?.hasMore).toBe(true)
  })
})

describe('parseUpdateFrontmatter success cases', () => {
  test.each([
    ['omits notice when absent', '', undefined],
    ['parses true', 'notice: true\n', true],
  ])('%s', (_label, notice, expected) => {
    const parsed = parseUpdateFrontmatter(
      `---\ntitle: Sample\ndate: 2026-07-01\nproducts: [web]\nkind: new\n${notice}---\nBody`,
    )
    expect(parsed.frontmatter.notice).toBe(expected)
  })
  test('parses a public page details ID', () => {
    const parsed = parseUpdateFrontmatter(
      `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: guides-cli')}Body`,
    )
    expect(parsed.frontmatter.details).toBe('guides-cli')
  })
  test('allows colons in title values', () => {
    const parsed = parseUpdateFrontmatter(`---
title: Feature: better previews
date: 2026-07-01
products: [web]
kind: improve
---
Body`)
    expect(parsed.frontmatter.title).toBe('Feature: better previews')
  })

  test('trims whitespace inside products brackets', () => {
    const parsed = parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [ web , cli ]
kind: new
---
Body`)
    expect(parsed.frontmatter.products).toEqual(['web', 'cli'])
  })

  test('treats --- in body as content after frontmatter closes', () => {
    const parsed = parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
---
Before
---
After`)
    expect(parsed.body).toBe('\nBefore\n---\nAfter')
  })

  test('uses only the first frontmatter block boundary', () => {
    const parsed = parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
---
Body`)
    expect(parsed.frontmatter.title).toBe('Sample')
    expect(parsed.body).toBe('\nBody')
  })
})

describe('splitUpdateBody', () => {
  test('splits summary and full body around the more marker', () => {
    const split = splitUpdateBody('Intro\n<!-- more -->\nDetails')
    expect(split.hasMore).toBe(true)
    expect(split.summarySource).toBe('Intro\n')
    expect(split.bodySource).toBe('Intro\n\nDetails')
  })

  test('uses the full body when the more marker is absent', () => {
    const split = splitUpdateBody('Full body')
    expect(split).toEqual({
      bodySource: 'Full body',
      summarySource: 'Full body',
      hasMore: false,
    })
  })
})

describe('parseUpdateFrontmatter error cases', () => {
  test.each(['false', 'yes', '1', 'TRUE'])(
    'rejects invalid notice value %s',
    (notice) => {
      expect(() =>
        parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
notice: ${notice}
---
Body`),
      ).toThrow()
    },
  )
  test('rejects an unknown details ID', () => {
    expect(() =>
      parseUpdateFrontmatter(
        `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: missing')}Body`,
      ),
    ).toThrow('Unknown public page details ID')
  })
  test('throws when opening delimiter is missing', () => {
    expect(() =>
      parseUpdateFrontmatter(`title: Sample
date: 2026-07-01
products: [web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws when closing delimiter is missing', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
Body`),
    ).toThrow()
  })

  test('throws on unknown frontmatter keys', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
author: someone
---
Body`),
    ).toThrow()
  })

  test('throws on duplicate frontmatter keys', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
title: Duplicate
date: 2026-07-01
products: [web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on empty title', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title:
date: 2026-07-01
products: [web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on empty products', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: []
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on duplicate products', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web, web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws when products are not bracket formatted', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: web, cli
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on invalid kind', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: shipped
---
Body`),
    ).toThrow()
  })

  test('throws on invalid date format', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026/07/01
products: [web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on non-existent calendar dates', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-02-30
products: [web]
kind: new
---
Body`),
    ).toThrow()
  })

  test('throws on empty flag', () => {
    expect(() =>
      parseUpdateFrontmatter(`---
title: Sample
date: 2026-07-01
products: [web]
kind: new
flag:
---
Body`),
    ).toThrow()
  })
})

describe('Update entry body links', () => {
  test.each([
    ['English', 'guide.en.md', '[CLI reference](/guides/cli)'],
    ['Japanese', 'guide.ja.md', '[CLI リファレンス](/ja/guides/cli)'],
    [
      'query and fragment',
      'guide.en.md',
      '[CLI reference](/guides/cli?from=updates#commands)',
    ],
    ['nested Markdown', 'guide.en.md', '[**CLI reference**](/guides/cli)'],
    [
      'table cell Markdown',
      'guide.en.md',
      '| Link |\n| --- |\n| [CLI reference](/guides/cli) |',
    ],
  ])('%s links remain free-form Markdown', (_name, filename, body) => {
    expect(() => parseUpdateFile(filename, entry(filename, body))).not.toThrow()
  })

  test('does not inspect external, fragment, or image links', () => {
    const body = [
      '[external](https://example.com)',
      '[fragment](#section)',
      '![image](/images/example.png)',
    ].join('\n\n')

    expect(() =>
      parseUpdateFile('ignored.en.md', entry('ignored.en.md', body)),
    ).not.toThrow()
  })

  test('does not inspect raw HTML anchors', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'source.en.md',
          content: entry(
            'source.en.md',
            '<div><a href="/updates/target">Target</a> <a href=/guides/cli>CLI</a> <a href="https://example.com">External</a></div>',
          ),
        },
        {
          filename: 'target.en.md',
          content: entry('target.en.md'),
        },
      ]),
    ).not.toThrow()
  })

  test('accepts non-rendering raw HTML without link analysis', () => {
    expect(() =>
      parseUpdateFile(
        'guide.en.md',
        entry(
          'guide.en.md',
          '<!-- <a href="/updates/missing">Hidden</a> -->\n<script>const template = `<a href="/updates/missing">Hidden</a>`</script>',
        ),
      ),
    ).not.toThrow()
  })
})

describe('validateUpdateFilename', () => {
  test('accepts valid filenames', () => {
    expect(
      validateUpdateFilename('2026-07-10-mermaid-static-site.en.md'),
    ).toEqual({
      slug: '2026-07-10-mermaid-static-site',
      locale: 'en',
    })
  })

  test('throws on invalid filenames', () => {
    expect(() => validateUpdateFilename('Bad_Name.en.md')).toThrow()
    expect(() => validateUpdateFilename('missing-locale.md')).toThrow()
  })
})

describe('buildUpdateRecords', () => {
  test('throws when English entry is missing', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'ja-only.ja.md',
          content: entry('ja-only.ja.md'),
        },
      ]),
    ).toThrow()
  })

  test('throws when language pair metadata differs', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'mismatch.en.md',
          content: entry('mismatch.en.md'),
        },
        {
          filename: 'mismatch.ja.md',
          content: entry('mismatch.ja.md').replace(
            'date: 2026-07-01',
            'date: 2026-07-02',
          ),
        },
      ]),
    ).toThrow()
  })

  test('includes details only as a locale-resolved href', () => {
    const records = buildUpdateRecords([
      {
        filename: 'details.en.md',
        content: `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: guides-cli')}English body`,
      },
      {
        filename: 'details.ja.md',
        content: `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: guides-cli')}日本語本文`,
      },
    ])
    expect(records[0]).toHaveProperty('details', 'guides-cli')
    expect(
      getAllUpdates('en').find(
        (update) => update.slug === '2026-07-13-cli-reference',
      ),
    ).toMatchObject({
      detailsHref: '/guides/private-mobile-design-handoff',
    })
    expect(
      getAllUpdates('en').find(
        (update) => update.slug === '2026-07-13-cli-reference',
      ),
    ).not.toHaveProperty('details')
    expect(
      getAllUpdates('ja').find(
        (update) => update.slug === '2026-07-13-cli-reference',
      ),
    ).toMatchObject({
      detailsHref: '/ja/guides/private-mobile-design-handoff',
    })
  })

  test('rejects mismatched details IDs in a language pair', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'mismatch-details.en.md',
          content: `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: guides-cli')}Body`,
        },
        {
          filename: 'mismatch-details.ja.md',
          content: `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\ndetails: connect')}本文`,
        },
      ]),
    ).toThrow('Language pair metadata mismatch')
  })

  test('rejects mismatched notice settings in a language pair', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'mismatch-notice.en.md',
          content: `${VALID_FRONTMATTER.replace('kind: new', 'kind: new\nnotice: true')}Body`,
        },
        {
          filename: 'mismatch-notice.ja.md',
          content: `${VALID_FRONTMATTER}本文`,
        },
      ]),
    ).toThrow('Language pair metadata mismatch')
  })

  test('throws when flag differs between language pairs', () => {
    expect(() =>
      buildUpdateRecords([
        {
          filename: 'flagged.en.md',
          content: entry('flagged.en.md').replace(
            'kind: new',
            'kind: new\nflag: beta-feature',
          ),
        },
        {
          filename: 'flagged.ja.md',
          content: entry('flagged.ja.md'),
        },
      ]),
    ).toThrow()
  })
})

describe('parseUpdateFile', () => {
  test('parses a valid file end to end', () => {
    const parsed = parseUpdateFile(
      'sample.en.md',
      `---
title: Sample
date: 2026-07-01
products: [web]
kind: new
---
Body`,
    )

    expect(parsed).toEqual({
      slug: 'sample',
      locale: 'en',
      frontmatter: {
        title: 'Sample',
        date: '2026-07-01',
        products: ['web'],
        kind: 'new',
      },
      body: '\nBody',
    })
  })
})
