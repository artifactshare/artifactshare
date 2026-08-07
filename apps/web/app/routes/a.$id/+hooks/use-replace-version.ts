import { useCallback, useRef } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
  isReplaceVersionErrorCode,
  readErrorTag,
  REPLACE_VERSION_ERROR_I18N,
} from '~/lib/api-errors'
import { useT } from '~/hooks/use-t'
import {
  appendUploadFiles,
  filterUploadFiles,
  validateFiles,
} from '~/lib/upload-artifact-validation'

interface ReplaceVersionDeps {
  fetcher: typeof fetch
  revalidate: () => void
  t: ReturnType<typeof useT>['t']
  loading: typeof toast.loading
  success: typeof toast.success
  error: typeof toast.error
  onSuccess?: () => void
}

export interface UseReplaceVersionOptions {
  onSuccess?: () => void
}

export type ReplaceVersionInput =
  | { kind: 'single'; files: File[] }
  | { kind: 'static_site'; files: File[] }

export function useReplaceVersion(
  shareableId: string,
  options?: UseReplaceVersionOptions,
) {
  const translator = useT()
  const revalidator = useRevalidator()
  const pending = useRef(false)
  // options を ref で保持して、callback identity を毎 render で変えない
  const optionsRef = useRef(options)
  optionsRef.current = options

  return useCallback(
    async (input: ReplaceVersionInput) => {
      if (pending.current) return
      pending.current = true
      const toastId = `replace-${shareableId}`

      try {
        await replaceVersion({
          shareableId,
          input,
          toastId,
          deps: {
            // fetch は Window method で、bare reference として渡すと
            // 呼び出し時に this binding が外れて "Illegal invocation" になる
            fetcher: (resource, init) => fetch(resource, init),
            revalidate: () => revalidator.revalidate(),
            t: translator.t,
            loading: toast.loading,
            success: toast.success,
            error: toast.error,
            onSuccess: () => optionsRef.current?.onSuccess?.(),
          },
        })
      } finally {
        pending.current = false
      }
    },
    [revalidator, shareableId, translator],
  )
}

export async function replaceVersion({
  shareableId,
  input,
  toastId,
  deps,
}: {
  shareableId: string
  input: ReplaceVersionInput
  toastId: string
  deps: ReplaceVersionDeps
}) {
  const files =
    input.kind === 'single'
      ? input.files.slice(0, 1)
      : filterUploadFiles(input.files)
  if (files.length === 0) {
    deps.error(deps.t('upload.error.missingFile'), { id: toastId })
    return
  }
  const problem = validateFiles(files, deps.t, {
    staticSite: input.kind === 'static_site',
  })
  if (problem) {
    deps.error(problem, { id: toastId })
    return
  }
  deps.loading(deps.t('upload.toast.uploading'), { id: toastId })

  const form = new FormData()
  if (input.kind === 'single') {
    form.set('file', files[0])
  } else {
    appendUploadFiles(form, files)
  }
  const url =
    input.kind === 'static_site'
      ? `/api/shareables/${encodeURIComponent(shareableId)}/versions?artifact_kind=static_site`
      : `/api/shareables/${encodeURIComponent(shareableId)}/versions`

  try {
    const res = await deps.fetcher(url, { method: 'POST', body: form })
    if (!res.ok) {
      const code = await readErrorTag(res)
      const key = isReplaceVersionErrorCode(code)
        ? REPLACE_VERSION_ERROR_I18N[code]
        : 'upload.error.generic'
      deps.error(deps.t(key), { id: toastId })
      return
    }
    deps.success(deps.t('toast.repaired'), { id: toastId })
    deps.revalidate()
    deps.onSuccess?.()
  } catch (err) {
    deps.error(
      err instanceof Error ? err.message : deps.t('upload.error.generic'),
      { id: toastId },
    )
  }
}
