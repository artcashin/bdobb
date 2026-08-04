# Test environment

BDOBB talks to a self-hosted OpenBB stack. That makes it awkward to try
out, and awkward to develop against: until now every meaningful test needed a
private deployment that only its owner could reach.

This sets up a complete local backend in one command, using OpenBB's own
reference implementation. No account, no API key, no tailnet.

```bash
pnpm reference-backend
```

First run clones [OpenBB-finance/backends-for-openbb][repo], creates a
virtualenv and installs its dependencies — about 20 seconds. After that it
starts immediately. It serves on `http://127.0.0.1:7779`, with the widget
catalogue at `/widgets.json`.

Leave it running and point BDOBB at it, either by adding a backend in the app
with that base URL, or by putting it in `.env.local`:

```
VITE_OPENBB_API_URL=http://127.0.0.1:7779
```

Setting it in `.env.local` makes the reference backend the app's default
backend, so a fresh launch points at it without any dialog work.

## What you get

Around 70 widgets covering most of the widgets.json specification — tables with
column definitions, render functions, grouping and hover cards; Plotly charts;
metrics; markdown; PDFs; parameter forms with every input type; and several
widget types BDOBB deliberately does not render (see below).

This is enough to exercise the parts of BDOBB that are hard to test any other
way: parameter defaults resolving against real endpoints, the table↔chart
toggle deciding whether a payload is chartable, the raw view, per-card
parameter editing, and error states.

## Conformance suite

```bash
pnpm test:reference     # with the backend running in another terminal
```

Six checks, and the reason they are worth more than the rest of the suite is
that **the fixture is not ours**. Testing a widgets.json client against a
widgets.json we also wrote proves the two agree with each other; it cannot
prove either matches the specification. This corpus is the specification's own
reference implementation, so a disagreement here is BDOBB's bug.

The suite asserts that:

- the corpus is large enough for the other assertions to mean anything — a
  backend answering `200` with an empty catalogue would otherwise make every
  check below vacuously true
- `parseWidgetsJson` drops **nothing**; anything discarded is a spec field the
  parser does not understand
- every parsed widget has the fields the renderers require
- every generated URL stays on the backend's origin — nothing in a remote
  widgets.json can steer a request elsewhere
- every table, metric and chart widget actually fetches
- every widget type is either rendered or on a known-unrendered list

It is opt-in (`OPENBB_REFERENCE=1`, which `pnpm test:reference` sets) rather
than skip-if-unreachable. A suite that turns itself off when the backend is
missing reports green for a completely broken client, which is the failure it
exists to catch. With the backend down the run exits non-zero.

CI runs this on every push, pinned to a specific upstream commit so that an
upstream change arrives as a deliberate version bump rather than as a red build
on someone's unrelated pull request.

## Dashboards, not just widgets

The reference backend also serves `/apps.json`: one app laying all 70 widgets
out across 14 themed tabs. Import it from the dashboard tab strip
(**Import** → pick
`.reference-backend/getting-started/reference-backend/apps.json`) and you get
14 populated dashboards instead of an empty grid to fill by hand.

That path is covered by the conformance suite, which is the strongest evidence
the interchange works: against the real corpus every widget id resolves, no card
overhangs the grid, and an export/re-import round trip reproduces all 70 layouts
exactly.

The **Grouping** tab is the one to look at to see linked parameters working.
It holds two cards sharing `company` and `year`, and two sharing `symbol`;
changing the manufacturer on either of the first pair moves both. The
conformance suite asserts those bindings resolve, which catches the failure a
screenshot cannot — a tab that imports looking right and behaves wrong.

## Widget types BDOBB does not render

The reference backend publishes several types BDOBB has no renderer for:
`advanced_charting`, `chart-highcharts`, `chart-vegalite`, `live_grid`,
`newsfeed`, `omni` and `youtube`.

These fall through to the raw JSON view rather than failing — a card shows the
payload instead of a chart. That is the designed behaviour, not a crash, and
the list is asserted in the suite so that a new type upstream shows up as a
test failure instead of silently enlarging the set of widgets that render as
JSON.

## Pinning

The checkout tracks upstream `main` by default, so new widget types appear as
OpenBB adds them. Pin it when you want the environment frozen:

```bash
REF_BACKEND_REF=<sha> pnpm reference-backend
```

Delete `.reference-backend/` to start over; it is gitignored.

## What this does not cover

The reference backend serves **data**. It is not an agent, so nothing here
exercises the chat pane, the SSE protocol, `get_widget_data`, or MCP.

That gap is structural rather than an oversight. The custom-agent protocol runs
in one direction — OpenBB Workspace calls *your* agent — so OpenBB Copilot has
no endpoint a third-party client can call, and there is no public agent to test
against the way there is a public backend. Testing the chat half needs an agent
implementing [agents.json][agents], self-hosted, which is what
`src/test/integration/real-endpoints.test.ts` covers for whoever has one.

[repo]: https://github.com/OpenBB-finance/backends-for-openbb
[agents]: https://docs.openbb.co/workspace/developers/json-specs/agents-json-reference
