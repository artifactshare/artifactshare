import { spawn } from 'node:child_process'

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

async function terminateProcessTree(
  pid,
  {
    platform = process.platform,
    killImpl = process.kill,
    spawnImpl = spawn,
  } = {},
) {
  if (platform === 'win32') {
    const runTaskkill = async (force) => {
      const args = [...(force ? ['/F'] : []), '/PID', String(pid), '/T']
      return await waitForExit(spawnImpl('taskkill', args, { stdio: 'ignore' }))
    }
    await runTaskkill(false)
    return () => runTaskkill(true)
  }
  try {
    killImpl(-pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  return () => {
    try {
      killImpl(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
}

export { terminateProcessTree, waitForExit }
