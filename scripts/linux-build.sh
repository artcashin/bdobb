#!/usr/bin/env bash
#
# Native Linux build, including arm64 boxes such as a DGX Spark.
#
#   scripts/linux-build.sh deps    # install the system libraries Tauri links
#   scripts/linux-build.sh build   # produce AppImage + .deb in src-tauri/target
#   scripts/linux-build.sh run     # dev build, for a desktop session on the box
#
# Building on the machine is the shortest path on arm64: Tauri links against
# the system webkit2gtk, and cross-compiling that from another architecture
# means assembling a sysroot, which is far more work than a native compile.
set -euo pipefail

CMD="${1:-build}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="$(uname -m)"
echo "[linux] $ARCH on $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown)"

deps() {
  . /etc/os-release 2>/dev/null || true
  case "${ID:-}${ID_LIKE:-}" in
    *debian*|*ubuntu*)
      # webkit2gtk-4.1 is the Tauri 2 dependency. Ubuntu 22.04 and Debian 12
      # both ship it; 24.04 dropped libappindicator3 in favour of ayatana, so
      # that one is attempted and allowed to fail rather than aborting.
      sudo apt-get update
      sudo apt-get install -y \
        libwebkit2gtk-4.1-dev librsvg2-dev patchelf libgtk-3-dev libssl-dev \
        build-essential curl wget file pkg-config
      sudo apt-get install -y libappindicator3-dev 2>/dev/null \
        || sudo apt-get install -y libayatana-appindicator3-dev \
        || echo "[linux] no appindicator package; tray support will be absent"
      ;;
    *rhel*|*fedora*)
      sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
        libappindicator-gtk3-devel librsvg2-devel gtk3-devel
      ;;
    *)
      echo "[linux] unrecognised distribution — install webkit2gtk 4.1 dev," >&2
      echo "        gtk3 dev, openssl dev, librsvg2 dev and patchelf by hand." >&2
      exit 1
      ;;
  esac

  command -v cargo >/dev/null 2>&1 || {
    echo "[linux] Rust is missing: https://rustup.rs" >&2; exit 1; }
  command -v pnpm >/dev/null 2>&1 || {
    echo "[linux] pnpm is missing: corepack enable pnpm" >&2; exit 1; }
  echo "[linux] dependencies satisfied"
}

case "$CMD" in
  deps) deps ;;
  build)
    pnpm install --frozen-lockfile
    # --strict: a build meant to be installed somewhere must not carry the
    # https://*.ts.net/* development fallback.
    node scripts/generate-capabilities.mjs --strict
    npx tauri build
    echo "[linux] artifacts:"
    find src-tauri/target -maxdepth 4 \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) \
      -newermt "-10 minutes" -print 2>/dev/null || true
    ;;
  run)
    pnpm install --frozen-lockfile
    node scripts/generate-capabilities.mjs
    npx tauri dev
    ;;
  *) echo "[linux] unknown command '$CMD' (deps|build|run)" >&2; exit 1 ;;
esac
