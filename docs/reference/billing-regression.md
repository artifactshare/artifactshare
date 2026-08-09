# Billing regression harness

The billing regression exercises the current application, local D1 state, Stripe test mode, webhook reconciliation, and public CLI/API boundaries together. It is a manual diagnostic and never runs in ordinary validation or GitHub Actions.

## Safety boundary

The command refuses every Stripe key that is not explicitly test mode. It requires confirmation before creating Stripe test resources, and a non-interactive caller must pass `--yes`. It never accepts or reads production Cloudflare credentials.

Each run creates a fresh D1 state directory under the operating system's temporary directory. The app, setup command, and direct D1 queries share that isolated state. The directory is removed after the run, so the ordinary local development database is never reset or reused.

The run creates Stripe test customers, subscriptions, payment methods, invoices, and test clocks. It deletes tracked customers and clocks after the application and webhook listener stop. Cleanup failures are reported without printing resource identifiers or hiding an earlier scenario failure.

## Prerequisites

Install project dependencies and the Stripe CLI. Prepare the local development environment, then provide these test-mode values in the untracked root `.dev.vars`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PLUS_MONTHLY`
- `STRIPE_PRICE_PLUS_YEARLY`
- `STRIPE_PRICE_TEAM_MONTHLY`
- `STRIPE_PRICE_TEAM_YEARLY`
- `STRIPE_PRODUCT_STORAGE_OVERAGE`
- `STRIPE_PORTAL_CONFIGURATION`

The webhook secret must match `stripe listen --print-secret` for the selected test key. Other application variables continue to come from the same local file.

## Run

```sh
pnpm billing:regression
pnpm billing:regression --yes
pnpm billing:regression --only 1,3,6
```

The full run covers:

1. Plus subscription, project limit, and external project posting.
2. Plus-to-Team plan change without duplicate subscription items.
3. Team checkout and direct subscription reconciliation.
4. Storage-overage and zero-overage invoice behavior with test clocks.
5. Payment failure while retaining paid-plan data access.
6. Cancellation, existing-content access, and free-plan posting restrictions.

Each scenario reports independently. A failed scenario does not prevent later scenarios from gathering evidence, and any failure makes the command exit nonzero.

## Local side effects

The confirmed run creates remote Stripe test-mode resources and an isolated temporary D1 state. It does not modify the ordinary app D1 state. Certificates and local variables are prepared by the public development harness. The app runs at `https://localhost:5173`; the Stripe CLI forwards test events to its local webhook endpoint.

Secrets, authorization cookies, and remote resource identifiers must not be copied into issues, pull requests, logs, or committed artifacts.
