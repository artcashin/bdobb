# Symphony

BDOBB talks to [Symphony Messaging](https://symphony.com) two ways: a chat
card you read and reply to **as yourself**, and a "Send to Symphony" action
that posts widget content **as a bot**, including messages Rita composes.
These are deliberately separate trust paths — see
[the design spec](superpowers/specs/2026-08-03-symphony-widget-design.md) if
you want the full rationale. This page is the practical side: getting a pod
to test against, finding a stream ID, filling in Settings, and what each
piece actually does today.

## Before you start: what you need from Symphony

Symphony's Embedded Mode (the chat card) requires a **partner ID**, and
there's no self-service path to one — per Symphony's own docs, it's issued
"following the conclusion of the Embedded Mode contract." That's a licensing
conversation with Symphony, not something this doc can hand you. What *is*
self-service is a free developer sandbox, and it's enough to build and test
against:

1. Register at the [Symphony Developer Center](https://developers.symphony.com)
   (free — bundled with Symphony's Developer Certification program). This
   grants access to the **Developer Sandbox pod at `develop2.symphony.com`**,
   where you can create your own service account without a pod
   administrator.
2. The certification courses (BDK for Java/Python, WDK) are free and worth
   taking before standing up the bridge — the BDK is what the bridge should
   be built on (design spec §5.3).
3. **The design spec flags one unresolved question honestly: it's unconfirmed
   whether Embedded Mode (and a partner ID) is available on the sandbox pod
   at all.** Symphony's sandbox docs confirm bot support but are silent on
   ECP. If it isn't, the sandbox still unblocks everything on the bot/bridge
   side (Rita's tool, Send to Symphony) — only the live chat card needs the
   partner ID and a licensed pod.
4. To create the bot's service account: on the sandbox this is self-service;
   on a corporate pod, a pod administrator does it in the Admin Portal
   (`https://{pod}.symphony.com/?admin` → Service Account tab → username
   matching the bot config, RSA public key pasted into Authentication, roles
   granted). The BDK's generator (`yo @finos/symphony`) produces the keypair.
   The private key belongs in the `symphony-bridge` container, never on your
   desktop — see
   [`deploy/symphony-bridge/README.md`](../deploy/symphony-bridge/README.md).

## Finding a stream ID

BDOBB's Symphony card and the "Send to Symphony" action both need a
**stream ID** — the identifier for a specific room or 1:1 conversation. v1 of
this integration has no in-app picker; you find the ID in a Symphony client
you're already signed into and paste it into BDOBB. In the Symphony desktop
or web client, open the conversation, then use its **conversation
details / room info panel**, where the stream ID is expected to be listed
(Symphony also
exposes it via the Pod API for scripting, if you'd rather query it than
click through the UI). If you can't find it, the [Symphony REST API
reference](https://rest-api.symphony.com/) documents the stream/room lookup
endpoints the Pod API exposes.

A future version of this integration may add a picker backed by the bridge's
`GET /conversations` endpoint (per the design spec), but that endpoint's own
contract is unverified today — see the bridge README's open item — so for
now, paste the ID by hand.

## Settings → Symphony

Three fields, all in Settings → Symphony:

| Field | Setting key | What it's for |
|---|---|---|
| **Pod URL** | `symphonyPodUrl` | Default pod host for Symphony cards, e.g. `https://my-pod.symphony.com` or `https://develop2.symphony.com`. Used when a card doesn't set its own Pod URL parameter. Unlike a card's own Pod URL parameter (below), **this Settings field requires a scheme**: Settings validates it with the same http(s)-URL check as the Rita/Bridge fields, so a bare host is rejected on Save with "Please enter a valid HTTP/HTTPS URL for the Symphony pod." A trailing slash is fine either way — BDOBB strips that (and, for a card's own parameter, the scheme too) before building the embed URL. |
| **Partner ID** | `symphonyPartnerId` | Sent as the `partnerId` query parameter on every Symphony embed. This is the value from the licensing step above — required for the chat card to load at all; a blank value is still sent as an empty `partnerId` parameter, and it's reasonable to expect Symphony to reject that, though this hasn't been confirmed against a real pod. |
| **Bridge URL** | `symphonyBridgeUrl` | The `symphony-bridge` container's HTTP base, e.g. `http://<bridge-host>:<port>`. This is **not** the same thing as the bridge's MCP endpoint (see below) — do not put `/mcp` here. |

The **Bridge URL** field is separate from Rita's tools. Rita's
`post_to_symphony` tool comes from the bridge's own MCP endpoint, added
separately under **Settings → MCP** as an MCP server URL (typically
`<bridge base>/mcp`). If you want the confirmation gate
(below) to reliably catch every message the bridge tries to post — even a
bridge tool that isn't literally named `post_to_symphony` — point the Bridge
URL and the MCP server URL at the **same origin** (scheme, host, and port).
If they differ, a same-container tool whose name doesn't contain "symphony"
can post without triggering the confirmation dialog. Full detail on why is in
[the bridge README](../deploy/symphony-bridge/README.md#two-different-urls--do-not-confuse-them).

## Adding a Symphony card to a dashboard

The Symphony card lives in the widget library under **Built-in**, alongside
Note, Clock, and Website. Add it to a dashboard like any other card, then set
its two card-level parameters:

- **Pod URL** — leave blank to use the Settings default, or override per
  card if you have conversations on more than one pod.
- **Stream ID** — the conversation to open (see above).

Mode (`focus`) and Theme (`dark`) have sensible defaults and rarely need
changing.

The card doesn't load anything until it actually scrolls into view — Symphony's
embed opens a live connection the moment it loads, so a dashboard with many
cards doesn't pay for the ones you never scroll to. The first time you open a
conversation you'll need to log into Symphony inside the card (SSO) exactly
as you would in the Symphony desktop app.

**If the card shows "This pod refuses to be embedded" instead of a chat**,
that's a real signal, not a bug to work around: BDOBB checks the pod's
response headers before rendering the iframe, and a pod (or a proxy/CDN in
front of it) sending `X-Frame-Options: DENY`/`SAMEORIGIN` or a restrictive
CSP `frame-ancestors` will produce exactly this screen, with an
*Open externally* button as the fallback. This is the same header-preflight
pattern the Website widget uses, applied to Symphony pods. If the card is
just blank instead — no refusal message — the preflight itself likely
couldn't complete (pod down, DNS failure, blocked network path); it renders
the iframe optimistically in that case, with a lighter "Blank? The pod may
refuse to be embedded" hint instead of the hard refusal screen.

## "Send to Symphony" on Note, Table, and Chart widgets

Any Note card, or any registry widget of type `markdown`, `table`, or
`chart`, gets a 📤 icon button in its header — labeled "Send to Symphony"
only in its tooltip/`aria-label`, not with visible text — but only once a
Bridge URL is configured in Settings. Clicking it:

1. Prompts you for the destination stream ID (there's no saved-destination
   list yet — every send asks).
2. Converts the card's content:
   - **Note / markdown** → the markdown is converted to Symphony's MessageML
     format. Bold/italic, inline code, links, and lists become real MessageML
     markup; headings are not — a `#` heading becomes bold text followed by a
     line break (`<b>…</b><br/>`), not a MessageML heading element. Anything
     else passes through as plain escaped text.
   - **Table** → the widget's rows become a CSV attachment, honoring the
     widget's declared column order and header labels where available.
     Hidden columns (`hide: true` in the column definition) are dropped from
     the export — only the columns currently visible in the widget go out.
     As a formula-injection guard, any cell whose value starts with `=`,
     `+`, `-`, or `@` and isn't a plain numeric literal gets a leading
     apostrophe added (e.g. `=SUM(A1:A2)` becomes `'=SUM(A1:A2)`) so
     spreadsheet apps don't evaluate it as a formula when the recipient opens
     the file.
   - **Chart** → the widget's chart is rendered to a PNG attachment via
     Plotly's headless image export.
3. Posts it to the bridge, which is expected to relay it into the Symphony
   room as the bot, with an attribution line ("📤 *{user} via BDOBB*" per the
   design spec) so it's clear the message came through BDOBB rather than
   from the bot arbitrarily.

**Chart PNG export is implemented but not verified end-to-end in a real
desktop build.** The rendering code path (`defaultRenderChartPng` in
`src/lib/symphonyPayload.ts`) calls Plotly's `toImage`, but the automated
test suite can't exercise the real rasterizer — headless Chromium/canvas
support isn't present in the jsdom test environment this repo uses, so tests
inject a fake image function instead. The logic is real and type-checked,
but nobody has confirmed a chart card actually produces a correct PNG inside
a running Tauri build. Try it once your bridge is up before relying on it.

**The bridge's exact response contract is also unverified** — BDOBB sends a
well-defined request (documented in
[the bridge README](../deploy/symphony-bridge/README.md#open-item-the-http-contract-is-unverified))
but only checks that the HTTP status is 2xx; it doesn't parse the response
body at all. A bridge that returns `200 OK` with a silently-dropped message
would look identical, from BDOBB's side, to a successful send. Confirm in the
actual Symphony room, not just the "Send to Symphony" status line.

## Rita and the confirmation dialog

If Rita has the bridge's MCP tools available (Settings → MCP), she can call
`post_to_symphony` to compose and post a message on your behalf. **Every such
call stops for your approval first**, and nothing goes to Symphony until you
approve. Declining tells Rita the message was not sent so she can react
accordingly, rather than silently failing. There are two variants of the
dialog, depending on how confident BDOBB is about what's being sent:

- **Confirmed `post_to_symphony` call** — title "Review and Send", button
  "Send" (or "Decline"). The dialog does its best to show the actual
  destination and message text by reading common field names out of the tool
  call's arguments (`streamId`, `destination`, `room`, etc. for the
  destination; `message`, `text`, `content`, `body` for the body) — because
  `post_to_symphony`'s exact argument shape is defined by the bridge, not by
  BDOBB, and isn't fixed by this repo. If none of those field names match
  what your bridge's tool actually uses, the dialog falls back to showing the
  raw JSON arguments rather than guessing.
- **Any other tool call that looks like a Symphony post** — either its name
  contains "symphony" in any case, or it comes from an MCP server whose URL
  shares an origin with your configured Bridge URL (see the Settings section
  above for why that origin match matters). Title "Review and Confirm",
  button "Approve" (or "Decline"). BDOBB only knows the tool name and server
  here, so the dialog says "Rita wants to run `<tool>` on `<server>`" instead
  of claiming to know a destination or message it couldn't confidently parse.

## Known limits, as of this writing

- No conversation picker — stream IDs are pasted by hand everywhere they're
  needed.
- No saved "recent destinations" for the Send to Symphony prompt.
- Chart PNG export is implemented but not verified against a real Tauri
  build (see above).
- The bridge's HTTP and MCP contracts are both implemented against the
  design spec's sketch, not against a real, running bridge — see
  [`deploy/symphony-bridge/README.md`](../deploy/symphony-bridge/README.md)
  for the exact shapes BDOBB sends and what to reconcile before relying on
  either.
- Data-driven alerts (a rule on widget data auto-posting to a room) are
  future work, not built.
