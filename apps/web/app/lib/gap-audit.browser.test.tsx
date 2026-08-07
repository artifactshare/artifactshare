import { afterEach, describe, expect, test } from 'vitest'
import { auditGaps, auditVerticalGaps } from './gap-audit'

afterEach(() => document.body.replaceChildren())

function fixture(html: string) {
  document.body.innerHTML = `<div id="fixture">${html}</div>`
  return auditVerticalGaps({ rootSelector: '#fixture' })
}

function interactiveFixture(html: string) {
  document.body.innerHTML = `<div id="fixture">${html}</div>`
  return auditGaps({ rootSelector: '#fixture' }).filter(
    (finding) => finding.audit === 'interactive',
  )
}

// Keep these fixtures in the scenario visual regression execution suite.
describe('scenario visual regression: gap audit fixtures', () => {
  test('audits every native and ARIA control kind', () => {
    const nativeControls = [
      '<a href="#">a</a>',
      '<button>b</button>',
      '<input>',
      '<select><option>x</option></select>',
      '<textarea></textarea>',
      '<details><summary>s</summary></details>',
    ]
    for (const control of nativeControls)
      expect(
        interactiveFixture(
          `<span style="display:inline-flex">${control}<button>x</button></span>`,
        ),
      ).toHaveLength(1)

    const roles = [
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'combobox',
      'textbox',
      'searchbox',
      'slider',
      'spinbutton',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
    ]
    for (const role of roles)
      expect(
        interactiveFixture(
          `<span style="display:inline-flex"><span role="${role}" style="width:20px;height:20px">${role}</span><button>x</button></span>`,
        ),
      ).toHaveLength(1)
  })
  test('uses 4px for horizontal and vertical interactive spacing', () => {
    expect(
      interactiveFixture(
        '<button style="display:block">a</button><button style="display:block;margin-top:3px">b</button>',
      ),
    ).toHaveLength(1)
    expect(
      interactiveFixture(
        '<button style="display:block">a</button><button style="display:block;margin-top:4px">b</button>',
      ),
    ).toEqual([])
    expect(
      interactiveFixture(
        '<span style="display:inline-flex"><button>a</button><button style="margin-left:3px">b</button></span>',
      ),
    ).toHaveLength(1)
    expect(
      interactiveFixture(
        '<span style="display:inline-flex"><button>a</button><button style="margin-left:4px">b</button></span>',
      ),
    ).toEqual([])
    document.body.innerHTML =
      '<div id="fixture" style="display:flex"><button>a</button><button>b</button></div>'
    expect(
      auditGaps({ rootSelector: '#fixture', minGap: 0 }).filter(
        (finding) => finding.audit === 'interactive',
      ),
    ).toHaveLength(1)
  })
  test('ignores hidden, zero-size, and overlapping controls', () => {
    for (const fixtureHtml of [
      '<div style="display:none"><button>a</button><button>b</button></div>',
      '<div style="visibility:hidden"><button>a</button><button>b</button></div>',
      '<div style="opacity:0"><button>a</button><button>b</button></div>',
      '<div aria-hidden="true"><button>a</button><button>b</button></div>',
      '<button style="display:block;width:0;height:0;padding:0;border:0">a</button>',
      '<button style="position:absolute;left:0;top:0">a</button><button style="position:absolute;left:0;top:0">b</button>',
    ])
      expect(interactiveFixture(fixtureHtml)).toEqual([])
  })
  test('audits controls that override an ancestor visibility', () => {
    expect(
      interactiveFixture(
        '<div style="visibility:hidden"><span style="display:inline-flex;visibility:visible"><button>a</button><button>b</button></span></div>',
      ),
    ).toHaveLength(1)
  })
  test('deduplicates nested interactive selectors', () => {
    expect(
      interactiveFixture(
        '<span style="display:inline-flex"><button><span role="button">nested</span></button><button>next</button></span>',
      ),
    ).toHaveLength(1)
  })
  test('allows only boundaries inside the same composite root', () => {
    expect(
      interactiveFixture(
        '<div data-gap-audit-composite style="display:flex"><button>a</button><button>b</button></div>',
      ),
    ).toEqual([])
    expect(
      interactiveFixture(
        '<div data-gap-audit-composite style="display:flex"><button>a</button><button>b</button></div><button style="display:block">outside</button>',
      ),
    ).toEqual([
      expect.objectContaining({ audit: 'interactive' }),
      expect.objectContaining({ audit: 'interactive' }),
    ])
  })
  test('does not reuse vertical annotations for interactive controls', () => {
    expect(
      interactiveFixture(
        '<span style="display:inline-flex"><button data-gap-audit-allow-touch>a</button><button>b</button></span>',
      ),
    ).toHaveLength(1)
    expect(
      interactiveFixture(
        '<span style="display:inline-flex"><button data-gap-audit-exempt>a</button><button>b</button></span>',
      ),
    ).toHaveLength(1)
  })
  test('keeps ordinary checkbox and radio groups with token spacing', () => {
    expect(
      interactiveFixture(
        '<span style="display:inline-flex;gap:4px"><input type="checkbox"><input type="checkbox"><input type="radio"><input type="radio"></span>',
      ),
    ).toEqual([])
  })
  test('remains self-contained when Playwright serializes the common entry', () => {
    const serializedAudit = (0, eval)(`(${auditGaps.toString()})`)
    document.body.innerHTML =
      '<div id="fixture" style="display:flex"><button>a</button><button>b</button></div>'
    expect(
      serializedAudit({ rootSelector: '#fixture' }).filter(
        (finding: { audit: string }) => finding.audit === 'interactive',
      ),
    ).toHaveLength(1)
  })
  test('detects blocks that touch', () => {
    expect(
      fixture(
        '<div style="height:20px;background:red">A</div><div style="height:20px;background:red">B</div>',
      ),
    ).toHaveLength(1)
  })
  test('ignores padding boxes when their ink has space', () => {
    expect(
      fixture(
        '<div style="height:20px;padding:10px">A</div><div style="height:20px;padding:10px">B</div>',
      ),
    ).toEqual([])
  })
  test('ignores border-top-only adjacent sections with padded content', () => {
    // real sections keep their text away from the divider via padding
    expect(
      fixture(
        '<div style="height:40px;border-top:1px solid;padding-top:12px;line-height:20px;margin:0">A</div><div style="height:40px;border-top:1px solid;padding-top:12px;line-height:20px;margin:0">B</div>',
      ),
    ).toEqual([])
  })
  test('ignores interactive contents', () => {
    expect(
      fixture(
        '<button style="display:block;height:20px">Label <span>→</span></button>',
      ),
    ).toEqual([])
  })
  test('ignores horizontal siblings', () => {
    expect(
      fixture(
        '<div style="display:inline-block;width:20px;height:20px;background:red">A</div><div style="display:inline-block;width:20px;height:20px;background:red">B</div>',
      ),
    ).toEqual([])
  })
  test('ignores flex siblings that actually wrap onto rows', () => {
    // the container is narrower than two items, forcing a real second row
    expect(
      fixture(
        '<div style="display:flex;flex-wrap:wrap;width:30px"><div style="height:20px;width:20px;background:red">A</div><div style="height:20px;width:20px;background:red">B</div></div>',
      ),
    ).toEqual([])
  })
  test('ignores invisible siblings', () => {
    expect(
      fixture(
        '<div style="height:20px;background:red;visibility:hidden">A</div><div style="height:20px;background:red">B</div>',
      ),
    ).toEqual([])
    // opacity hides the whole subtree, including descendants with opacity: 1
    expect(
      fixture(
        '<div style="opacity:0"><div style="height:20px;background:red">A</div><div style="height:20px;background:red">B</div></div>',
      ),
    ).toEqual([])
    // a visible descendant overriding visibility:hidden still forms a boundary
    expect(
      fixture(
        '<div style="visibility:hidden"><div style="height:20px;background:red;visibility:visible">A</div></div><div style="height:20px;background:red">B</div>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'surface' })])
  })
  test('ignores vertically overlapping positioned siblings', () => {
    expect(
      fixture(
        '<div style="height:20px;background:red">A</div><div style="height:20px;background:red;margin-top:-10px">B</div>',
      ),
    ).toEqual([])
  })
  test('audits inside display:contents wrappers', () => {
    expect(
      fixture(
        '<div style="display:contents"><div style="height:20px;background:red">A</div><div style="height:20px;background:red">B</div></div>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'surface' })])
  })
  test('measures gradient backgrounds as ink', () => {
    expect(
      fixture(
        '<div style="height:20px;background:linear-gradient(red,blue)">A</div><div style="height:20px;background:linear-gradient(red,blue)">B</div>',
      ),
    ).toHaveLength(1)
  })
  test('ignores a child background matching its ancestor', () => {
    expect(
      fixture(
        '<div style="background:rgb(255, 255, 255)"><div style="height:20px;background:rgb(255, 255, 255)">A</div><div style="height:20px;margin-top:10px;background:rgb(255, 255, 255)">B</div></div>',
      ),
    ).toEqual([])
  })
  test('uses the stricter threshold for text-only gaps', () => {
    // auto-height blocks make the box edge track the text ink exactly, so the
    // margin value is the gap regardless of the environment font metrics
    expect(
      fixture(
        '<div style="margin:0">A</div><div style="margin:3px 0 0 0">B</div>',
      ),
    ).toEqual([])
    expect(
      fixture(
        '<div style="margin:0">A</div><div style="margin:-1px 0 0 0">B</div>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'text-text' })])
  })
  test('honors explicit exemptions', () => {
    expect(
      fixture(
        '<div data-gap-audit-exempt style="height:20px;background:red">A</div><div style="height:20px;background:red">B</div>',
      ),
    ).toEqual([])
  })
  test('honors allow-touch only for the declared upper boundary', () => {
    expect(
      fixture(
        '<div style="height:20px;background:red">A</div><div data-gap-audit-allow-touch style="height:20px;background:red">B</div>',
      ),
    ).toEqual([])
    // the declared element still audits its boundary with the next sibling
    expect(
      fixture(
        '<div style="height:20px;background:red">A</div><div data-gap-audit-allow-touch style="height:20px;background:red">B</div><div style="height:20px;background:red">C</div>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'surface' })])
  })
  test('detects the email-first control and card note regressions', () => {
    // bordered control followed by an unspaced hint
    expect(
      fixture(
        '<input style="display:block;height:20px;margin:0;border:1px solid"><p style="margin:0">Hint</p>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'surface' })])
    // two text units flush against each other
    expect(
      fixture(
        '<p style="margin:-1px 0 0 0">Term</p><p style="margin:0">Note</p>',
      ),
    ).toEqual([expect.objectContaining({ kind: 'text-text' })])
  })
})
