export function splitAssetRef(value: string): {
  pathname: string
  suffix: string
} {
  const hashIndex = value.indexOf('#')
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : value.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (queryIndex === -1) return { pathname: beforeHash, suffix: hash }

  return {
    pathname: beforeHash.slice(0, queryIndex),
    suffix: `${beforeHash.slice(queryIndex)}${hash}`,
  }
}
