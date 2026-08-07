import { errorResponse } from '~/lib/api-errors'

export function action() {
  return errorResponse(
    'removed-endpoint',
    'Upload files with multipart/form-data.',
    410,
  )
}
