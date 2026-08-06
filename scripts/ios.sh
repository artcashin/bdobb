#!/usr/bin/env bash
#
# iPadOS / iOS build path.
#
#   scripts/ios.sh check     # prerequisites only, changes nothing
#   scripts/ios.sh team      # report signing team ids after adding an Apple ID
#   scripts/ios.sh init      # generate src-tauri/gen/apple (once)
#   scripts/ios.sh dev       # run on a simulator or attached device
#   scripts/ios.sh build     # produce an .ipa
#
# Split out from package.json because every one of these fails in a way that
# needs explaining. `tauri ios init` on a machine with only Command Line Tools
# reports a missing binary rather than "install Xcode", which is a confusing
# half hour for anyone who has not hit it before.
set -euo pipefail

CMD="${1:-check}"
shift || true   # remaining args pass through to the tauri CLI
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "[ios] $1" >&2; exit 1; }

# The Apple team id identifies the developer account, so it is installation
# data and belongs in .env.local rather than in a committed tauri.conf.json —
# the same rule the HTTP endpoints follow. Tauri reads bundle.iOS.developmentTeam
# from the config, and APPLE_DEVELOPMENT_TEAM overrides it.
if [ -z "${APPLE_DEVELOPMENT_TEAM:-}" ] && [ -f "$ROOT/.env.local" ]; then
  APPLE_DEVELOPMENT_TEAM="$(sed -n 's/^APPLE_DEVELOPMENT_TEAM=//p' "$ROOT/.env.local" | tail -1 | tr -d '"'"'"' ')"
  [ -n "$APPLE_DEVELOPMENT_TEAM" ] && export APPLE_DEVELOPMENT_TEAM
fi

# Team ids, read from the OU field of an installed signing certificate.
#
# Not the parenthesised id in the common name, which is the certificate's own
# id and is a different value: "Apple Development: you@example.com (A1B2C3D4E5)"
# with OU=Z9Y8X7W6V5 signs for team Z9Y8X7W6V5, and A1B2C3D4E5 resolves no
# profile at all.
discovered_teams() {
  security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/.*"\(Apple Develop[^"]*\)".*/\1/p' |
    while IFS= read -r cn; do
      security find-certificate -c "$cn" -p 2>/dev/null |
        openssl x509 -noout -subject 2>/dev/null |
        sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p'
    done | sort -u
}

check() {
  local ok=1

  if [ "$(uname -s)" != "Darwin" ]; then
    fail "iOS builds require macOS. Apple's toolchain does not run elsewhere."
  fi

  # Command Line Tools are not enough: xcodebuild, the simulators and the iOS
  # SDK all come from full Xcode.
  local dev_dir
  dev_dir="$(xcode-select -p 2>/dev/null || true)"
  if [ -z "$dev_dir" ] || [[ "$dev_dir" == *CommandLineTools* ]]; then
    # Distinguish "Xcode is absent" from "Xcode is present but not selected".
    # They look identical to xcode-select and have completely different fixes.
    if [ -d /Applications/Xcode.app ]; then
      echo "[ios] MISSING  Xcode is installed but not selected (active: ${dev_dir:-nothing})"
      echo "               sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
      echo "               sudo xcodebuild -license accept"
    else
      echo "[ios] MISSING  Xcode (active: ${dev_dir:-nothing})"
      echo "               Install it, then select it:"
      echo "                 xcodes install --latest        # or the App Store"
      echo "                 sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
      echo "                 sudo xcodebuild -license accept"
    fi
    ok=0
  else
    echo "[ios] ok       Xcode at $dev_dir"
  fi

  # x86_64-apple-ios is only for simulators on an Intel Mac. Requiring it on
  # Apple Silicon failed the check over a target the machine can never use.
  local required=(aarch64-apple-ios aarch64-apple-ios-sim)
  [ "$(uname -m)" = "x86_64" ] && required+=(x86_64-apple-ios)
  for t in "${required[@]}"; do
    if rustup target list --installed 2>/dev/null | grep -qx "$t"; then
      echo "[ios] ok       rust target $t"
    else
      echo "[ios] MISSING  rust target $t  ->  rustup target add $t"
      ok=0
    fi
  done

  # tauri ios init shells out to CocoaPods; without it the failure is a bare
  # "pod: command not found" from deep inside the generator.
  if command -v pod >/dev/null 2>&1; then
    echo "[ios] ok       CocoaPods $(pod --version 2>/dev/null)"
  else
    echo "[ios] MISSING  CocoaPods  ->  brew install cocoapods"
    ok=0
  fi

  if command -v xcrun >/dev/null 2>&1 && xcrun simctl list devices 2>/dev/null | grep -q "iPad"; then
    echo "[ios] ok       an iPad simulator is available"
  else
    echo "[ios] note     no iPad simulator  ->  xcodebuild -downloadPlatform iOS"
  fi

  # Signing is only needed for a physical device, so these are notes rather
  # than failures — the simulator runs unsigned.
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Develop"; then
    echo "[ios] ok       signing identity present"
    local teams; teams="$(discovered_teams | tr '\n' ' ')"
    if [ -n "${APPLE_DEVELOPMENT_TEAM:-}" ]; then
      echo "[ios] ok       APPLE_DEVELOPMENT_TEAM=$APPLE_DEVELOPMENT_TEAM"
    elif [ -n "$teams" ]; then
      echo "[ios] note     team not set. Found: $teams"
      echo "               add to .env.local:  APPLE_DEVELOPMENT_TEAM=<id>"
    else
      echo "[ios] note     a certificate exists but no team id could be read from it"
    fi
  else
    echo "[ios] note     no signing identity — the simulator runs, a physical iPad does not"
    echo "               Xcode > Settings > Accounts > + > Apple ID  (your password;"
    echo "               a free Apple ID gives a Personal Team, good for your own"
    echo "               devices with 7-day profiles). Then: pnpm ios:team"
  fi

  [ "$ok" -eq 1 ] || fail "prerequisites missing; see above"
  echo "[ios] ready"
}

case "$CMD" in
  check) check ;;
  team)
    # Run after adding an Apple ID in Xcode: reports the id to put in .env.local.
    teams="$(discovered_teams)"
    if [ -z "$teams" ]; then
      echo "[ios] no signing certificate yet." >&2
      echo "      Xcode > Settings > Accounts > + > Apple ID, then open" >&2
      echo "      src-tauri/gen/apple/bdobb.xcodeproj once so Xcode issues one." >&2
      exit 1
    fi
    echo "[ios] team id(s) found:"
    echo "$teams" | sed 's/^/        /'
    echo "[ios] add the one you want to .env.local:"
    echo "        APPLE_DEVELOPMENT_TEAM=$(echo "$teams" | head -1)"
    ;;
  init)
    check
    # Capabilities must exist before the Rust crate compiles, and the iOS
    # project generation compiles it.
    node scripts/generate-capabilities.mjs
    npx tauri ios init
    echo "[ios] generated src-tauri/gen/apple — commit it; it is the Xcode project"
    ;;
  dev)
    check
    node scripts/generate-capabilities.mjs
    # --host makes Vite listen on the LAN so a physical iPad can reach the dev
    # server; harmless for the simulator, which shares localhost.
    #
    # With no device named the CLI blocks on an interactive picker, which hangs
    # forever when stdin is not a terminal. Pass one:
    #   pnpm ios:dev "iPad Pro (11-inch) (4th generation)"
    # --host last, and its value omitted: it takes an OPTIONAL value, so with
    # the flag first the device name is swallowed as an IP address.
    #
    # Output is teed so a launch refusal can be recognised. The CLI reports it
    # by dumping the whole Rust command context, which buries the one line that
    # says what to do.
    out="$(mktemp -t bdobb-ios)"
    set +e
    npx tauri ios dev "$@" --host 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    set -e
    if grep -q "has not been explicitly trusted by the user" "$out"; then
      echo
      echo "[ios] The app INSTALLED but iOS refused to launch it."
      echo "      A free Personal Team is untrusted until you say otherwise, once per device:"
      echo "        iPad > Settings > General > VPN & Device Management"
      echo "        > Apple Development: <your Apple ID> > Trust"
      echo "      Then launch BDOBB from the home screen, or re-run this command."
      rm -f "$out"
      exit 1
    fi
    rm -f "$out"
    exit "$status"
    ;;
  build)
    check
    node scripts/generate-capabilities.mjs
    npx tauri ios build "$@"
    ;;
  *) fail "unknown command '$CMD' (check|team|init|dev|build)" ;;
esac
