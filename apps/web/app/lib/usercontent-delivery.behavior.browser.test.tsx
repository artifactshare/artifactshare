import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('real cross-site Worker delivery preserves identity and uploads with third-party cookies blocked', async () => {
  const evidence = await server.commands.usercontentDelivery()
  console.info('usercontent browser measurement', evidence)
  expect(evidence.ordinaryThirdPartyCookie).toBe(
    evidence.engine === 'firefox' ? 'partitioned' : 'blocked',
  )
  expect(['present', 'blocked']).toContain(evidence.partitionedThirdPartyCookie)
  // These policies promise private static-site support; losing it must fail
  // instead of silently replacing their full delivery coverage with a message.
  if (evidence.engine === 'chromium' || evidence.engine === 'firefox') {
    expect(evidence.partitionedThirdPartyCookie).toBe('present')
  }
  expect(evidence.assetPreflights).toBe(6)
  expect(evidence.navigationEvidence.length).toBe(
    evidence.partitionedThirdPartyCookie === 'present' ? 13 : 11,
  )
  for (const navigation of evidence.navigationEvidence) {
    expect(navigation.sandboxStates).toEqual(['ready'])
    const prefix = navigation.stage.includes('link:') ? 'l' : 'a'
    const cookieMessage =
      evidence.partitionedThirdPartyCookie === 'blocked' &&
      navigation.stage.includes('authenticated:static_site first load')
    if (!cookieMessage) {
      expect(
        navigation.reports.some(
          ({ origin, state }) =>
            navigation.executionUrls.some(
              (url) => new URL(url).origin === origin,
            ) &&
            state.heading === 'Local delivery' &&
            state.nonce.length > 0,
        ),
      ).toBe(true)
    }
    expect(
      navigation.executionUrls.some((url) => {
        if (!URL.canParse(url)) return false
        const { protocol, hostname } = new URL(url)
        const [label, ...domain] = hostname.split('.')
        const [artifact, version, extra] = label.split('--v-')
        return (
          protocol === 'https:' &&
          domain.join('.') === 'usercontent.example' &&
          artifact.startsWith(`${prefix}-`) &&
          /^[a-z0-9]+$/.test(artifact.slice(2)) &&
          /^[a-f0-9]+$/.test(version ?? '') &&
          extra === undefined
        )
      }),
    ).toBe(true)
  }
  expect(evidence.results).toEqual([
    'authenticated:html',
    'authenticated:md',
    evidence.partitionedThirdPartyCookie === 'present'
      ? 'authenticated:static_site'
      : 'authenticated:static_site:cookie-setting-message',
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
    expect(restricted.partitionedThirdPartyCookie).toBe('blocked')
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
