import { describe, expect, test } from 'vitest'
import {
  canSubmitLinkReport,
  reportDialogStateOnReopen,
} from './link-report-dialog'

describe('reportDialogStateOnReopen', () => {
  test.each(['sent', 'error'] as const)(
    'clears the previous %s state',
    (state) => {
      expect(reportDialogStateOnReopen(state)).toBe('editing')
    },
  )

  test('does not interrupt an active submission', () => {
    expect(reportDialogStateOnReopen('submitting')).toBe('submitting')
  })
})

describe('canSubmitLinkReport', () => {
  test('requires a selected reason and an idle form', () => {
    expect(canSubmitLinkReport('', 'editing')).toBe(false)
    expect(canSubmitLinkReport('phishing', 'editing')).toBe(true)
    expect(canSubmitLinkReport('phishing', 'submitting')).toBe(false)
  })
})
