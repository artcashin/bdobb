# libre-bdobb

Run [Libre Terminal](https://github.com/samlazs/libre-terminal) in a container and use it as a
**BDOBB** backend, in place of an OpenBQ stack.

Libre Terminal brings the data: the OpenBB Platform with 1,000+ widgets, most of them keyless, plus
about 50 computed views of its own (comps, valuation bands, bond curves, CDS indices, policy paths,
option gamma). BDOBB brings the desktop: dashboards, Statement view, Pivot, linked tables and charts.

## Why a recipe is needed

Libre Terminal is built to answer only its own browser page on the same computer. Every request must
be addressed to `127.0.0.1` or `localhost` and carry either no `Origin` or Libre Terminal's own.
BDOBB's desktop app always sends its own origin (`tauri://localhost`, or `http://tauri.localhost` on
Windows), so Libre Terminal answers `403` to all of it.

This recipe puts a small **guard** in the same container. It applies the same kind of checks with
BDOBB's origins added to the allow-list, then forwards each request as a plain local client.

```
BDOBB ──► guard :7900 ──► Libre Terminal data backend  127.0.0.1:6900   (widgets.json, apps.json, /api/v1)
      └─► guard :7950 ──► Libre Terminal views server  127.0.0.1:6950   (widgets.json, /x/*)
```

## Start

Needs Docker with Compose, about 3 GB of disk and an internet connection.

```sh
docker compose up -d --build        # first build: 5 to 10 minutes
docker compose ps                   # wait for "healthy" (about a minute after the build)
```

Then in BDOBB open **Connections** and add two backends:

| Name | URL | What you get |
|---|---|---|
| Libre data | `http://127.0.0.1:7900` | The OpenBB widgets, including financial statements |
| Libre views | `http://127.0.0.1:7950` | Libre Terminal's computed views |

Test each, then Add. Widgets appear in the Widget Library. For a first statement, add
`equity_fundamental_income_yfinance_obb`, type a symbol, and switch the card's **View** to Statement.

Stop with `docker compose down`. Your Libre Terminal state and keys live in named volumes and
survive; `docker compose down -v` removes them.

## Optional settings

Copy `.env.example` to `.env`.

- **API keys.** Free keys from FRED, EIA, BLS and Congress.gov add more U.S. data. Copy
  `api_keys.example.env` to `api_keys.env`, fill it in, set `LIBRE_API_KEYS_FILE=./api_keys.env`,
  and restart. The file is mounted read-only and never built into the image.
- **A shared secret.** Set `LIBRE_GUARD_TOKEN`. In the BDOBB Connection set header name
  `X-Libre-Token` and the same value. Widgets that BDOBB shows in a frame cannot carry the header
  and will not load while a token is set.
- **Other devices, over Tailscale.** Copy `ts.env.example` to `ts.env` and add an auth key. Set
  `LIBRE_GUARD_EXTRA_HOSTS` to this node's tailnet name (for example `libre.your-tailnet.ts.net`),
  then `docker compose --profile tailnet up -d`. The Connections become
  `https://libre.your-tailnet.ts.net` (data) and `https://libre.your-tailnet.ts.net:8443` (views).
  Tailscale's proxy passes the caller's `Host` and `Origin` through untouched, which is why the
  guard has to know the tailnet name.

## What the guard does and does not do

It refuses a request when:

- the `Host` is not one it was told to answer for (stops DNS-rebinding pages);
- an `Origin` is present and is not a BDOBB desktop origin (stops other web pages);
- there is no `Origin` but the browser marked the request cross-site;
- a token is configured and the request does not carry it.

Otherwise it forwards the request with a local `Host` and without `Origin`, `Referer` or
`Sec-Fetch-*`. Change the allowed origins with `LIBRE_GUARD_ORIGINS` (comma-separated).

This widens who Libre Terminal will answer, on purpose. Keep the published ports on `127.0.0.1`
as shipped, or behind your tailnet. Do not publish them to the internet.

It is plain request/response HTTP. WebSockets and streaming responses are not forwarded.

## Known limits

- Libre Terminal's own 28 curated dashboards are not in `apps.json` form, so BDOBB cannot import
  them. `apps.json` on the data port offers OpenBB's stock example apps; some of their cards name
  widgets this install does not have.
- BDOBB's Statement view recognises Libre Terminal's Yahoo and SEC statements, but files many lines
  under "Other": its line taxonomy is keyed to FMP and EODHD field names.
- `newsfeed` widgets have no BDOBB renderer in the release this was tested against.
- Libre Terminal supports Windows officially and calls Linux experimental. This recipe runs it on
  Linux in a container.

## Updating Libre Terminal

The build is pinned to one commit. To move, change `LIBRE_VERSION` and `LIBRE_COMMIT` together in
the `Dockerfile` and rebuild. `guard/test_guard.py` runs offline:

```sh
cd guard && python -m unittest
```

## Credit

All market-data functionality here is [Libre Terminal](https://github.com/samlazs/libre-terminal),
used with its author's blessing. See [NOTICE](NOTICE). This recipe copies none of its code: the
image fetches it from its own repository at build time and runs its own installer and launcher.

## BDOBB patch

`patches/bdobb-release-v10-libre-terminal.patch` is a change for BDOBB's `release/v10` branch
(made against commit `3cc0d9c`). It teaches Statement view the Yahoo Finance and SEC line names
Libre Terminal serves, and adds help text for connecting to Libre Terminal 1.1 with
`TERMINAL_EXTRA_ORIGINS`. Apply it from a BDOBB checkout with `git apply`. It does not regenerate
`SOURCE-MANIFEST.json` or `source-offer.json`.
