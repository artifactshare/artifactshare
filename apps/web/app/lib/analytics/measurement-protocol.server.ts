import { ANALYTICS_EVENTS, ANALYTICS_PARAMS } from './events'
type Env = { GA4_MEASUREMENT_ID?: string; GA4_MP_API_SECRET?: string }
export function isMeasurementProtocolConfigured(env: Env): boolean {
  return Boolean(env.GA4_MEASUREMENT_ID && env.GA4_MP_API_SECRET)
}
export async function sendFirstArtifactPosted(args: {
  env: Env
  userId: string
  clientId: string
  channel: 'web' | 'cli' | 'mcp'
}): Promise<void> {
  const { env, userId, clientId, channel } = args
  if (!isMeasurementProtocolConfigured(env)) return
  const url = new URL('https://www.google-analytics.com/mp/collect')
  url.searchParams.set('measurement_id', env.GA4_MEASUREMENT_ID!)
  url.searchParams.set('api_secret', env.GA4_MP_API_SECRET!)
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      user_id: userId,
      events: [
        {
          name: ANALYTICS_EVENTS.firstArtifactPosted,
          params: {
            [ANALYTICS_PARAMS.channel]: channel,
            engagement_time_msec: 1,
          },
        },
      ],
    }),
  })
}
