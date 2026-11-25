import { describe, expect, test } from 'vitest'
import en from '../i18n/en.json'
import ja from '../i18n/ja.json'
import {
  projectScopeLabelKey,
  shortVisibilityLabelKey,
} from './visibility-labels'

// The wording of each label, and that both locales carry it, is checked once
// in `app/i18n/catalog-parity.test.ts`. Here: which key each visibility
// resolves to, and that a reader can tell the choices apart.
const catalogs = [en, ja] as Record<string, string>[]
const VISIBILITIES = ['private', 'project', 'workspace', 'link'] as const

describe('short file visibility labels', () => {
  test.each([
    ['private', 'table.visibilityPrivate'],
    ['project', 'table.visibilityProject'],
    ['workspace', 'table.visibilityWorkspace'],
    ['link', 'card.visibility.link'],
  ] as const)('%s keeps its own label key', (visibility, key) => {
    expect(shortVisibilityLabelKey(visibility)).toBe(key)
  })

  test('only explicit zero-recipient evidence changes the private label', () => {
    expect(shortVisibilityLabelKey('private', false)).toBe(
      'table.visibilityOnlyMe',
    )
    for (const evidence of [true, undefined])
      expect(shortVisibilityLabelKey('private', evidence)).toBe(
        'table.visibilityPrivate',
      )
    for (const visibility of ['link', 'workspace', 'project'] as const)
      expect(shortVisibilityLabelKey(visibility, false)).toBe(
        shortVisibilityLabelKey(visibility),
      )
  })
})

test('project scope chips label the project itself, not a file', () => {
  expect(projectScopeLabelKey('private')).toBe('project.scopeChip.private')
  expect(projectScopeLabelKey('workspace')).toBe('project.scopeChip.workspace')
  expect(projectScopeLabelKey('private')).not.toBe(
    projectScopeLabelKey('workspace'),
  )
})

describe('every label a reader sees is translated and distinguishable', () => {
  const keyGroups = [
    VISIBILITIES.map((visibility) => shortVisibilityLabelKey(visibility)),
    [
      shortVisibilityLabelKey('private', false),
      shortVisibilityLabelKey('private'),
    ],
    VISIBILITIES.map((visibility) => `upload.visibility.${visibility}`),
    (['private', 'workspace'] as const).map(projectScopeLabelKey),
    ['card.visibility.link', 'vw.linkSharingPaused'],
  ]

  test.each(
    catalogs.map(
      (catalog, index) => [index === 0 ? 'en' : 'ja', catalog] as const,
    ),
  )(
    '%s translates every label and keeps each group distinct',
    (_locale, catalog) => {
      for (const group of keyGroups) {
        const labels = group.map((key) => catalog[key])
        for (const label of labels) expect(label?.trim()).toBeTruthy()
        expect(new Set(labels).size).toBe(labels.length)
      }
    },
  )
})
