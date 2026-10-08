import { describe, expect, test } from 'vitest'
import {
  EXTERNAL_SCRIPT_CSP_SOURCES,
  SOCIAL_EMBED_SCRIPT_CSP_SOURCES,
} from '@artifactshare/viewer-kit/script-policy-sources'
import { classifyCspViolation } from './csp-violation-classification'
const origin = 'https://site123abc-v1.sandbox.artifactshare.com'
describe('CSP source attribution', () => {
  test.each(['html', 'md', 'static_site', null, 'unknown'])(
    'recognizes the document for %s',
    (type) => {
      for (const source of [
        origin,
        `${origin}/index.html?q=1`,
        `${origin}:443/app.js`,
      ])
        expect(classifyCspViolation(source, origin, type)).toBe('artifact')
    },
  )
  test.each(
    `${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_SCRIPT_CSP_SOURCES}`.split(
      ' ',
    ),
  )(
    'uses the shared script policy for %s regardless of the blocked resource or directive',
    (source) => {
      for (const type of ['html', 'static_site'])
        expect(classifyCspViolation(`${source}/app.js`, origin, type)).toBe(
          'artifact',
        )
      for (const type of ['md', null, 'unknown'])
        expect(classifyCspViolation(source, origin, type)).toBe('environment')
    },
  )
  test.each([
    null,
    '',
    'garbage',
    '/app.js',
    '//cdn.jsdelivr.net/app.js',
    'chrome-extension://abc/app.js',
    'moz-extension://abc/app.js',
    'safari-web-extension://abc/app.js',
    'data:text/javascript,alert(1)',
    `blob:${origin}/abc`,
    'file:///app.js',
    'https://example.com/app.js',
    'https://artifactshare.com/app.js',
    'https://site123abc-v2.sandbox.artifactshare.com/app.js',
    `${origin}.example.com/app.js`,
    'https://cdn.jsdelivr.net.example.com/app.js',
    'http://cdn.jsdelivr.net/app.js',
    'https://cdn.jsdelivr.net:444/app.js',
    origin.replace('https:', 'http:'),
    `${origin}:444/app.js`,
  ])('attributes unloadable source %s to the environment', (source) => {
    expect(classifyCspViolation(source, origin, 'html')).toBe('environment')
  })
})
