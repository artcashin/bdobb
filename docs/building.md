# Build paths

Three desktop targets, all production paths.

Every path runs `scripts/generate-capabilities.mjs` first, because Tauri
capabilities are compiled into the binary and must exist on disk before cargo
runs. Release paths pass `--strict`, which fails the build rather than shipping
the `https://*.ts.net/*` development fallback.

The same script turns `VITE_SHARE_FOLDERS` into the fs scope, which is what
lets a "Send to…" **file** share target export a Rita conversation into a
markdown vault (Tolaria, Obsidian) so it can be kept and referenced later —
the service-backed kinds, `mcp` and `http`, go to Notion or a webhook and need
no filesystem permission at all. Because dev is permissive and a packaged
build is not, a file target that works under `pnpm dev` fails in a release
whose scope omits its folder; that is the usual cause of a share that
"silently does nothing" only once installed. The paths must be absolute, so
they are per-machine and belong in `.env.local` rather than in a repository
variable, which would compile one developer's home directory into every
published binary.

| Target | Command | Produces | Notes |
|---|---|---|---|
| macOS (Apple Silicon) | `pnpm tauri build` | `.dmg`, `.app` | Unsigned |
| macOS (Intel) | `pnpm tauri build --target x86_64-apple-darwin` | `.dmg`, `.app` | Unsigned |
| Windows x64 | `pnpm tauri build` | NSIS `.exe`, `.msi` | Unsigned |
| Linux x86_64 | `pnpm linux:build` | `.AppImage`, `.deb` | |
| Linux arm64 (DGX) | `pnpm linux:build` | `.AppImage`, `.deb` | Build on the box |

Tagging `v*` runs all five desktop combinations in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) and opens a
draft release.

## macOS

```bash
pnpm tauri build                                    # host architecture
pnpm tauri build --target x86_64-apple-darwin       # Intel, from an ARM Mac
```

Both architectures build from either Mac; only the Rust target differs, since
there is no system webview to cross-link against the way there is on Linux.

Builds are **unsigned**. Gatekeeper refuses a downloaded unsigned `.app` on
first launch — right-click → Open, once. Signing needs an Apple Developer
account and would mean adding `APPLE_CERTIFICATE` secrets to the release
workflow; nothing else about the build changes.

## Windows

`pnpm tauri build` on a Windows host with the MSVC toolchain. Cross-compiling
from macOS or Linux is not supported for a bundled app — the NSIS and WiX
bundlers are Windows programs.

Unsigned, so SmartScreen shows "Windows protected your PC" on first run: *More
info* → *Run anyway*.

## Linux, including the DGX

DGX Spark is Grace/Blackwell, which is **arm64, not x86**. Both architectures
work the same way, and both are best built natively:

```bash
pnpm linux:deps      # system libraries, once per machine
pnpm linux:build     # AppImage + .deb
pnpm linux:build run # or a dev session on the box
```

Building on the target machine is the shortest path on arm64 specifically.
Tauri links against the system `webkit2gtk-4.1`, so cross-compiling means
assembling a full sysroot for the other architecture — considerably more work
than a native compile, and a recurring source of link errors.

`scripts/linux-build.sh deps` handles Debian/Ubuntu and Fedora/RHEL. On Ubuntu
24.04 `libappindicator3-dev` no longer exists; the script falls back to
`libayatana-appindicator3-dev` and, failing that, continues without tray
support rather than aborting.

CI covers both architectures on `ubuntu-22.04` and `ubuntu-22.04-arm`. Those
arm64 runners have been generally available for public repositories since
August 2025 and for private ones since January 2026, so no self-hosted runner
is needed either way. 22.04 is deliberate: it ships `webkit2gtk-4.1`, which is
what Tauri 2 wants.

## What is not signed

Nothing. Every artifact is unsigned, which is fine for a private tailnet tool
installed by the person who built it and not fine for wider distribution. The
three separate mechanisms — Apple notarisation, Windows Authenticode, Linux
repository signing — are independent of each other and of everything above.
