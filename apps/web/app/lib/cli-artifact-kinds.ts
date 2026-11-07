import {
  CLI_ARTIFACT_KINDS_HEADER,
  type ArtifactsListResponse,
  type ResolveResponse,
} from '@artifactshare/contract'

// Released CLIs validate artifact_kind against the kinds they were built with
// and reject the whole list or resolve response when one entry has a newer
// kind. Only clients that name the kind in this header receive it.
export function clientUnderstandsPdf(request: Request): boolean {
  return (request.headers.get(CLI_ARTIFACT_KINDS_HEADER) ?? '')
    .split(',')
    .some((kind) => kind.trim() === 'pdf')
}

// artifact_kind is optional in list entries, so older clients still see the
// PDF and simply get no kind for it.
export function artifactsListForClient(
  data: ArtifactsListResponse,
  request: Request,
): ArtifactsListResponse {
  if (clientUnderstandsPdf(request)) return data
  return {
    ...data,
    artifacts: data.artifacts.map(({ artifact_kind, ...entry }) =>
      artifact_kind === 'pdf' ? entry : { ...entry, artifact_kind },
    ),
  }
}

// artifact_kind is required in resolve candidates, so older clients do not
// receive PDF candidates; they cannot act on a PDF anyway.
export function resolveForClient(
  data: ResolveResponse,
  request: Request,
): ResolveResponse {
  if (clientUnderstandsPdf(request)) return data
  return {
    ...data,
    candidates: data.candidates.filter(
      (candidate) =>
        !('artifact_kind' in candidate) || candidate.artifact_kind !== 'pdf',
    ),
  }
}
