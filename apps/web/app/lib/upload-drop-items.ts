type DroppedEntry = {
  fullPath: string
  isDirectory: boolean
  isFile: boolean
}

type DroppedFileEntry = DroppedEntry & {
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void
}

type DroppedDirectoryEntry = DroppedEntry & {
  createReader: () => {
    readEntries: (
      successCallback: (entries: DroppedEntry[]) => void,
      errorCallback?: (error: DOMException) => void,
    ) => void
  }
}

type DroppedItem = {
  webkitGetAsEntry?: () => DroppedEntry | null
}

const DROP_ENTRY_READ_TIMEOUT_MS = 10_000

export async function filesFromDrop(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const fallbackFiles = Array.from(dataTransfer.files)
  const entries: DroppedEntry[] = []
  const directFiles: File[] = []

  for (const item of Array.from(dataTransfer.items)) {
    const entry = (item as unknown as DroppedItem).webkitGetAsEntry?.() ?? null
    if (entry) entries.push(entry)
    else {
      const file = item.getAsFile()
      if (file) directFiles.push(file)
    }
  }

  if (entries.length === 0) {
    return directFiles.length > 0 ? directFiles : fallbackFiles
  }

  const files = await Promise.all(entries.map((entry) => filesFromEntry(entry)))
  return [...directFiles, ...files.flat()]
}

async function filesFromEntry(entry: DroppedEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as DroppedFileEntry)
    return [fileWithRelativePath(file, entry.fullPath)]
  }

  if (!entry.isDirectory) return []

  const entries = await entriesFromDirectory(entry as DroppedDirectoryEntry)
  const files = await Promise.all(entries.map((child) => filesFromEntry(child)))
  return files.flat()
}

function fileFromEntry(entry: DroppedFileEntry): Promise<File> {
  return withTimeout(
    new Promise((resolve, reject) => {
      entry.file(resolve, reject)
    }),
  )
}

async function entriesFromDirectory(
  entry: DroppedDirectoryEntry,
): Promise<DroppedEntry[]> {
  const reader = entry.createReader()
  const entries: DroppedEntry[] = []

  while (true) {
    const batch = await withTimeout(
      new Promise<DroppedEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      }),
    )
    if (batch.length === 0) return entries
    entries.push(...batch)
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new DOMException('Timed out while reading dropped files'))
    }, DROP_ENTRY_READ_TIMEOUT_MS)
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function fileWithRelativePath(file: File, fullPath: string): File {
  const relativePath = fullPath.replace(/^\/+/, '')
  if (relativePath.length === 0) return file
  Object.defineProperty(file, 'webkitRelativePath', {
    configurable: true,
    value: relativePath,
  })
  return file
}
