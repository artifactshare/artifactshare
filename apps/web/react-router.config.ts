import type { Config } from '@react-router/dev/config'

export default {
  ssr: true,
  buildDirectory: process.env.ARTIFACTSHARE_TEST_BUILD_DIRECTORY ?? 'build',
} satisfies Config
