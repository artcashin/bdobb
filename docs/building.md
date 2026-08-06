# Build paths

Four targets. The three desktop ones are production paths. iPadOS works with a
trackpad, mouse or Magic Keyboard, and by touch for the panels; the dashboard
grid is not yet touch-usable — see [iPadOS](#ipados).

The app also requires **iPadOS 16+**, set as `bundle.iOS.minimumSystemVersion`.
That is a WebKit floor rather than an arbitrary one: the clock's responsive row
uses a container query, and iPadOS ships WebKit with the OS, so it cannot be
polyfilled.

Every path runs `scripts/generate-capabilities.mjs` first, because Tauri
capabilities are compiled into the binary and must exist on disk before cargo
runs. The HTTP scope is open to any http(s) host — backends are a runtime
choice — so the script's real work is the fs scope below.

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
| iPadOS / iOS | `pnpm ios:build` | `.ipa` | Needs Xcode. **`ios:dev` is not installable** — see below |

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

## iPadOS

```bash
pnpm ios:check   # prerequisites, changes nothing
pnpm ios:init    # generate the Xcode project (once)
pnpm ios:dev "iPad Pro (11-inch) (4th generation)"   # iterate, hot reload
pnpm ios:build   # .ipa — this is what you install
```

### `ios:dev` and `ios:build` are not two ways of doing the same thing

**`ios:dev` leaves an app that only works while your Mac is serving it.** It
rewrites `devUrl` to the Mac's LAN address so the device can reach Vite:

```
Replacing devUrl host with 192.168.x.x
➜  Network: http://192.168.x.x:1420/
```

The app on the device then loads its entire frontend over the LAN, from your
Mac, for as long as the command runs. Stop the command — or leave the network —
and it stops working. The tailnet is not involved: the backend URL is fine, but
the *app itself* is coming from an IP address. Use it for iterating with hot
reload, and for nothing else.

**`ios:build` produces a self-contained app.** The frontend is embedded in the
binary, and the only network dependency is whatever backends are configured.
Install it with:

```bash
xcrun devicectl device install app --device <udid> src-tauri/gen/apple/build/arm64/BDOBB.ipa
```

`xcrun devicectl list devices` gives the udid.

To confirm a build really is self-contained, unpack the `.ipa` and check the
binary — the frontend is compiled into it rather than sitting in `assets/`:

```bash
unzip -q BDOBB.ipa -d /tmp/ipa
strings -a /tmp/ipa/Payload/BDOBB.app/BDOBB | grep -c "<!doctype html>"   # 1 = embedded
strings -a /tmp/ipa/Payload/BDOBB.app/BDOBB | grep -c "192.168"           # 0 = no dev server
```

**Name the device** for either command. With none, the CLI blocks on an
interactive picker, which hangs forever when stdin is not a terminal.
`xcrun simctl list devices available` lists simulator names;
`xcrun devicectl list devices` lists hardware. The device is positional and must
come before `--host`, which the script appends last — `--host` takes an
*optional* value, so with the flag first the device name is swallowed as an IP
address.

### Storage is separate from the desktop app

`$APPDATA` on iOS is the app's own sandbox, so backends, dashboards, settings
and chat history are independent of the macOS build's. They survive reinstalls,
and **persisted config beats `.env.local`** — the environment only seeds a fresh
install. A backend saved during an earlier run keeps its old URL through any
number of rebuilds; change it in the app's Backends dialog.

Verified on an iPad Pro simulator (iPadOS 17) and on an iPad Pro 11-inch (M5)
running iPadOS 26, Xcode 26.6: builds, installs, launches, the rail and Rita
pane open on tap and dismiss on an outside tap, and the chat history persists
and reloads.

### The toolchain part

`pnpm ios:check` reports what is missing and how to fix each item:

- **Full Xcode.** Command Line Tools are not enough — `xcodebuild`, the
  simulators and the iOS SDK all come from Xcode proper. The check distinguishes
  "not installed" from "installed but not selected", which look identical to
  `xcode-select` and have completely different fixes:
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- **Simulator runtime** — `xcodebuild -downloadPlatform iOS`. Several GB, and
  the only slow step.
- **CocoaPods**, which `tauri ios init` shells out to.
- Rust targets `aarch64-apple-ios` and `aarch64-apple-ios-sim`.
  `x86_64-apple-ios` is required only on an Intel Mac, and the check no longer
  demands it on Apple Silicon.
- A signing identity is needed for a **physical iPad**. The simulator runs
  without one — see *Signing for a device* below.

`src-tauri/gen/apple/` is the generated Xcode project. It is **gitignored**;
run `pnpm ios:init` after cloning.

Tauri's guidance is to commit it, and that would be right but for one thing:
Xcode writes `DEVELOPMENT_TEAM` into `project.pbxproj` the moment a signing
team is selected, which puts an Apple account identifier into the repository.
Everything under `gen/apple` is produced from `tauri.conf.json` plus
`APPLE_DEVELOPMENT_TEAM`, so regenerating is lossless today. If anything there
ever needs hand-editing — a custom `Info.plist` key, an extra capability — that
trade has to be revisited, most likely by committing it with the team stripped.

### Signing for a device

The simulator runs unsigned. A physical iPad does not, and there are two tiers:

| | Free Apple ID | Apple Developer Program |
|---|---|---|
| Cost | none | $99/year |
| Install on your own devices | yes | yes |
| Profile lifetime | **7 days**, then the app stops launching | 1 year |
| Apps per device | 3 | unlimited |
| TestFlight / App Store | no | yes |

**For running BDOBB on your own iPad the free tier is enough.** The seven-day
expiry is the real cost: the app stops launching after a week and has to be
rebuilt from Xcode. Tauri's own docs only describe the paid programme, because
they are written for distribution rather than personal use.

Setup, once:

1. **Xcode → Settings → Accounts → + → Apple ID.** This needs your password, so
   it is the one step that cannot be scripted. A plain Apple ID is enough; Xcode
   creates a "Personal Team" from it.
2. Open `src-tauri/gen/apple/bdobb.xcodeproj` once and select the target, so
   Xcode issues a development certificate.
3. `pnpm ios:team` — reads the team id out of that certificate.
4. Put it in `.env.local` as `APPLE_DEVELOPMENT_TEAM=...`.

The team id identifies your developer account, so it goes in `.env.local`
(gitignored) rather than in the committed `tauri.conf.json`, the same rule the
HTTP endpoints follow. `scripts/ios.sh` reads it from there and exports it;
Tauri's config field is `bundle.iOS.developmentTeam`, and
`APPLE_DEVELOPMENT_TEAM` overrides it.

Then plug the iPad in and name it:

```bash
pnpm ios:dev "Art's iPad"
```

`xcrun devicectl list devices` shows connected hardware.

Three device-side gates, each of which reports as something else:

- **Developer Mode** must be on: iPad → Settings → Privacy & Security →
  Developer Mode. The toggle only appears after a Mac has attempted a
  development connection, and enabling it reboots the device. Until it is on,
  `xcodebuild` fails with "Timed out waiting for all destinations", not with
  anything about developer mode.
- **The device must be registered to the team** before Apple will mint a
  profile. That happens automatically once Developer Mode is on — attempting it
  earlier gives "Your team has no devices from which to generate a provisioning
  profile", which reads like an account problem and is not.
- **The developer must be trusted**, once per device: Settings → General → VPN &
  Device Management → your Apple ID → Trust. Until then the app installs
  successfully and refuses to launch. The CLI reports this by dumping its entire
  Rust command context; `scripts/ios.sh` recognises it and prints the remedy.

Verified end to end on an iPad Pro 11-inch (M5), iPadOS 26, free Personal Team:
signed `debug-iphoneos` build, installed, launched.

### Which input works

**With a trackpad, mouse or Magic Keyboard: everything works.** iPadOS delivers
real pointer events for those, so the hover panels — the left rail and the chat
pane — behave exactly as they do on a desktop. That is the supported paradigm
today, and the iPad-specific work is done: safe-area insets so nothing sits
under the home indicator, overscroll suppressed so the app does not rubber-band
off its own background, text-size-adjust pinned so a rotation does not reflow
the layout, and the selection callout disabled on chrome (but *not* on cards or
chat, where selecting a figure to copy it is the point).

**By touch, the panels work.** Tap the rail or the collapsed Rita strip to
expand it; tap anywhere outside to dismiss. `usePointerKind` reads
`(pointer: fine)` reactively — a Magic Keyboard can be docked or removed
mid-session and the same iPad changes paradigm when it happens — and the touch
handlers are only armed when the pointer is coarse, so a mouse still uses hover
alone. The design rationale is in
[the spec](superpowers/specs/2026-07-30-openbb-desk-design.md#input-paradigms).

**The dashboard grid is not touch-usable yet.** react-grid-layout's drag
competes with scrolling, so cards need an explicit drag handle before a
dashboard can be rearranged by finger.

Zoom is deliberately left enabled. `user-scalable=no` would stop accidental
pinches, but this is a data-dense UI and pinching to read a table is a
legitimate thing to want.

## What is not signed

Nothing. Every artifact is unsigned, which is fine for a private tailnet tool
installed by the person who built it and not fine for wider distribution. The
three separate mechanisms — Apple notarisation, Windows Authenticode, Linux
repository signing — are independent of each other and of everything above.
