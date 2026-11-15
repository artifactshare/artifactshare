import type { DropDataTransfer } from '~/lib/upload-drop-items'
export function dataTransfer(
  overrides: Partial<DropDataTransfer> = {},
): DropDataTransfer {
  return { files: [], items: [], ...overrides }
}
