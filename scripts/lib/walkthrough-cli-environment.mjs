import { join } from 'node:path'

export function walkthroughCliEnvironment({
  tempDir,
  token,
  env = process.env,
}) {
  const home = join(tempDir, 'cli-home')
  const isolated = { ...env }
  for (const name of Object.keys(isolated))
    if (/^(?:XDG_|ARTIFACTSHARE_)/u.test(name)) delete isolated[name]
  return {
    cwd: join(tempDir, 'cli-cwd'),
    home,
    env: {
      ...isolated,
      HOME: home,
      USERPROFILE: home,
      ARTIFACTSHARE_CONFIG_HOME: join(home, '.config/artifactshare'),
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      ARTIFACTSHARE_TOKEN: token,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  }
}
