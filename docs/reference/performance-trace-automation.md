# Performance and CLI test diagnostics

Timing and browser traces vary by machine and data. They are manual evidence for investigation, never thresholds in ordinary CI.

## CLI test measurement

```sh
pnpm measure:cli-tests
```

The command builds the CLI, runs its Vitest suite, and replaces two ignored files:

- `.cli-test-measurements/latest.json` contains the schema version, timestamp, build and test wall time, suite/test counts, five slowest suites, and runtime CLI subprocess launches.
- `.cli-test-measurements/vitest.json` is the raw Vitest JSON report used by the summary.

The stable paths make before/after measurements comparable without committing machine-specific results.

## Chrome performance traces

Start the local application with `pnpm dev`, then run one named scenario:

```sh
pnpm perf:trace home-hover
pnpm perf:trace recent-hover
pnpm perf:trace project-hover
pnpm perf:trace home-hover -- --dev-persona free-owner --dev-scenario recent/content-rich
```

The command launches a temporary Chrome profile by default, records a bounded Chrome DevTools Protocol trace, and saves the trace and summary under ignored `.perf-traces/`. For the local app, `--dev-persona` signs in through the localhost-only development endpoint and `--dev-scenario` can seed representative local content. Use `--cdp-url` to connect to a Chrome instance that is already signed in for any other target. `--base-url`, `--out-dir`, `--chrome-path`, and `--headed` provide explicit local overrides.

Open the JSON trace in Chrome DevTools Performance or Perfetto. Delete `.perf-traces/` when the evidence is no longer needed. Trace contents may include visited URLs and page metadata, so inspect them before sharing.
