// Type stub for the @artifactshare/viewer-kit workspace package.
//
// viewer-kit ships TypeScript sources tuned for moduleResolution "bundler"
// and a looser strictness profile; pulling them into this package's NodeNext
// program fails typecheck. tsconfig "paths" points the compiler at these
// stubs, while the build (tsdown) and tests (vitest) resolve and bundle the
// real sources. Keep signatures in sync with packages/viewer-kit/src.
export declare function injectReadyReporter(html: string): string
