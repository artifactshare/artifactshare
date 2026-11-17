/** @type {import('next').NextConfig} */
const nextConfig = {
  generateBuildId: async () => 'artifactshare-fixture',
  images: {
    unoptimized: true,
  },
  output: 'export',
}

export default nextConfig
