export function configureDirectoryInput(element: HTMLInputElement | null) {
  if (!element) return
  element.setAttribute('webkitdirectory', '')
  element.setAttribute('directory', '')
}
