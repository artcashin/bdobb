# BDOBB — Better Desktop for OpenBB

A Tauri 2 desktop app for self-hosted OpenBB stacks — the frontend of the
**Adventures in OpenBB** series. Each tagged release is the companion code
for one episode: check out the tag, follow that episode's "For the
tinkerers" section, and the app has exactly that chapter's functionality.

*The release map fills in here as episodes publish.*

**Status: scaffold — v3.0.0 in progress.**

Endpoints are supplied by your environment (`.env.local`, gitignored), never
committed; the HTTP capability allowlist is generated from it at build time.
CI runs `scripts/scrub-check.sh` to keep private infrastructure out.

MIT licensed.
