import { createCommentRuntime } from './comment-runtime'

const runtimes = new WeakMap<Window, ReturnType<typeof createCommentRuntime>>()

/** Called by committed effects and browser operations, never during SSR. */
export function acquireCommentRuntime(artifactId: string) {
  if (typeof window === 'undefined')
    throw new Error('Comment runtime requires a browser environment')
  let runtime = runtimes.get(window)
  if (!runtime) {
    runtime = createCommentRuntime((error) => {
      if (typeof window.reportError === 'function') window.reportError(error)
      else console.error('comment_runtime_subscriber_failed', error)
    })
    runtimes.set(window, runtime)
  }
  return runtime.acquire(artifactId)
}

export function withCommentRuntime<T>(
  artifactId: string,
  read: (lease: ReturnType<typeof acquireCommentRuntime>) => T,
): T {
  const lease = acquireCommentRuntime(artifactId)
  try {
    return read(lease)
  } finally {
    lease.release()
  }
}
