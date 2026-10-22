export interface UsercontentResponse {
  url: URL
  status: number
  body: string
}

// Observe only responses requested by the current stage. The local HTTPS proxy
// sees the real Worker response even when automation cannot track the iframe.
// Do not retain unrelated bodies, signed URLs, or cookies in diagnostics.
export function createUsercontentResponseObserver() {
  const listeners = new Set<(response: UsercontentResponse) => void>()
  return {
    record(response: UsercontentResponse) {
      for (const listener of listeners) listener(response)
    },
    async during(
      matches: (response: UsercontentResponse) => boolean,
      navigate: () => Promise<unknown>,
    ): Promise<UsercontentResponse> {
      let listener!: (response: UsercontentResponse) => void
      let timeout!: ReturnType<typeof setTimeout>
      const observed = new Promise<UsercontentResponse>((resolve, reject) => {
        listener = (response) => {
          if (matches(response)) resolve(response)
        }
        listeners.add(listener)
        timeout = setTimeout(() => {
          reject(
            new Error(
              'Local proxy did not observe the expected response within 30000ms',
            ),
          )
        }, 30_000)
      })
      try {
        // Attach both rejection handlers before starting navigation. A failed
        // navigation or response timeout always removes the pending observer.
        const [response] = await Promise.all([
          observed,
          Promise.resolve().then(navigate),
        ])
        return response
      } finally {
        clearTimeout(timeout)
        listeners.delete(listener)
      }
    },
  }
}
