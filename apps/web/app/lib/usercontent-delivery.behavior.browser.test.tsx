import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('real cross-site Worker delivery preserves identity and uploads with third-party cookies blocked', async () => {
  const evidence = await server.commands.usercontentDelivery()
  console.info('usercontent browser measurement', evidence)
  expect(evidence.ordinaryThirdPartyCookie).toBe(
    evidence.engine === 'firefox' ? 'partitioned' : 'blocked',
  )
  expect(evidence.assetPreflights).toBe(6)
  expect(evidence.results).toEqual([
    'authenticated:html',
    'authenticated:md',
    'authenticated:static_site',
    'link:html',
    'link:md',
    'link:static_site',
  ])
  expect(evidence.identity).toBe('victim')
  expect(evidence.uploadOwner).toBe('victim')
  if (evidence.engine === 'firefox') {
    const restricted = await server.commands.usercontentDelivery(true)
    console.info('usercontent block-all-cookies measurement', restricted)
    expect(restricted.ordinaryThirdPartyCookie).toBe('blocked')
    expect(restricted.results).toEqual([
      'authenticated:html',
      'authenticated:md',
      'authenticated:static_site:cookie-setting-message',
      'link:html',
      'link:md',
      'link:static_site',
    ])
    expect(restricted.identity).toBe('victim')
    expect(restricted.uploadOwner).toBe('victim')
  }
}, 480_000)
