import assert from 'node:assert/strict'
import test from 'node:test'
import { openPopup, requiredWait } from '../apps/web/app/test/browser-waits.ts'

function fixture() {
  let resolve,
    reject,
    released = false,
    signal
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return {
    context: {
      waitForEvent(event, options) {
        assert.equal(event, 'page')
        assert.equal(options.timeout, 30000)
        signal = options.signal
        signal.addEventListener(
          'abort',
          () => {
            released = true
            reject(new Error('aborted'))
          },
          { once: true },
        )
        return promise
      },
    },
    resolve,
    reject,
    released: () => released,
  }
}
test('required wait preserves a successful result and reports a rejected phase without leaking detail', async () => {
  assert.equal(await requiredWait('frame ready', Promise.resolve(true)), true)
  await assert.rejects(
    requiredWait('frame ready', Promise.reject(new Error('secret URL'))),
    {
      message: 'Browser wait failed: frame ready',
    },
  )
})
test('popup is observed before trigger and returned after trigger completion', async () => {
  const f = fixture(),
    popup = {}
  let finishTrigger,
    returned = false
  const result = openPopup(f.context, () => {
    f.resolve(popup)
    return new Promise((resolve) => {
      finishTrigger = resolve
    })
  }).then((value) => {
    returned = true
    return value
  })
  await new Promise(setImmediate)
  assert.equal(returned, false)
  finishTrigger()
  assert.equal(await result, popup)
  assert.equal(f.released(), true)
})
test('trigger failure aborts and drains the pending waiter', async () => {
  const f = fixture()
  await assert.rejects(
    openPopup(f.context, () => {
      throw new Error('trigger detail')
    }),
    /popup trigger/,
  )
  assert.equal(f.released(), true)
})
test('waiter failure owns the later trigger rejection', async () => {
  const f = fixture()
  let failTrigger
  const result = openPopup(
    f.context,
    () =>
      new Promise((_, reject) => {
        failTrigger = reject
      }),
  )
  await Promise.resolve()
  f.reject(new Error('waiter detail'))
  await assert.rejects(result, /popup event/)
  failTrigger(new Error('late trigger detail'))
  await new Promise(setImmediate)
  assert.equal(f.released(), true)
})
