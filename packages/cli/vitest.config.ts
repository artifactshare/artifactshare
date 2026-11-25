import { defineConfig } from 'vitest/config'

// Timeouts seen on a slow CI runner: a test hit "Test timed out in 5000ms"
// and a hook hit "Hook timed out in 10000ms", both vitest defaults.
//
// Those defaults are too small for this suite by construction, not only when
// a runner is slow. Nearly every test here either launches the built CLI as a
// subprocess or runs a multi-step filesystem transaction, and the helpers
// that launch the CLI already allow a single launch up to 10 s
// (`spawnSync({ timeout: 10_000 })`). A test that makes two or three launches
// therefore could not fit in a 5 s budget even in principle, so the test
// timeout fired before the launch helper's own timeout could report which
// launch was slow.
//
// Measured on a 4-core host: the filesystem-transaction tests take 10-242 ms
// each when idle, and up to 1934 ms each with twice as many busy processes as
// cores, so latency here is dominated by scheduling, not by the work itself.
// These budgets leave room for that without hiding a hang: anything that
// reaches them is stuck, not merely slow.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
