// Keep punctuation inside a token together unless the token exceeds the line.
// Captured whitespace stays outside the spans, preserving spaces and newlines.
export function WrappableCodeText({ text }: { text: string }) {
  return text.split(/(\s+)/).map((part, index, parts) =>
    /\S/.test(part) ? (
      <span
        key={parts.slice(0, index + 1).join('')}
        className="inline-block max-w-full [overflow-wrap:anywhere]"
      >
        {part}
      </span>
    ) : (
      part
    ),
  )
}
