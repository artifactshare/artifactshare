import { defineBrowserCommand } from '@vitest/browser-playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const captureDirectory = resolve('.vitest/settings-contrast')
// Native controls are painted by Chromium, not represented by borderColor.
export const settingsContrastCapture = defineBrowserCommand(
  async ({ frame }, selector: string, name: string) => {
    await mkdir(captureDirectory, { recursive: true })
    const fixture = (await frame()).locator(selector)
    return (
      await fixture.screenshot({
        path: resolve(captureDirectory, `${name}.png`),
      })
    ).toString('base64')
  },
)

type ContrastSample = {
  name: string
  x: number
  y: number
  border: number[]
  background: number[]
  ratio: number
}
export const settingsContrastReport = defineBrowserCommand(
  async (_, sample: ContrastSample) => {
    await mkdir(captureDirectory, { recursive: true })
    await writeFile(
      resolve(captureDirectory, `${sample.name}.json`),
      JSON.stringify(sample, null, 2),
    )
    console.info('Settings contrast sample (Chromium)', sample)
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    settingsContrastCapture: (selector: string, name: string) => Promise<string>
    settingsContrastReport: (sample: ContrastSample) => Promise<void>
  }
}
