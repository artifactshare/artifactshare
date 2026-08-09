export function compileScanConfig(config) {
  return {
    patterns: config.patterns.map((item) => ({
      ...item,
      regex: new RegExp(item.pattern, 'giu'),
      pathRegex: item.path ? new RegExp(item.path, 'u') : undefined,
    })),
    allowlist: config.allowlist.map((item) => ({
      ...item,
      regex: new RegExp(item.pattern, 'iu'),
      pathRegex: item.path ? new RegExp(item.path, 'u') : undefined,
    })),
  }
}

export function scanValue(value, filePath, compiled) {
  const findings = []
  for (const item of compiled.patterns) {
    if (item.pathRegex && !item.pathRegex.test(filePath)) continue
    item.regex.lastIndex = 0
    for (const match of value.matchAll(item.regex)) {
      const allowed = compiled.allowlist.some(
        (entry) =>
          entry.category === item.category &&
          (!entry.pathRegex || entry.pathRegex.test(filePath)) &&
          entry.regex.test(match[0]),
      )
      if (!allowed)
        findings.push({ category: item.category, pattern: item.pattern })
    }
  }
  return findings
}
