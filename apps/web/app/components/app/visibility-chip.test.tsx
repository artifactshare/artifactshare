import { renderToStaticMarkup } from 'react-dom/server'
import type { SVGProps } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { Visibility } from '~/lib/shareable-types'
import { VisibilityChip } from './visibility-chip'

vi.mock('@tabler/icons-react', () => {
  const icon = (name: string) => (props: SVGProps<SVGSVGElement>) => (
    <svg {...props} data-icon={name} />
  )
  return {
    IconBuilding: icon('building'),
    IconLink: icon('link'),
    IconLock: icon('lock'),
    IconUsers: icon('users'),
  }
})

const CASES: Array<{
  visibility: Visibility
  label: string
  variant: string
  icon: string
}> = [
  {
    visibility: 'private',
    label: 'Private',
    variant: 'muted',
    icon: 'lock',
  },
  {
    visibility: 'workspace',
    label: 'Workspace',
    variant: 'info',
    icon: 'building',
  },
  {
    visibility: 'project',
    label: 'Project audience',
    variant: 'success',
    icon: 'users',
  },
  {
    visibility: 'link',
    label: 'Anyone with the link',
    variant: 'warning',
    icon: 'link',
  },
]

describe('VisibilityChip', () => {
  test.each(CASES)(
    'renders the $visibility chip as a non-interactive status',
    ({ visibility, label, variant, icon }) => {
      const html = renderToStaticMarkup(
        <VisibilityChip visibility={visibility} label={label} />,
      )
      expect(html).toMatch(/^<span\b/)
      expect(html).toContain(`data-variant="${variant}"`)
      expect(html).toContain(`title="${label}"`)
      expect(html).toContain(`data-icon="${icon}"`)
      expect(html).toContain(`<span>${label}</span>`)
      expect(html).toContain('aria-hidden="true"')
      expect(html).not.toContain('aria-label=')
      expect(html).not.toContain('role=')
    },
  )

  test('names a non-interactive chip on the group span without a tab stop', () => {
    const html = renderToStaticMarkup(
      <VisibilityChip
        visibility="link"
        label="Link sharing · Paused"
        aria-label="Link sharing · Paused"
      />,
    )
    const chip = html.match(/^<span\b[^>]*>/)?.[0]
    expect(chip).toContain('role="group"')
    expect(chip).toContain('aria-label="Link sharing · Paused"')
    expect(chip).toContain('title="Link sharing · Paused"')
    expect(chip).not.toContain('tabindex=')
    expect(chip).not.toContain('aria-live=')
    expect(html).not.toContain('<button')
  })

  test('does not render an unknown visibility', () => {
    const html = renderToStaticMarkup(
      <VisibilityChip visibility="unknown" label="Unknown" />,
    )
    expect(html).toBe('')
  })

  test('renders the interactive contract when onClick is provided', () => {
    const html = renderToStaticMarkup(
      <VisibilityChip
        visibility="workspace"
        label="Workspace"
        title="Change visibility"
        aria-label="Workspace · Change visibility"
        data-regression-responsive="mobile-only"
        onClick={() => {}}
      />,
    )
    expect(html).toMatch(/^<button\b/)
    const chip = html.match(/^<button\b[^>]*>/)?.[0]
    expect(chip).toContain('aria-label="Workspace · Change visibility"')
    expect(chip).not.toContain('role=')
    expect(html).toContain('type="button"')
    expect(html).toContain('title="Change visibility"')
    expect(html).toContain('aria-label="Workspace · Change visibility"')
    expect(html).toContain('data-regression-responsive="mobile-only"')
    expect(html).toContain('<span>Workspace</span>')
  })
})
