// The one list of extensions artifact delivery refuses to serve. It lives
// under reporter/ so the reporter bundle stays self-contained, and it holds
// the list as a single regular expression literal because the bundle guard
// rejects a top-level array and a page could replace `Array.prototype.join`
// inside the sandboxed document.
export function hasRefusedExtension(path: string): boolean {
  return /\.(?:exe|sh|php|py|rb|bat|cmd|dll|so)$/i.test(path)
}
