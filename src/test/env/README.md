Intentionally empty of `.env` files.

`vite.config.ts` points `envDir` here when running under vitest. Vite loads
`.env*` from `envDir` at transform time and inlines the values into
`import.meta.env`, which happens before `test.env` is applied — so `test.env`
cannot override them. Pointing `envDir` at a directory with no `.env` files is
what actually keeps `.env.local` out of the test run.

Without this, `src/lib/config.ts` resolves `DEFAULT_RITA_URL`,
`DEFAULT_API_URL` and `DEFAULT_MCP_SERVERS` from whatever the developer has
deployed. Tests then pass locally and behave differently on CI, and some reach
the real tailnet: the settings store seeds `DEFAULT_MCP_SERVERS`, so sending a
chat in a component test triggers live MCP discovery against a private host.

Endpoints belong in per-test fixtures, not in ambient configuration.
