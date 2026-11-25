import type { Frame, Locator } from 'playwright'
import { t, type Locale, type TKey } from '../lib/i18n'

type Vars = Record<string, string | number>

// The element each role comes from in the viewers. Playwright computes roles
// itself; the readers that run inside the frame only have CSS, so they match
// the element the role comes from instead.
const ROLE_ELEMENT = {
  banner: 'header',
  button: 'button',
  combobox: 'select',
  dialog: '[role="dialog"]',
  link: 'a',
  main: 'main',
  menu: '[role="menu"]',
  menuitemradio: '[role="menuitemradio"]',
  navigation: 'nav',
  region: '[role="region"]',
  search: 'search',
  searchbox: 'input[type="search"]',
  slider: 'input[type="range"]',
  status: 'output',
  textbox: 'input',
} as const

type ViewerRole = keyof typeof ROLE_ELEMENT

/**
 * One part of a viewer, written the way a reader reaches it: a role, and the
 * catalogue keys behind the accessible name it carries. A control that
 * toggles carries one name per state, so `names` holds all of them.
 */
export type ViewerPart = {
  role?: ViewerRole
  names?: readonly TKey[]
  /** Variables its name takes, such as the page number. */
  vars?: Vars
  /** The part that contains this one. */
  within?: string
  /** The element, where the viewer names it by its text instead of a label. */
  css?: string
}

export type ViewerQueries<T> = {
  /** The name the catalogue gives it, in this viewer's language. */
  name: (part: keyof T, vars?: Vars) => string
  /** Finds it from the test process, by role and name. */
  find: (part: keyof T, vars?: Vars) => Locator
  /** CSS for the readers that run inside the frame. */
  selector: (part: keyof T, vars?: Vars) => string
  /** Every selector at once, for one reader that looks at several parts. */
  selectors: () => Record<keyof T & string, string>
}

export function viewerQueries<T extends Record<string, ViewerPart>>(
  parts: T,
  frame: Frame,
  locale: Locale,
): ViewerQueries<T> {
  const part = (key: keyof T): ViewerPart => parts[key]!
  const names = (key: keyof T, vars?: Vars) =>
    (part(key).names ?? []).map((name) =>
      t(locale, name, { ...part(key).vars, ...vars }),
    )
  const name = (key: keyof T, vars?: Vars) => {
    const [only] = names(key, vars)
    if (only === undefined)
      throw new Error(`Viewer part ${String(key)} has no name`)
    return only
  }
  const element = (key: keyof T) => {
    const { css, role } = part(key)
    if (css) return css
    if (role) return ROLE_ELEMENT[role]
    throw new Error(`Viewer part ${String(key)} has neither a role nor css`)
  }
  // One alternative per name the part can carry, each with its container.
  const selector = (key: keyof T, vars?: Vars): string => {
    const { within, css } = part(key)
    const prefix = within ? `${selector(within as keyof T)} ` : ''
    const labels = css
      ? []
      : names(key, vars).map(
          (label) => `[aria-label="${label.replaceAll('"', '\\"')}"]`,
        )
    return (labels.length === 0 ? [''] : labels)
      .map((label) => `${prefix}${element(key)}${label}`)
      .join(', ')
  }
  const find = (key: keyof T, vars?: Vars): Locator => {
    const { role, within } = part(key)
    const base: Frame | Locator = within ? find(within as keyof T) : frame
    const found = names(key, vars)
    if (!role || found.length === 0) return base.locator(element(key))
    const only = found[0]
    return base.getByRole(role, {
      name:
        found.length === 1 && only !== undefined
          ? only
          : new RegExp(`^(${found.map(escapeName).join('|')})$`),
      exact: true,
    })
  }
  return {
    name,
    find,
    selector,
    selectors: () =>
      Object.fromEntries(
        Object.keys(parts).map((key) => [key, selector(key)]),
      ) as Record<keyof T & string, string>,
  }
}

/**
 * Narrows a selector to a state the product sets, such as `[data-state=
 * "open"]`, keeping every name alternative the selector holds.
 */
export function inState(selector: string, state: string) {
  return selector
    .split(', ')
    .map((one) => `${one}${state}`)
    .join(', ')
}

function escapeName(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
