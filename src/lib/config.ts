/**
 * Deployment endpoints.
 *
 * Real hostnames belong in .env.local, which is gitignored — nothing here
 * should identify a particular tailnet or machine. Copy .env.example to
 * .env.local and fill in your own values.
 *
 * These are only *defaults* for a fresh install: once the user edits Backends
 * in the app, the persisted config wins and these are unused.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Base URL of the OpenBB Platform API serving widgets.json. */
export const DEFAULT_API_URL = env.VITE_OPENBB_API_URL ?? "";
