# symphony-bridge

The bot-identity half of BDOBB's Symphony integration. Runs as a Docker
container on the tailnet, holds the bot's RSA private key, and is the only
thing that ever authenticates to Symphony as the bot. The desktop app never
sees the key and never calls Symphony directly for bot traffic — see
[the design spec, §5.3](../../docs/superpowers/specs/2026-08-03-symphony-widget-design.md#53-the-symphony-bridge-container)
and [§6.1](../../docs/superpowers/specs/2026-08-03-symphony-widget-design.md#61-security).

**Status: this runbook describes the target deployment. The bridge's own
implementation (`symphony-bridge` repo: service + Dockerfile + compose file)
is out of scope of the BDOBB repository and, as of this writing, has not been
built.** Nothing below has been run against a real bridge. Treat every
env var, endpoint, and payload shape here as the *intended* contract, derived
from the design spec and from what BDOBB's own code sends — not as something
a working deployment has confirmed. This mirrors `deploy/spark/README.md`'s
posture (Docker, `--restart unless-stopped`, host networking on the tailnet,
env file mode 600, pinned commit recorded once deployed) but that README
documents a service that has actually been stood up; this one does not yet.

## Open item: the HTTP contract is unverified

`shareWidgetToSymphony` in
[`src/lib/chatShare.ts`](../../src/lib/chatShare.ts) is BDOBB's only caller of
the bridge's messaging endpoint, and its request shape was written by the
implementer against the design spec's one-line sketch (F2-3: "`POST
/messages` (streamId + MessageML/markdown + optional attachment)") — **no
real bridge service has ever validated this shape.** Before wiring a real
bridge behind `settings.symphonyBridgeUrl`, reconcile the bridge's actual
`POST /messages` handler against exactly what BDOBB sends:

```
POST {bridgeUrl}/messages
Content-Type: application/json
```

Three body shapes, one per widget kind (`kind` itself is not sent — the
bridge must infer from which fields are present):

```jsonc
// note (markdown → MessageML, no attachment)
{ "streamId": "...", "messageML": "<messageML>...</messageML>" }

// table (CSV attachment, caption as messageML)
{
  "streamId": "...",
  "messageML": "<messageML>...</messageML>",
  "attachment": { "filename": "widget-title.csv", "contentType": "text/csv", "data": "<base64>" }
}

// chart (PNG attachment, caption as messageML)
{
  "streamId": "...",
  "messageML": "<messageML>...</messageML>",
  "attachment": { "filename": "widget-title.png", "contentType": "image/png", "data": "<base64>" }
}
```

`messageML` is always a full `<messageML>...</messageML>` document (see
[`markdownToMessageML`](../../src/lib/symphonyPayload.ts)), never bare text.
`attachment.data` is base64, unencoded (no `data:` URI prefix). A non-2xx
response body is read as text and surfaced to the user verbatim (truncated to
200 chars); a 2xx response body is not parsed at all — `shareWidgetToSymphony`
only checks `res.ok`. If the real bridge expects a different field name (e.g.
`text` instead of `messageML`, or attachments as multipart instead of inline
base64 JSON), BDOBB's widget-sharing button will fail every send until either
side changes. There is no version negotiation.

Rita's `post_to_symphony` MCP tool is a **separate, independent contract**:
it is defined and served by the bridge itself (via its `/mcp` endpoint), not
by BDOBB, so its argument names aren't fixed by this repo either. BDOBB's
confirmation dialog ([`ChatPane.tsx`](../../src/components/chat/ChatPane.tsx))
best-effort-reads a destination from any of `streamId`, `destination`,
`stream_id`, `room`, `roomId` and a message from any of `message`, `text`,
`content`, `body` — whatever the real tool's schema uses should include at
least one of each so the "Review and Send" dialog can show the user something
concrete instead of a raw JSON dump.

## Two different URLs — do not confuse them

BDOBB talks to the bridge over two unrelated paths, configured in two
different places:

| | Configured in | Used for | Typical shape |
|---|---|---|---|
| **Bridge URL** | Settings → Symphony tab → *Bridge URL* (`settings.symphonyBridgeUrl`) | Widget "Send to Symphony" button — `shareWidgetToSymphony` POSTs to `{bridgeUrl}/messages` | `http://<bridge-host>:<port>` |
| **MCP endpoint** | Settings → MCP tab, added as an MCP server URL | Rita's tools, including `post_to_symphony` | `http://<bridge-host>:<port>/mcp` |

These are the **same container, two different routes on it** — not two
services. Putting `.../mcp` in the *Bridge URL* field breaks widget sharing
(`shareWidgetToSymphony` would POST to `.../mcp/messages`, which doesn't
exist); putting the bare base in the MCP tab gives Rita no tools. Follow the
`/mcp` (not `/mcp/`) path convention and watch for the 307-redirect gotcha
already documented for other MCP servers in this app (design spec §4.3,
F2-8).

**These two must also share an origin**, for a reason that isn't obvious from
either settings tab: the confirmation gate in `ChatPane.tsx` decides whether
a tool call needs human approval using two OR'd checks —
`isSymphonyPostTool` (does the tool name match `/symphony/i`?) and
`isFromSymphonyBridge` (does the MCP server's URL share an *origin* with
`settings.symphonyBridgeUrl`?). The second check exists specifically to catch
a bridge tool that doesn't have "symphony" in its name (e.g. one literally
called `send_message`) — but only if the MCP server you added in the MCP tab
resolves to the same scheme+host+port as the Bridge URL setting. If the
bridge is reachable at two different hostnames (e.g. `localhost` in one tab,
a tailnet FQDN in the other), a same-container, differently-named tool can
post to Symphony with **no confirmation dialog at all**. Configure both
fields against the same origin.

## Environment variables

Per the design spec §5.3, the bridge is configured entirely by env vars plus
a mounted key file — no hardcoded pod/bot identity in the image:

| Variable | Purpose |
|---|---|
| `SYMPHONY_POD_HOST` | The firm's Symphony pod hostname (Pod API), e.g. `my-pod.symphony.com`. |
| `SYMPHONY_AGENT_HOST` | The Agent API hostname the bridge sends/receives messages through. |
| `SYMPHONY_BOT_USERNAME` | The bot's service-account username, exactly matching the account created on the pod (§4.0, P0-3). |
| `SYMPHONY_BOT_KEY_PATH` | Path *inside the container* to the bot's RSA private key. Mount the key as a file (Docker secret or bind mount); never bake it into the image. |
| `BRIDGE_BIND` | Interface/port the bridge's HTTP API listens on. Bind the tailnet interface only — the design's network posture is reachability-as-auth, not open internet exposure. |
| `BRIDGE_ALLOWED_DESTINATIONS` *(optional)* | Allowlist of stream IDs the bridge will post to — a blast-radius limiter so a compromised or buggy client can't post everywhere the bot has access. |
| `BRIDGE_ALLOWED_HOSTS` *(optional)* | Comma-separated `Host` header values the bridge will accept, on every route (not just `/mcp`) — DNS-rebinding protection. Defaults to loopback plus whatever `BRIDGE_BIND` resolves to, so a bridge bound to a specific tailnet hostname or IP needs no extra config. If `BRIDGE_BIND` is `0.0.0.0` (listen on all interfaces), the default has no real tailnet hostname to add — set this explicitly to your tailnet FQDN (e.g. `bridge.your-tailnet.ts.net:*`) in that case, or every request will 421. |

None of these are BDOBB env vars — they belong to the bridge's own process.
BDOBB only needs `settings.symphonyBridgeUrl` (Symphony settings tab) and,
separately, the bridge's MCP server URL (MCP tab) as described above.

## Security posture (non-negotiable, per the design spec)

- The bot's **RSA private key exists only in the bridge container**, never on
  the desktop, never in `$APPDATA`, never in this repo. (§6.1)
- **All bot-identity Symphony traffic egresses from the bridge container.**
  The desktop's only direct Symphony traffic is the user's own ECP iframe
  session to the pod (chat card) — see `docs/symphony.md` — which is a
  completely separate trust path from the bridge.
- Every send should be logged (who asked, destination, content hash, result)
  for audit, per §5.3. The bridge's own implementation owns this; nothing in
  BDOBB verifies that logging happens.
- v1 has **no request auth beyond tailnet reachability** — anyone who can
  reach `BRIDGE_BIND` can post as the bot. This is consistent with BDOBB's
  existing tailnet-trust posture (matches `deploy/spark/`) but does not scale
  to a shared tailnet with untrusted users (§10, open question 3). Revisit
  before adding a second tailnet user.

## Deployment posture

Follow `deploy/spark/README.md`'s pattern once the bridge image exists:

- `docker run -d --name symphony-bridge --restart unless-stopped ...`
- Host networking (or explicit port publishing bound to the tailnet
  interface) — whichever the bridge's own repo documents.
- Env file mode `600`, never committed, holding the five required vars above.
- The RSA key mounted read-only, mode `600`.
- Record the pinned commit/image tag actually deployed, in this file, once
  there is one.

## Framing preflight (chat card, not this container)

Not this container's concern operationally, but an operator debugging "why
does the Symphony card show a refusal panel instead of a chat" should know:
BDOBB's `SymphonyRenderer` calls a Rust command, `check_frame_options`
(`src-tauri/src/lib.rs`), before rendering the pod's ECP iframe. It issues a
HEAD request against the embed URL and, if that doesn't come back with a
success status (some servers don't implement HEAD), falls back to a full GET
— so it is not HEAD-only. It follows up to 5 redirects, since a site's
framing policy can differ per hop and the one that matters is wherever the
frame finally lands, and it presents a Safari user agent, since some sites
serve a different policy to unknown/non-browser clients. It then inspects
`X-Frame-Options` (`DENY` or `SAMEORIGIN` both refuse) and, if present, the
CSP `frame-ancestors` directive (anything other than a wildcard or bare
scheme token counts as a refusal). If either header blocks framing, the card
shows "This pod refuses to be embedded" with an *Open externally* button
instead of the chat — **this is a pod-side header, not a bridge or BDOBB
bug.** Check the pod's response headers directly if a card that used to work
suddenly shows the refusal panel; a pod-side proxy or CDN change ahead of
`{pod}.symphony.com` is a plausible cause. Note that `curl -sI
https://{pod}/embed/index.html` only sends HEAD and doesn't follow redirects
or spoof a Safari user agent by default, so it can disagree with what the app
actually saw — add `-L -A "<Safari UA>"` and be ready to retry without `-I`
if the pod doesn't implement HEAD, to reproduce the app's check more closely.
A preflight that errors outright (pod down, DNS failure, blocked request) is
treated differently — the iframe still renders optimistically, with a
lighter "Blank? The pod may refuse to be embedded" footer instead of the
hard refusal panel, since a failed check isn't proof of refusal.

## Smoke tests (once a bridge is deployed)

None of these have been run — write them against whatever the bridge's own
`/health`, `/conversations`, `/messages`, and `/mcp` actually return once it
exists (design spec F2-3 sketches the endpoint list; treat it as a starting
point, not a confirmed API):

```bash
curl -s http://<bridge-host>:<port>/health
curl -s http://<bridge-host>:<port>/conversations | jq .
curl -s http://<bridge-host>:<port>/mcp   # Rita's tool source; expect a 307 without a trailing slash, per the F2-8 gotcha
curl -s -X POST http://<bridge-host>:<port>/messages \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"<a real stream id>","messageML":"<messageML>smoke test<br/></messageML>"}'
```

Then, from BDOBB: set both Settings → Symphony → Bridge URL and Settings →
MCP → (add server) to the same origin as above, open a Note card, click "Send
to Symphony", and confirm the message actually lands in the target Symphony
room — not just that BDOBB reports `HTTP 200` (`shareWidgetToSymphony` never
parses the response body, so a bridge that returns 200 with a swallowed error
would look identical to success from BDOBB's side).
