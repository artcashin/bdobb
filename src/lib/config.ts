/**
 * Deployment endpoints.
 *
 * Real hostnames belong in .env.local, which is gitignored — nothing here
 * should identify a particular tailnet or machine. Copy .env.example to
 * .env.local and fill in your own values.
 *
 * These are only *defaults* for a fresh install: once the user edits Backends
 * or Settings in the app, the persisted config wins and these are unused.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Base URL of the OpenBB Platform API serving widgets.json. */
export const DEFAULT_API_URL = env.VITE_OPENBB_API_URL ?? "";

/** Base URL of the Agent Rita instance implementing the custom-agent protocol. */
export const DEFAULT_RITA_URL = env.VITE_RITA_URL ?? "";

/**
 * MCP servers to offer by default, as a comma-separated list of id=url pairs:
 *   VITE_MCP_SERVERS="openbb=https://host:8443/mcp,stores=https://host:8444/mcp"
 */
export const DEFAULT_MCP_SERVERS: { id: string; url: string; enabled: boolean }[] = (
  env.VITE_MCP_SERVERS ?? ""
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const idx = entry.indexOf("=");
    if (idx < 0) return null;
    const id = entry.slice(0, idx).trim();
    const url = entry.slice(idx + 1).trim();
    return id && url ? { id, url, enabled: true } : null;
  })
  .filter((s): s is { id: string; url: string; enabled: boolean } => s !== null);
