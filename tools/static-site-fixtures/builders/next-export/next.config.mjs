// The local capture commands build the fixtures in an export of HEAD whose
// dependencies are links into the checkout. Turbopack compiles nothing
// outside its root (the nearest lockfile), so they name a root that contains
// both trees. Unset keeps the default root.
const turbopackRoot = process.env.STATIC_SITE_FIXTURES_TURBOPACK_ROOT

/** @type {import('next').NextConfig} */
const nextConfig = {
  generateBuildId: async () => 'artifactshare-fixture',
  images: {
    unoptimized: true,
  },
  output: 'export',
  ...(turbopackRoot ? { turbopack: { root: turbopackRoot } } : {}),
}

export default nextConfig
