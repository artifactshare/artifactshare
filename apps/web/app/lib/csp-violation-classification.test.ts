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
    'webkit-masked-url://hidden/',
    'custom:script',
    'data',
    'blob',
    'eval',
    'wasm-eval',
    'inline',
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

describe('CSP resource attribution when the initiating source is absent', () => {
  test.each([
    'https://example.com/a.png',
    'http://example.com/frame.html',
    `${origin}/a.png`,
    'data',
    'blob',
  ])('attributes the blocked resource %s to the artifact', (blockedURI) => {
    for (const source of [null, '']) {
      for (const renderType of ['html', 'md', 'static_site', null, 'unknown']) {
        expect(
          classifyCspViolation(source, origin, renderType, blockedURI),
        ).toBe('artifact')
      }
    }
  })

  test.each([
    '',
    'eval',
    'wasm-eval',
    'inline',
    'not a URL',
    '/a.png',
    '//example.com/a.png',
    'https://',
    'chrome-extension://abc/app.js',
    'moz-extension://abc/app.js',
    'safari-web-extension://abc/app.js',
    'CHROME-EXTENSION://abc/app.js',
    'webkit-masked-url:',
    'webkit-masked-url://hidden/',
    'custom:script',
    'file:///a.png',
    'data:',
    'blob:',
    'data:image/png;base64,AA==',
    `blob:${origin}/abc`,
    'DATA',
    'BLOB',
  ])('keeps other blocked values %s in the environment', (blockedURI) => {
    for (const source of [null, '']) {
      for (const renderType of ['html', 'md', 'static_site', null, 'unknown']) {
        expect(
          classifyCspViolation(source, origin, renderType, blockedURI),
        ).toBe('environment')
      }
    }
  })

  test.each([
    'https://example.com/a.png',
    'data',
    'blob',
    'eval',
    'webkit-masked-url:',
  ])('keeps a nonempty source authoritative when blocking %s', (blockedURI) => {
    expect(
      classifyCspViolation(`${origin}/index.html`, origin, 'html', blockedURI),
    ).toBe('artifact')
    expect(
      classifyCspViolation(
        'https://cdn.jsdelivr.net/app.js',
        origin,
        'html',
        blockedURI,
      ),
    ).toBe('artifact')
    for (const source of [
      'chrome-extension://abc/app.js',
      'https://example.com/app.js',
      'malformed',
    ]) {
      expect(classifyCspViolation(source, origin, 'html', blockedURI)).toBe(
        'environment',
      )
    }
    expect(
      classifyCspViolation(
        'https://cdn.jsdelivr.net/app.js',
        origin,
        'md',
        blockedURI,
      ),
    ).toBe('environment')
  })
})
