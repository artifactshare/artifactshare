/** Self-contained so the exact validator can also run in the local shell.
 * This admits display observations only, never authorization or commands. */
export function validPreviewObservation(value: unknown): boolean {
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  const keys = (v: Record<string, unknown>, names: string[]) =>
    Object.keys(v).length === names.length &&
    names.every((key) => Object.hasOwn(v, key))
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.length <= max
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
  const rect = (v: unknown) =>
    record(v) &&
    keys(v, ['top', 'left', 'width', 'height']) &&
    ['top', 'left', 'width', 'height'].every(
      (key) =>
        typeof v[key] === 'number' &&
        Number.isFinite(v[key]) &&
        Math.abs(v[key] as number) <= 1_000_000 &&
        ((key !== 'width' && key !== 'height') || (v[key] as number) >= 0),
    )
  if (!record(value)) return false
  const base = [
    'source',
    'kind',
    'previewCapability',
    'documentGeneration',
    'sequence',
  ]
  if (
    value.source !== 'artifactshare' ||
    typeof value.previewCapability !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.previewCapability) ||
    !integer(value.documentGeneration) ||
    !integer(value.sequence) ||
    value.sequence === 0
  )
    return false
  switch (value.kind) {
    case 'ready':
      return (
        keys(value, [
          ...base,
          'challenge',
          'token',
          ...(Object.hasOwn(value, 'editing') ? ['editing'] : []),
        ]) &&
        (!Object.hasOwn(value, 'editing') || value.editing === true) &&
        str(value.challenge, 64) &&
        typeof value.token === 'string' &&
        /^[a-f0-9]{64}$/.test(value.token)
      )
    case 'screen':
      return keys(value, [...base, 'screen']) && str(value.screen, 1000)
    case 'screen-shown':
      return (
        keys(value, [...base, 'screen', 'outcome']) &&
        str(value.screen, 1000) &&
        ['shown', 'not-shown', 'superseded'].includes(value.outcome as string)
      )
    case 'annotation-geometry':
      return (
        keys(value, [...base, 'pickSequence', 'rect']) &&
        integer(value.pickSequence) &&
        value.pickSequence > 0 &&
        (value.rect === null || rect(value.rect))
      )
    case 'element-annotate':
      return (
        keys(value, [
          ...base,
          'selector',
          'label',
          'contextText',
          ...(Object.hasOwn(value, 'ownTextHash')
            ? ['ownTextHash', 'ownTextExcerpt']
            : ['ownText']),
          'tagName',
          ...(Object.hasOwn(value, 'editable') ? ['editable'] : []),
          'rect',
        ]) &&
        str(value.selector, 4096) &&
        str(value.label, 1024) &&
        str(value.contextText, 4096) &&
        (Object.hasOwn(value, 'ownTextHash')
          ? typeof value.ownTextHash === 'string' &&
            /^[a-f0-9]{64}$/.test(value.ownTextHash) &&
            str(value.ownTextExcerpt, 16_000)
          : str(value.ownText, 1_000_000)) &&
        str(value.tagName, 128) &&
        (!Object.hasOwn(value, 'editable') ||
          typeof value.editable === 'boolean') &&
        rect(value.rect)
      )
    // In-place edit drafts: plain text, bounded like a rewrite.
    case 'edit-text':
      return keys(value, [...base, 'text']) && str(value.text, 16_000)
    case 'edit-ended':
      return (
        keys(value, [...base, 'pickSequence']) &&
        integer(value.pickSequence) &&
        value.pickSequence > 0
      )
    case 'edit-key':
      return (
        keys(value, [...base, 'key']) &&
        ['commit', 'cancel', 'comment'].includes(value.key as string)
      )
    case 'text-selection':
      return (
        keys(value, [
          ...base,
          'token',
          'quotedText',
          'prefixText',
          'suffixText',
          'textStart',
          'textEnd',
          'selectorFormat',
          'textHash',
          'ambiguousAtCreation',
          // Creation context is not used by local preview.
          ...(Object.hasOwn(value, 'locus') ? ['locus'] : []),
          'versionId',
          'cssPath',
          'rect',
        ]) &&
        typeof value.token === 'string' &&
        /^[a-f0-9]{64}$/.test(value.token) &&
        str(value.quotedText, 16384) &&
        (value.quotedText as string).length > 0 &&
        str(value.prefixText, 4096) &&
        str(value.suffixText, 4096) &&
        integer(value.textStart, 100_000_000) &&
        integer(value.textEnd, 100_000_000) &&
        value.textEnd - value.textStart ===
          (value.quotedText as string).length &&
        value.selectorFormat === 'normalized-v1' &&
        typeof value.textHash === 'string' &&
        /^[a-f0-9]{64}$/.test(value.textHash) &&
        typeof value.ambiguousAtCreation === 'boolean' &&
        value.versionId === null &&
        (value.cssPath === null || str(value.cssPath, 4096)) &&
        rect(value.rect)
      )
    case 'anchor-verdicts':
      return (
        keys(value, [...base, 'verificationId', 'generation', 'verdicts']) &&
        integer(value.verificationId) &&
        integer(value.generation) &&
        Array.isArray(value.verdicts) &&
        value.verdicts.length <= 1000 &&
        new Set(
          value.verdicts.map((v: unknown) => (record(v) ? v.thread : null)),
        ).size === value.verdicts.length &&
        value.verdicts.every(
          (v: unknown) =>
            record(v) &&
            keys(v, ['thread', 'attached', 'position_state']) &&
            str(v.thread, 128) &&
            typeof v.attached === 'boolean' &&
            (v.attached
              ? v.position_state === 'attached'
              : ['checking', 'needs-check', 'other-screen'].includes(
                  v.position_state as string,
                )),
        )
      )
    default:
      return false
  }
}
