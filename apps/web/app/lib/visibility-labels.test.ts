import { describe, expect, test } from 'vitest'
import en from '../i18n/en.json'
import ja from '../i18n/ja.json'
import {
  projectScopeLabelKey,
  shortVisibilityLabelKey,
} from './visibility-labels'

const FILE_LABEL_CASES = [
  {
    visibility: 'private',
    key: 'table.visibilityPrivate',
    en: 'Specific',
    ja: '個別共有',
  },
  {
    visibility: 'project',
    key: 'table.visibilityProject',
    en: 'Project',
    ja: 'プロジェクト',
  },
  {
    visibility: 'workspace',
    key: 'table.visibilityWorkspace',
    en: 'Company',
    ja: '社内全員',
  },
  {
    visibility: 'link',
    key: 'card.visibility.link',
    en: 'Link sharing',
    ja: 'リンク共有',
  },
] as const

describe('short file visibility label contract', () => {
  test.each(FILE_LABEL_CASES)(
    '$visibility maps to the short list label in both locales',
    ({ visibility, key, en: enLabel, ja: jaLabel }) => {
      expect(shortVisibilityLabelKey(visibility)).toBe(key)
      expect(en[key]).toBe(enLabel)
      expect(ja[key]).toBe(jaLabel)
    },
  )
})

describe('upload visibility copy contract', () => {
  test.each([
    ['private', 'Specific people', '個別共有'],
    ['project', 'Project members', 'プロジェクトの関係者'],
    ['workspace', 'Everyone in this workspace', '社内全員'],
    ['link', 'Anyone with the link', 'リンクを知っている全員'],
  ] as const)(
    '%s keeps its selection label',
    (visibility, enLabel, jaLabel) => {
      expect(en[`upload.visibility.${visibility}`]).toBe(enLabel)
      expect(ja[`upload.visibility.${visibility}`]).toBe(jaLabel)
    },
  )
})

describe('project scope chip label contract', () => {
  test.each([
    ['private', 'project.scopeChip.private', 'Project', 'プロジェクト'],
    ['workspace', 'project.scopeChip.workspace', 'Company', '社内全員'],
  ] as const)(
    '%s uses the project-only short label',
    (visibility, key, enLabel, jaLabel) => {
      expect(projectScopeLabelKey(visibility)).toBe(key)
      expect(en[key]).toBe(enLabel)
      expect(ja[key]).toBe(jaLabel)
    },
  )
})
