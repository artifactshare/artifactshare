import {
  CLI_ARTIFACT_KINDS_HEADER,
  type ArtifactKind,
  type ArtifactsListResponse,
  type ResolveResponse,
} from '@artifactshare/contract'

// Kinds added after the first CLI release. Released CLIs validate
// artifact_kind against the kinds they were built with and reject the whole
// list or resolve response when one entry has a newer kind. Only clients that
// name a kind in this header receive it; each kind is checked on its own.
const GATED_ARTIFACT_KINDS = ['pdf', 'video'] as const
type GatedArtifactKind = (typeof GATED_ARTIFACT_KINDS)[number]

export function clientArtifactKinds(request: Request): Set<string> {
  return new Set(
    (request.headers.get(CLI_ARTIFACT_KINDS_HEADER) ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter(Boolean),
  )
}

function isGatedArtifactKind(kind: string): kind is GatedArtifactKind {
  return (GATED_ARTIFACT_KINDS as readonly string[]).includes(kind)
}

// True when the kind is known to every client or named by this one.
function understoodBy(
  kind: ArtifactKind | undefined,
  named: Set<string>,
): boolean {
  return !kind || !isGatedArtifactKind(kind) || named.has(kind)
}

// artifact_kind is optional in list entries, so older clients still see a
// PDF or video and simply get no kind for it.
export function artifactsListForClient(
  data: ArtifactsListResponse,
  request: Request,
): ArtifactsListResponse {
  const named = clientArtifactKinds(request)
  if (GATED_ARTIFACT_KINDS.every((kind) => named.has(kind))) return data
  return {
    ...data,
    artifacts: data.artifacts.map(({ artifact_kind, ...entry }) =>
      understoodBy(artifact_kind, named) && artifact_kind
        ? { ...entry, artifact_kind }
        : entry,
    ),
  }
}

// artifact_kind is required in resolve candidates, so older clients do not
// receive candidates of a kind they do not name; they cannot act on them.
export function resolveForClient(
  data: ResolveResponse,
  request: Request,
): ResolveResponse {
  const named = clientArtifactKinds(request)
  if (GATED_ARTIFACT_KINDS.every((kind) => named.has(kind))) return data
  return {
    ...data,
    candidates: data.candidates.filter(
      (candidate) =>
        !('artifact_kind' in candidate) ||
        understoodBy(candidate.artifact_kind, named),
    ),
  }
}
