import { anchorIgnoreAttribute } from './anchor-engine.js'
import type { ReporterState } from './state.js'

export function updateMarkdownToc(ctx: ReporterState) {
  let links = ctx.doc.querySelectorAll('.md-toc a[href^="#"]')
  if (!links.length) return
  let activeId = null
  for (let index = 0; index < links.length; index++) {
    let id = links[index].getAttribute('href')!.slice(1)
    let heading = ctx.doc.getElementById(id)
    if (heading && heading.getBoundingClientRect().top <= 96) activeId = id
  }
  if (!activeId) activeId = links[0].getAttribute('href')!.slice(1)
  for (let linkIndex = 0; linkIndex < links.length; linkIndex++) {
    if (links[linkIndex].getAttribute('href')!.slice(1) === activeId) {
      links[linkIndex].setAttribute('aria-current', 'location')
    } else {
      links[linkIndex].removeAttribute('aria-current')
    }
  }
}
export function installCodeCopy(ctx: ReporterState) {
  ctx.doc.addEventListener('click', function (event) {
    let target = event.target as Element | null
    let button = target && target.closest && target.closest('[data-code-copy]')
    if (!button) return
    let block = button.closest('.md-code-block')
    let code = block && block.querySelector('pre code')
    if (!code) return
    event.preventDefault()
    event.stopPropagation()

    let copied = function () {
      button.textContent = 'Copied'
      button.setAttribute('aria-label', 'Code copied')
      ctx.win.setTimeout(function () {
        button.textContent = 'Copy'
        button.setAttribute('aria-label', 'Copy code')
      }, 1500)
    }
    let fallback = function () {
      let textarea = ctx.doc.createElement('textarea')
      textarea.setAttribute(anchorIgnoreAttribute(), '')
      textarea.value = code.textContent || ''
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      ctx.doc.body.appendChild(textarea)
      textarea.select()
      try {
        if (ctx.doc.execCommand('copy')) copied()
      } catch (error) {}
      textarea.remove()
    }
    if (ctx.win.navigator.clipboard && ctx.win.navigator.clipboard.writeText) {
      ctx.win.navigator.clipboard
        .writeText(code.textContent || '')
        .then(copied, fallback)
    } else {
      fallback()
    }
  })
}
