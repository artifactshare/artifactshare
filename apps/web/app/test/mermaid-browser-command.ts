import { defineBrowserCommand } from '@vitest/browser-playwright'

// Emulate the media feature directly: iframe color-scheme inheritance differs
// across browser engines and does not reliably activate the Markdown dark CSS.
export const setMermaidColorScheme = defineBrowserCommand(
  async ({ page }, colorScheme: 'light' | 'dark' | null) => {
    await page.emulateMedia({ colorScheme })
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    setMermaidColorScheme: (
      colorScheme: 'light' | 'dark' | null,
    ) => Promise<void>
  }
}
