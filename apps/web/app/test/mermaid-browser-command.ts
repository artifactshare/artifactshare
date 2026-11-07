import { defineBrowserCommand } from '@vitest/browser-playwright'

// Emulate the media feature directly: iframe color-scheme inheritance differs
// across browser engines and does not reliably activate the Markdown dark CSS.
export const setMermaidColorScheme = defineBrowserCommand(
  async ({ page }, colorScheme: 'light' | 'dark' | null) => {
    await page.emulateMedia({ colorScheme })
  },
)

export const setReducedMotion = defineBrowserCommand(
  async ({ page }, reducedMotion: 'reduce' | 'no-preference' | null) => {
    await page.emulateMedia({ reducedMotion })
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    setReducedMotion: (
      reducedMotion: 'reduce' | 'no-preference' | null,
    ) => Promise<void>
    setMermaidColorScheme: (
      colorScheme: 'light' | 'dark' | null,
    ) => Promise<void>
  }
}
