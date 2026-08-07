export function stringValue(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
