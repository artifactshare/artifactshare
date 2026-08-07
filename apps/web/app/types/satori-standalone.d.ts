// tsgo (TS 7 preview) は satori package.json の conditional exports
// (nested "types") を解決し損ねるため、ambient declaration で補う。
declare module 'satori/standalone' {
  import type { SatoriOptions, SatoriNode } from 'satori'
  const satori: (element: unknown, options: SatoriOptions) => Promise<string>
  export default satori
  export const init: (yoga: unknown) => Promise<void>
  export type { SatoriOptions, SatoriNode }
}

declare module 'satori/yoga.wasm' {
  const wasm: unknown
  export default wasm
}
