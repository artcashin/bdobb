# Provider API Keys — native `keys` widget

**Date:** 2026-08-06 · **Status:** Approved (Art, 2026-08-06)

Spans two repos: **bdobb** (the widget) and **openbb-docker/key-maint** (the
service). Neither half is useful without the other.

## Goal

The Provider API Keys panel is a plain `table` widget: `Status` and `Demo` are
separate text columns, there is no indication of whether a provider's own API
is reachable, and editing has never been implemented (`PUT /keys/{env_var}`
returns 501). Replace the panel with a native widget that says, at a glance,
*do I have a key* and *is the vendor answering* — and let a permissioned user
fix a key without leaving the app.

## Decisions taken (and rejected alternatives)

- **Native BDOBB renderer**, not server-rendered HTML and not an iframe.
  Sorting and column resizing come from `@tanstack/react-table` inside
  `TableRenderer` (`columnResizeMode: "onChange"`, `getSortedRowModel()`);
  a framed page would have to reimplement both. Native React also makes the
  right-click menu trivial and lets edits reuse the app's existing
  authenticated request path.
- **A `srcdoc` HTML widget was rejected**: the app's CSP is `script-src 'self'`
  and a `srcdoc` frame inherits its parent's policy, so inline JS almost
  certainly cannot run — no context menu. The frame is also sandboxed without
  `allow-same-origin`, giving it an opaque origin that carries no credentials,
  so writes would have needed a bespoke token scheme.
- **No Rita context, no raw view** (Art's call — secrets). This is deliberate
  and enforced, not incidental.

## Server side — `openbb-docker/key-maint`

### 1. Probe outcome gains a red/amber split

`probes.py::_probe_one` currently collapses two different things into
`result: "error"` — a transport failure and an HTTP error response. The dot
needs them apart:

| Situation | New `result` | Dot |
|---|---|---|
| `httpx.HTTPError` (timeout, refused, DNS) — no answer at all | `no_response` | **red** |
| Any HTTP error status, including 401/403 | `error` / `auth_failed` | **amber** |
| 2xx | `ok` | **green** |
| No probe defined, or key not set | `skipped` | grey |

`auth_failed` stays a distinct result (the UI shows it differently in the
detail text) but is amber, because the vendor did answer.

**Known gap, accepted:** a 2xx whose body matches an `invalid_markers` string
means the vendor is healthy but the key is bad. The dot is green (the server
is fine) and the pill is green (a key is configured), yet the key does not
work. Neither indicator's vocabulary covers this, so it is surfaced in the
row's detail text only. Revisit if it bites.

Detail strings keep the existing rule: built **only** from status codes and
exception class names, never from URLs, bodies, or key material.

### 2. Single-provider probe

New `GET /keys/{env_var}/test`, tier ≥ 2, runs `_probe_one` for one provider
and returns `{result, detail}`. Backs the right-click "Test this service"
item without re-probing all ~18 vendors.

### 3. Write path

`PUT /keys/{env_var}`, **tier 3 only** (`role="admin"`; the existing TODO in
`server.py` already anticipates this). Request body `{"value": "..."}` —
never a query parameter, so the secret cannot reach uvicorn's access log,
Tailscale Serve's log, or any proxy log.

Three specific leak guards, each a real mechanism rather than a precaution:

1. **No Pydantic validation of the value's shape.** FastAPI's 422 responses
   echo the offending input; a model that rejects the value would print it.
   Accept any string and validate in the handler, returning a plain message.
2. **No echo.** The response reports success and the resulting `status`
   (`set`/`empty`), never the value.
3. **No traceback exposure.** The handler wraps the write so an exception
   cannot surface a frame holding the value; log the exception type only.

`env_var` is validated against `PROVIDERS`/`IGNORE` plus the
`_CRED_SUFFIXES` rule before any write, so the endpoint cannot be used to
write arbitrary keys into the file.

### 4. Credential file writes

`credfile.py` gains a writer that updates one variable in place, preserving
comment lines, ordering, and unrelated entries, and writes atomically
(temp file + `os.replace`) so a crash cannot truncate `credentials.env`.

### 5. Restart honesty

The running `openbb-api` process **cannot see the change**: OpenBB fills
`Credentials` from `os.environ` (`credentials.py:142`), a container's environ
is frozen at process start, and `UserService` is a `SingletonMeta` read once
per process. There is no settings endpoint — all 278 paths of the live
OpenAPI spec were checked.

So a successful write returns `{"restart_required": true}` and the widget says
so plainly. key-maint does **not** restart the API itself (that would hand one
service control of its neighbour). Bouncing just `openbb-api` takes seconds
and touches nothing else in the stack. An in-process admin endpoint in a
custom OpenBB extension is the only true no-restart route and is explicitly
out of scope here.

### 6. Widget declaration — additive, not a replacement

key-maint keeps serving the existing `provider_api_keys` widget as
`type: "table"`, because it also serves OpenBB Workspace (CORS allows
`pro.openbb.co`), which does not know a `keys` type. It **adds** a second
widget, `provider_api_keys_panel`, `type: "keys"`, same `/keys` endpoint.
BDOBB users add the panel; Workspace keeps the table.

## Client side — `bdobb`

### Renderer

New `src/components/renderers/KeysRenderer.tsx`, dispatched from
`WidgetCard.tsx` by `widget.type === "keys"` (the dispatch is a chain of
`if (widget.type === …)` around line 295). It builds on the same
`useReactTable` setup as `TableRenderer` — sorting and `columnResizeMode:
"onChange"` behave identically to every other table in the app.

Columns: **status dot**, **provider**, **key pill**, **detail**.

- **Dot** (left of the provider name) from the probe result, per the table
  above. Grey when no probe has run — including for tier‑1 users, who cannot
  probe at all.
- **Pill** replaces today's separate `Status` and `Demo` columns:

  | Condition | Pill | Colour |
  |---|---|---|
  | `status: "set"` and `demo: false` | `Own key` | green `#4caf7d` |
  | `status: "set"` and `demo: true` | `Demo key` | amber `#d9a75f` |
  | `status: "empty"` or `"missing"` | `Not set` | red `#d9695f` |
  | `status: "unknown"` | `Unknown` | neutral |

  Colours reuse values already in the stylesheet: the provider-badge green
  `#4caf7d` and red `#d9695f`, and the amber `#d9a75f` that
  `.backend-form-warn` already uses — with dark text `#0e1116` for contrast.
  The status dot uses the same three. Meaning is never carried by colour
  alone: the pill's own text states it, and the dot carries an accessible
  label naming the server state, satisfying the same bar the provider badges
  had to meet.

### Probing cadence

Probe **once on first render**, then only on an explicit **Refresh** control
(Art's call — a dashboard open must not spray ~18 vendor API calls). The
first load issues `GET /keys?run_tests=true`; Refresh repeats it. Results are
held in renderer state for the card's lifetime.

### Right-click menu

A context menu on a row offers **Test this service**, calling
`GET /keys/{env_var}/test` and updating that one row's dot and detail. It is
a real menu (Escape closes, click-outside dismisses, arrow keys move,
keyboard-invocable via the context-menu key), not a bare `onContextMenu`
handler.

### Editing

Rows become editable only when the `/keys` response reports `tier: 3`. An
edit control per row reveals an input; submitting sends
`PUT /keys/{env_var}` with `{"value": …}` through the app's existing
`dataClient` path so key-maint's Basic auth header is attached. On success
the row refreshes from the server and, when `restart_required` is set, the
card shows a persistent notice naming the container to bounce.

The value is never written to the app log, never placed in a URL, and never
put in a component key or `title` attribute.

### Deliberate exclusions

- **Raw view.** `WidgetCard` returns `RawJsonView` for `card.view === "raw"`
  *before* type dispatch, so the raw option must be suppressed for `keys`
  widgets rather than merely unused — otherwise the raw view is a one-click
  path to every value the tier exposes.
- **Rita context.** `ChatPane` sends `contextSharing ? widgetRefs : []`;
  `keys` widgets are filtered out of `widgetRefs` unconditionally, so even
  with context sharing on, key state never reaches an LLM.

Both exclusions get tests asserting the negative.

## Testing

**key-maint (pytest):** the four-way probe classification including the
transport-failure split; `GET /keys/{env_var}/test` at tiers 1/2/3;
`PUT /keys/{env_var}` accepted at tier 3 and refused below it; the write
preserves comments, ordering and unrelated vars, and is atomic; an unknown
`env_var` is rejected; **a failed write's response body and the log contain
no part of the submitted value** (the leak guard, asserted directly).

**bdobb (vitest):** pill class per status/demo combination; dot colour per
probe result, grey when unprobed; sorting and resizing work (the reason this
is native); probe fires once on mount and not again without Refresh; the
context menu opens, tests one provider, and closes on Escape; edit controls
absent below tier 3 and present at tier 3; a successful PUT refreshes the row
and surfaces the restart notice; **raw view is unavailable for a `keys`
widget**; **a `keys` widget is excluded from `widgetRefs` even with context
sharing enabled**.

## Out of scope

- Deleting or clearing a key (only set/replace).
- An in-process credential-reload endpoint for `openbb-api`.
- key-maint restarting the API container.
- Changing the existing `provider_api_keys` table widget that Workspace uses.
- The BDOBB provider badges, which keep reading `/keys` unchanged.

## Roll-up

Per Art's convention, fixes and features fold into every tag rather than
shipping as patch releases. This one touches a widget type that exists from
v3.0.0 onward, so it rolls into v3–v9 — but the roll-up happens only after
the Symphony work in flight has landed, to avoid rewriting tags under an
active branch.
