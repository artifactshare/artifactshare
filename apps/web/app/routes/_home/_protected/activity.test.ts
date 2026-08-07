import { describe, expect, test } from 'vitest'
import { loader } from './activity'

describe('/activity loader', () => {
  test.each([
    'https://artifactshare.com/activity',
    'https://artifactshare.com/activity?feed=all',
    'https://artifactshare.com/activity?cursor=retired',
  ])('redirects the retired global activity URL to home: %s', async (url) => {
    let response: Response | undefined
    try {
      loader({ request: new Request(url), context: new Map() } as never)
    } catch (error) {
      response = error as Response
    }
    expect(response?.status).toBe(302)
    expect(response?.headers.get('Location')).toBe('/')
  })
})
