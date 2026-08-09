import { captureScreens } from './screen-capture.mjs'

try {
  await captureScreens()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
