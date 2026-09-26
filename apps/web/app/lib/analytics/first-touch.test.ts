import { describe, expect, it } from 'vitest'
import {
  artifactIdFromReturnPath,
  parseFirstTouch,
  referrerDomainFromReferrer,
  serializeFirstTouch,
  utmFromSearch,
} from './first-touch'

describe('first-touch', () => {
  it('reads the artifact id from a sign-in return path', () => {
    expect(artifactIdFromReturnPath('/a/abc_123')).toBe('abc_123')
    expect(artifactIdFromReturnPath('/a/abc123?version=2')).toBe('abc123')
    expect(artifactIdFromReturnPath('/a/abc123/comments')).toBe('abc123')
    expect(artifactIdFromReturnPath('/projects/p1')).toBeUndefined()
    expect(artifactIdFromReturnPath('/a/')).toBeUndefined()
    expect(artifactIdFromReturnPath(null)).toBeUndefined()
  })

  it('extracts UTM parameters', () => {
    expect(utmFromSearch('?utm_source=a&utm_medium=b&x=y')).toEqual({
      utm_source: 'a',
      utm_medium: 'b',
    })
    expect(utmFromSearch('')).toBeUndefined()
    expect(utmFromSearch('?x=y')).toBeUndefined()
  })

  it('extracts a valid referrer domain', () => {
    expect(referrerDomainFromReferrer('https://ex.com/p?q')).toBe('ex.com')
    expect(referrerDomainFromReferrer('')).toBeUndefined()
    expect(referrerDomainFromReferrer(null)).toBeUndefined()
    expect(referrerDomainFromReferrer(undefined)).toBeUndefined()
    expect(referrerDomainFromReferrer('not a url')).toBeUndefined()
  })

  it('serializes and parses first-touch data', () => {
    const firstTouch = {
      utm: { utm_source: 'a' },
      referrerDomain: 'ex.com',
      artifactId: 'id1',
    }
    expect(parseFirstTouch(serializeFirstTouch(firstTouch))).toEqual(firstTouch)
    expect(parseFirstTouch(null)).toBeNull()
    expect(parseFirstTouch('{')).toBeNull()
    expect(parseFirstTouch('[]')).toBeNull()
    expect(parseFirstTouch('{"artifactId":1}')).toBeNull()
  })
})
