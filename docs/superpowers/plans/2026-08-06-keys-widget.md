# Provider API Keys Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Provider API Keys table with a native `keys` widget — one pill per row for key state, a red/amber/green dot for vendor reachability, a right-click single-service test, and tier-3 editing — backed by new key-maint endpoints.

**Architecture:** Two repos. `openbb-docker/key-maint` (FastAPI) splits its probe outcomes, adds a single-provider test endpoint and a tier-3 write path, and declares a second widget of type `keys`. `bdobb` adds `KeysRenderer`, built on the same `@tanstack/react-table` setup as `TableRenderer` so sorting and column resizing behave identically.

**Tech Stack:** Python 3.12 + FastAPI + pytest (key-maint); React 18 + TypeScript + vitest + @tanstack/react-table (bdobb).

**Spec:** `docs/superpowers/specs/2026-08-06-keys-widget-design.md` (in bdobb)

## Global Constraints

- **Repos:** Tasks 1–4 are in `/Users/artcashin/Developer/openbb-docker` (key-maint). Tasks 5–8 are in `/Users/artcashin/Developer/bdobb`. Never mix a commit across the two.
- **`~/Developer/bdobb` is a SHARED checkout** — another session commits Symphony work to `main` there. Before any branch/checkout operation run `git status` and `git log origin/main..HEAD`; never `git checkout .`, never `git clean`, never revert a file you did not create. Leave `src/components/WidgetCard.tsx.bak` and `src/lib/symphonyShare.test.ts` alone.
- **Probe result vocabulary** is exactly: `ok` | `auth_failed` | `error` | `no_response` | `skipped`.
- **Dot colours:** `no_response` → red `#d9695f`; `error` and `auth_failed` → amber `#d9a75f`; `ok` → green `#4caf7d`; `skipped`/unprobed → neutral grey. A 2xx whose body matches an `invalid_markers` string returns `auth_failed` and is therefore **amber** — the vendor answered with an application-level error.
- **Pill:** `set`+`demo:false` → `Own key` green `#4caf7d`; `set`+`demo:true` → `Demo key` amber `#d9a75f`; `empty`/`missing` → `Not set` red `#d9695f`; `unknown` → `Unknown` neutral. Dark text `#0e1116` on the coloured pills. Colour never carries meaning alone — the pill's text states it and the dot has an accessible label.
- **Secrets:** a key value must never appear in a URL, a query string, a log line, a response body, an exception message, a React key, or a `title` attribute. Probe/test detail strings are built **only** from status codes and exception class names.
- **Writes are tier 3 only** (`role="admin"`). Probes are tier ≥ 2.
- **Additive:** the existing `provider_api_keys` table widget stays exactly as it is, because OpenBB Workspace renders it and does not know a `keys` type.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Roll-up into v3–v9 is explicitly NOT part of this plan** — it waits until the Symphony work lands.

---

### Task 1: Split probe outcomes (key-maint)

**Repo:** `/Users/artcashin/Developer/openbb-docker`

**Files:**
- Modify: `key-maint/app/probes.py`
- Test: `key-maint/tests/test_probes.py`

**Interfaces:**
- Produces (used by Tasks 2–4 and the renderer): `TestResult.result` ∈ `{ok, auth_failed, error, no_response, skipped}`.

- [ ] **Step 1: Write the failing tests**

Read `key-maint/tests/test_probes.py` first and follow its existing style for faking `httpx` responses. Add:

```python
class TestTransportFailureIsDistinct:
    """A vendor that never answers must not look like one that answered
    with an error: the widget paints the first red and the second amber."""

    @pytest.mark.asyncio
    async def test_timeout_is_no_response(self):
        # httpx.HTTPError subclasses cover timeout/connect/DNS failures.
        result = await _probe_with(raises=httpx.ConnectTimeout("boom"))
        assert result.result == "no_response"
        assert "ConnectTimeout" in result.detail

    @pytest.mark.asyncio
    async def test_connect_error_is_no_response(self):
        result = await _probe_with(raises=httpx.ConnectError("refused"))
        assert result.result == "no_response"

    @pytest.mark.asyncio
    async def test_http_500_is_error_not_no_response(self):
        result = await _probe_with(status=500)
        assert result.result == "error"

    @pytest.mark.asyncio
    async def test_401_is_auth_failed(self):
        result = await _probe_with(status=401)
        assert result.result == "auth_failed"

    @pytest.mark.asyncio
    async def test_200_rejected_by_body_is_auth_failed(self):
        # Alpha Vantage and FMP report a bad key with HTTP 200 plus an error
        # string, so the status code alone is not the signal.
        result = await _probe_with(status=200, body="Invalid API call")
        assert result.result == "auth_failed"

    @pytest.mark.asyncio
    async def test_detail_never_contains_the_key(self):
        result = await _probe_with(status=500, key="supersecret123")
        assert "supersecret123" not in result.detail
```

Write the `_probe_with(...)` helper in that file: it should build a provider with a probe spec (reuse whatever `test_probes.py` already does for this — do NOT invent a second mechanism), drive `_probe_one` against a stubbed `httpx.AsyncClient`, and return the `TestResult`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd key-maint && python -m pytest tests/test_probes.py -v`
Expected: the new cases FAIL — `no_response` does not exist yet, so the timeout cases report `error`.

- [ ] **Step 3: Implement the split**

In `key-maint/app/probes.py`, the docstring of `TestResult` and the `except` branch change:

```python
@dataclass(frozen=True)
class TestResult:
    # ok | auth_failed | error | no_response | skipped
    #
    # `no_response` and `error` are deliberately distinct: the widget paints
    # a vendor that never answered red, and one that answered with an error
    # amber. Collapsing them (as this did) made an outage indistinguishable
    # from a rejected request.
    result: str
    detail: str
```

and

```python
    try:
        resp = await client.send(request)
    except httpx.HTTPError as e:
        return TestResult("no_response", type(e).__name__)
```

Everything else in `_probe_one` is unchanged — in particular the
`invalid_markers` branch already returns `auth_failed`, which is the amber
bucket, and that is correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd key-maint && python -m pytest tests/test_probes.py -v`
Expected: PASS.

- [ ] **Step 5: Run the whole key-maint suite and commit**

Run: `cd key-maint && python -m pytest -q && ruff check app tests`
Expected: all green, no lint errors.

```bash
git add key-maint/app/probes.py key-maint/tests/test_probes.py
git commit -m "feat(key-maint): distinguish a vendor that never answers from one that errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Single-provider test endpoint (key-maint)

**Repo:** `/Users/artcashin/Developer/openbb-docker`

**Files:**
- Modify: `key-maint/app/server.py`
- Test: `key-maint/tests/test_server.py`

**Interfaces:**
- Consumes (Task 1): the five-value `TestResult.result`.
- Produces (used by Task 7): `GET /keys/{env_var}/test` → `{"result": str, "detail": str}`; 404 for an unknown `env_var`; 403 below tier 2.

- [ ] **Step 1: Write the failing tests**

Add to `key-maint/tests/test_server.py`, reusing its existing `files` fixture, `client(files, role)` helper and `AUTH` header:

```python
class TestSingleProviderTest:
    def test_tier_1_is_refused(self, files):
        c = client(files, "network")  # no XFF -> tier 1
        r = c.get("/keys/EODHD_API_KEY/test", headers=AUTH)
        assert r.status_code == 403

    def test_unknown_env_var_is_404(self, files):
        c = client(files, "admin")
        r = c.get("/keys/NOT_A_PROVIDER/test", headers=AUTH)
        assert r.status_code == 404

    def test_admin_gets_a_result_shape(self, files, monkeypatch):
        # Stub the probe so the test never touches a vendor's API.
        async def fake_probe(env_var, values):
            return TestResult("ok", "HTTP 200")
        monkeypatch.setattr("app.server.probe_one_provider", fake_probe)
        c = client(files, "admin")
        r = c.get("/keys/EODHD_API_KEY/test", headers=AUTH)
        assert r.status_code == 200
        assert r.json() == {"result": "ok", "detail": "HTTP 200"}

    def test_requires_auth(self, files):
        c = client(files, "admin")
        assert c.get("/keys/EODHD_API_KEY/test").status_code == 401
```

Import `TestResult` from `app.probes` at the top of the test module if it is not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd key-maint && python -m pytest tests/test_server.py -k SingleProviderTest -v`
Expected: FAIL — the route does not exist (404 on every case).

- [ ] **Step 3: Add a single-provider probe helper**

In `key-maint/app/probes.py`, expose one provider's probe without running all of them:

```python
async def probe_one_provider(env_var: str, values: dict[str, str]) -> TestResult:
    """Probe a single provider. Backs the widget's per-row 'Test this
    service' action, which must not fire ~18 vendor requests to check one."""
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        return await _probe_one(client, env_var, values)
```

- [ ] **Step 4: Add the route**

In `key-maint/app/server.py`, import `probe_one_provider` alongside `run_probes`, and add inside `create_app` beside the existing `/keys` route:

```python
    @app.get("/keys/{env_var}/test")
    async def test_key(env_var: str, request: Request) -> Response:
        if env_var not in PROVIDERS:
            return JSONResponse({"detail": "unknown provider"}, status_code=404)
        if _tier(role, request) < 2:
            return JSONResponse({"detail": "not permitted"}, status_code=403)
        values, _ = load_with_warnings(cred_file)
        result = await probe_one_provider(env_var, values or {})
        return JSONResponse({"result": result.result, "detail": result.detail})
```

`PROVIDERS` is already imported in `server.py` if the existing code references it; if not, import it from `app.registry`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd key-maint && python -m pytest tests/test_server.py -v`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 6: Full suite, lint, commit**

Run: `cd key-maint && python -m pytest -q && ruff check app tests`

```bash
git add key-maint/app/probes.py key-maint/app/server.py key-maint/tests/test_server.py
git commit -m "feat(key-maint): GET /keys/{env_var}/test probes one provider

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Atomic credentials writer (key-maint)

**Repo:** `/Users/artcashin/Developer/openbb-docker`

**Files:**
- Modify: `key-maint/app/credfile.py`
- Test: `key-maint/tests/test_credfile.py`

**Interfaces:**
- Produces (used by Task 4): `set_value(path: str, env_var: str, value: str) -> None` — updates one variable in place, appends it if absent, and replaces the file atomically.

- [ ] **Step 1: Write the failing tests**

Add to `key-maint/tests/test_credfile.py`:

```python
class TestSetValue:
    def test_updates_in_place_preserving_everything_else(self, tmp_path):
        p = tmp_path / "credentials.env"
        p.write_text(
            "# leading comment\n"
            "FMP_API_KEY=old\n"
            "\n"
            "# another comment\n"
            "EODHD_API_KEY=keepme\n"
        )
        set_value(str(p), "FMP_API_KEY", "new")
        text = p.read_text()
        assert "FMP_API_KEY=new" in text
        assert "# leading comment" in text
        assert "# another comment" in text
        assert "EODHD_API_KEY=keepme" in text
        # order preserved: FMP still before EODHD
        assert text.index("FMP_API_KEY") < text.index("EODHD_API_KEY")

    def test_appends_when_absent(self, tmp_path):
        p = tmp_path / "credentials.env"
        p.write_text("FMP_API_KEY=old\n")
        set_value(str(p), "EODHD_API_KEY", "fresh")
        assert "EODHD_API_KEY=fresh" in p.read_text()
        assert "FMP_API_KEY=old" in p.read_text()

    def test_setting_empty_clears_the_value(self, tmp_path):
        p = tmp_path / "credentials.env"
        p.write_text("FMP_API_KEY=old\n")
        set_value(str(p), "FMP_API_KEY", "")
        assert parse_text(p.read_text())["FMP_API_KEY"] == ""

    def test_round_trips_through_the_parser(self, tmp_path):
        # The writer must agree with the reader, or the widget shows one
        # thing and the next container restart loads another.
        p = tmp_path / "credentials.env"
        p.write_text("FMP_API_KEY=old\n")
        set_value(str(p), "FMP_API_KEY", "abc123")
        assert parse_text(p.read_text())["FMP_API_KEY"] == "abc123"

    def test_no_temp_file_left_behind(self, tmp_path):
        p = tmp_path / "credentials.env"
        p.write_text("FMP_API_KEY=old\n")
        set_value(str(p), "FMP_API_KEY", "new")
        assert [f.name for f in tmp_path.iterdir()] == ["credentials.env"]
```

Import `set_value` (and `parse_text` if not already imported) at the top.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd key-maint && python -m pytest tests/test_credfile.py -v`
Expected: FAIL — `set_value` is not defined.

- [ ] **Step 3: Implement**

Append to `key-maint/app/credfile.py`:

```python
import os
import tempfile


def set_value(path: str, env_var: str, value: str) -> None:
    """Update one variable in credentials.env, preserving comments, blank
    lines, ordering and every other entry.

    Rewritten atomically (temp file in the same directory + os.replace) so a
    crash mid-write cannot truncate the file the API loads its credentials
    from. A partial credentials.env is worse than a stale one.
    """
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []

    replaced = False
    out: list[str] = []
    for raw in lines:
        m = _LINE.match(raw.strip())
        if m and m.group(1) == env_var and not replaced:
            out.append(f"{env_var}={value}")
            replaced = True
        else:
            out.append(raw)
    if not replaced:
        out.append(f"{env_var}={value}")

    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".credentials.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        os.replace(tmp, path)
    except BaseException:
        # Never leave a temp file holding a credential behind.
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd key-maint && python -m pytest tests/test_credfile.py -v`
Expected: PASS.

- [ ] **Step 5: Full suite, lint, commit**

Run: `cd key-maint && python -m pytest -q && ruff check app tests`

```bash
git add key-maint/app/credfile.py key-maint/tests/test_credfile.py
git commit -m "feat(key-maint): atomic in-place credentials writer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tier-3 write endpoint + the `keys` widget declaration (key-maint)

**Repo:** `/Users/artcashin/Developer/openbb-docker`

**Files:**
- Modify: `key-maint/app/server.py`
- Test: `key-maint/tests/test_server.py`

**Interfaces:**
- Consumes (Task 3): `set_value`.
- Produces (used by Tasks 6–8): `PUT /keys/{env_var}` with body `{"value": str}` → `{"status": "set"|"empty", "restart_required": true}`; 403 below tier 3; 404 unknown var. And a second widget `provider_api_keys_panel` of `type: "keys"` in `/widgets.json`.

- [ ] **Step 1: Write the failing tests**

Add to `key-maint/tests/test_server.py`:

```python
class TestWriteKey:
    def test_network_role_is_refused_even_from_the_tailnet(self, files):
        c = client(files, "network")
        r = c.put(
            "/keys/FMP_API_KEY",
            headers={**AUTH, "X-Forwarded-For": "100.100.100.100"},  # tier 2
            json={"value": "nope"},
        )
        assert r.status_code == 403

    def test_admin_writes_and_reports_restart_required(self, files):
        cred, _ = files
        c = client(files, "admin")
        r = c.put("/keys/FMP_API_KEY", headers=AUTH, json={"value": "written123"})
        assert r.status_code == 200
        assert r.json() == {"status": "set", "restart_required": True}
        assert "FMP_API_KEY=written123" in open(cred).read()

    def test_response_never_echoes_the_value(self, files):
        c = client(files, "admin")
        r = c.put("/keys/FMP_API_KEY", headers=AUTH, json={"value": "supersecret999"})
        assert "supersecret999" not in r.text

    def test_a_rejected_write_never_echoes_the_value(self, files):
        # FastAPI's 422 body echoes the offending input, so the value must not
        # be validated by a Pydantic constraint. Send a wrong-typed value and
        # assert the secret-shaped sibling never appears in the response.
        c = client(files, "admin")
        r = c.put("/keys/NOT_A_PROVIDER", headers=AUTH, json={"value": "supersecret999"})
        assert r.status_code == 404
        assert "supersecret999" not in r.text

    def test_unknown_env_var_is_rejected(self, files):
        cred, _ = files
        c = client(files, "admin")
        r = c.put("/keys/EVIL_VAR", headers=AUTH, json={"value": "x"})
        assert r.status_code == 404
        assert "EVIL_VAR" not in open(cred).read()

    def test_empty_value_reports_empty(self, files):
        c = client(files, "admin")
        r = c.put("/keys/FMP_API_KEY", headers=AUTH, json={"value": ""})
        assert r.json()["status"] == "empty"

    def test_requires_auth(self, files):
        c = client(files, "admin")
        assert c.put("/keys/FMP_API_KEY", json={"value": "x"}).status_code == 401


class TestPanelWidget:
    def test_widgets_json_offers_both_table_and_keys(self, files):
        body = client(files, "admin").get("/widgets.json", headers=AUTH).json()
        assert body["provider_api_keys"]["type"] == "table"
        assert body["provider_api_keys_panel"]["type"] == "keys"
        # Same data source; the panel is a second view, not a fork.
        assert body["provider_api_keys_panel"]["endpoint"] == "keys"
        # Raw view would be a one-click path to every value the tier exposes.
        assert body["provider_api_keys_panel"].get("raw") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd key-maint && python -m pytest tests/test_server.py -k "WriteKey or PanelWidget" -v`
Expected: FAIL — the PUT returns 501 today, and the panel widget does not exist.

- [ ] **Step 3: Replace the 501 stub**

In `key-maint/app/server.py`, import `set_value` from `app.credfile`, and replace the existing `put_key` stub with:

```python
    @app.put("/keys/{env_var}")
    async def put_key(env_var: str, request: Request) -> Response:
        # Deliberately NOT a Pydantic body model: FastAPI's 422 response
        # echoes the offending input, which would print the secret. The body
        # is parsed by hand and never reflected.
        if env_var not in PROVIDERS:
            return JSONResponse({"detail": "unknown provider"}, status_code=404)
        if _tier(role, request) < 3:
            return JSONResponse({"detail": "not permitted"}, status_code=403)
        try:
            payload = await request.json()
            value = payload["value"]
            if not isinstance(value, str):
                raise ValueError
        except Exception:
            # No exception detail: the parsed body holds the secret.
            return JSONResponse({"detail": "body must be {\"value\": string}"}, status_code=400)

        try:
            set_value(cred_file, env_var, value)
        except OSError as e:
            # Class name only — the message could carry the path, and a
            # traceback could carry the value.
            return JSONResponse(
                {"detail": f"write failed: {type(e).__name__}"}, status_code=500
            )

        # The running openbb-api cannot see this: OpenBB fills Credentials
        # from os.environ, a container's environ is frozen at process start,
        # and UserService is a singleton read once per process. Say so rather
        # than letting the user think the change took effect.
        return JSONResponse({"status": "set" if value else "empty", "restart_required": True})
```

- [ ] **Step 4: Add the panel widget**

In `key-maint/app/server.py`, extend the module-level `WIDGETS` dict with a second entry beside `provider_api_keys` — keep the existing entry byte-identical, since OpenBB Workspace renders it:

```python
WIDGETS = {
    "provider_api_keys": { ... unchanged ... },
    # A second view of the same endpoint for BDOBB, which renders type
    # "keys" natively (pills, reachability dots, per-row test, tier-3
    # editing). Workspace does not know this type, which is exactly why the
    # table above stays: this is additive.
    "provider_api_keys_panel": {
        "name": "Provider API Keys (panel)",
        "description": "Key state and vendor reachability, with per-row test "
        "and (admin only) editing.",
        "category": "Admin",
        "type": "keys",
        "endpoint": "keys",
        "gridData": {"w": 30, "h": 14},
        "data": {"dataKey": "rows"},
        # No raw view: it would expose every value the tier returns.
        "raw": False,
        "params": [],
    },
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd key-maint && python -m pytest -q && ruff check app tests`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add key-maint/app/server.py key-maint/tests/test_server.py
git commit -m "feat(key-maint): tier-3 key writes and a native keys panel widget

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `KeysRenderer` — rows, pills, dots (bdobb)

**Repo:** `/Users/artcashin/Developer/bdobb`

**Files:**
- Create: `src/components/renderers/KeysRenderer.tsx`, `src/components/renderers/KeysRenderer.test.tsx`
- Modify: `src/components/WidgetCard.tsx` (dispatch), `src/styles.css`

**Interfaces:**
- Consumes: `formatCell` / `orderColumns` from `./TableRenderer` if useful (LiveGridRenderer already imports from there — follow that precedent rather than duplicating); `@tanstack/react-table` exactly as `TableRenderer` configures it (`columnResizeMode: "onChange"`, `getSortedRowModel()`).
- Produces (used by Tasks 6–7): the component, and the row shape it reads:
  `{ provider: string; env_var: string; status: "set"|"empty"|"missing"|"unknown"; demo: boolean; test?: { result: string; detail: string }; value?: string }`
  plus the envelope `{ tier: number; rows: Row[] }`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/renderers/KeysRenderer.test.tsx`. It uses the house
pattern from `TableRenderer.test.tsx`: `makeWidgetDef` from
`../../test/widgetDef`, and `render`/`screen`/`fireEvent` from
`@testing-library/react`.

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import KeysRenderer from "./KeysRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const WIDGET = makeWidgetDef({ id: "provider_api_keys_panel", type: "keys" });

/** The /keys envelope, with one row per case under test. */
function data(rows: unknown[], tier = 1) {
  return { tier, rows };
}

const OWN = { provider: "FMP", env_var: "FMP_API_KEY", status: "set", demo: false };
const DEMO = { provider: "EODHD", env_var: "EODHD_API_KEY", status: "set", demo: true };
const UNSET = { provider: "Tiingo", env_var: "TIINGO_TOKEN", status: "empty", demo: false };

function renderKeys(rows: unknown[], tier = 1) {
  return render(
    <KeysRenderer data={data(rows, tier)} widgetDef={WIDGET} theme="dark" />
  );
}

describe("KeysRenderer pills", () => {
  it("names each key state in the pill's own text", () => {
    renderKeys([OWN, DEMO, UNSET]);
    expect(screen.getByText("Own key")).toBeInTheDocument();
    expect(screen.getByText("Demo key")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("colours the pill by key state", () => {
    // classList.contains, never className.toContain: a bare substring match
    // passes on the wrong class when one name contains another.
    const { container } = renderKeys([OWN, DEMO, UNSET]);
    const pills = [...container.querySelectorAll(".keys-pill")];
    expect(pills[0].classList.contains("own")).toBe(true);
    expect(pills[1].classList.contains("demo")).toBe(true);
    expect(pills[2].classList.contains("unset")).toBe(true);
  });
});

describe("KeysRenderer reachability dot", () => {
  const withTest = (row: object, result: string) => ({
    ...row,
    test: { result, detail: `stub ${result}` },
  });

  it("paints red only when the vendor never answered", () => {
    const { container } = renderKeys([withTest(OWN, "no_response")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("down")).toBe(true);
  });

  it("paints amber when the vendor answered with an error", () => {
    const { container } = renderKeys([withTest(OWN, "error")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("warn")).toBe(true);
  });

  it("treats a 200 rejected by body as amber, not green", () => {
    // Alpha Vantage and FMP report a bad key with HTTP 200 and an error
    // string, so the status code alone is not the signal.
    const { container } = renderKeys([withTest(OWN, "auth_failed")]);
    const dot = container.querySelector(".keys-dot")!;
    expect(dot.classList.contains("warn")).toBe(true);
    expect(dot.classList.contains("ok")).toBe(false);
  });

  it("paints green only on a clean probe", () => {
    const { container } = renderKeys([withTest(OWN, "ok")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("ok")).toBe(true);
  });

  it("is neutral when no probe has run", () => {
    const { container } = renderKeys([OWN]);
    expect(container.querySelector(".keys-dot")!.classList.contains("idle")).toBe(true);
  });

  it("names the server state in text, so colour is not the only carrier", () => {
    renderKeys([withTest(OWN, "no_response")]);
    expect(screen.getByLabelText(/not responding/i)).toBeInTheDocument();
  });
});

describe("KeysRenderer secrecy", () => {
  it("never renders a key value, even when the row carries one", () => {
    // Tier-3 rows include `value`; this renderer must not put it in the DOM.
    const { container } = renderKeys([{ ...OWN, value: "supersecret999" }], 3);
    expect(container.textContent).not.toContain("supersecret999");
  });
});

describe("KeysRenderer table behaviour", () => {
  it("sorts by provider when the header is clicked", () => {
    const { container } = renderKeys([UNSET, OWN]);
    const before = [...container.querySelectorAll(".keys-provider")].map((e) => e.textContent);
    expect(before).toEqual(["Tiingo", "FMP"]);
    fireEvent.click(screen.getByText("Provider"));
    const after = [...container.querySelectorAll(".keys-provider")].map((e) => e.textContent);
    expect(after).toEqual(["FMP", "Tiingo"]);
  });
});
```

Add `fireEvent` to the import when you write the sorting test. If
`makeWidgetDef` does not accept a `type`, extend the row/widget fixture the
way `TableRenderer.test.tsx` does rather than inventing a new helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/renderers/KeysRenderer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

Create `src/components/renderers/KeysRenderer.tsx`. Mirror `TableRenderer`'s `useReactTable` setup so sorting and resizing are identical; render four columns — dot, provider, pill, detail. Derive the dot from `row.test?.result` per the Global Constraints table, and the pill from `status`/`demo`. The `value` field must never be rendered in this task.

- [ ] **Step 4: Dispatch the type**

In `src/components/WidgetCard.tsx`, in the chain of `if (widget.type === …)` around line 295, add before the `table` branch:

```tsx
    if (widget.type === "keys") {
      return <KeysRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
```

and import it beside the other renderers. Note `card.view === "raw"` is checked *before* this chain; Task 6 handles that.

- [ ] **Step 5: Add the styles**

In `src/styles.css`, add `.keys-pill` (with `.own` / `.demo` / `.unset` / `.unknown`) and `.keys-dot` (with `.ok` / `.warn` / `.down` / `.idle`) using the exact colours from the Global Constraints, dark text `#0e1116` on the coloured pills. Match the stylesheet's existing comment voice.

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `pnpm vitest run src/components/renderers/KeysRenderer.test.tsx && pnpm typecheck && pnpm test:run`

```bash
git add src/components/renderers/KeysRenderer.tsx src/components/renderers/KeysRenderer.test.tsx src/components/WidgetCard.tsx src/styles.css
git commit -m "feat: native keys widget — key-state pills and vendor reachability dots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Keep key state away from raw view and Rita (bdobb)

**Repo:** `/Users/artcashin/Developer/bdobb`

**Files:**
- Modify: `src/components/WidgetCard.tsx`, `src/lib/agent/agentClient.ts`
- Test: `src/components/WidgetCard.test.tsx`, `src/lib/agent/agentClient.test.ts`

**Interfaces:**
- Consumes (Task 5): `widget.type === "keys"`.
- Produces: nothing consumed later.

**Why both:** `availableViews` only offers "raw" when `widget.raw` is true, and Task 4 sets `raw: false` — but a card whose view was persisted as `"raw"` still hits the `card.view === "raw"` branch *before* type dispatch, so the server flag alone is not enough. `buildWidgetRefs` (in `agentClient.ts`) is what feeds Rita's `widgets` field.

- [ ] **Step 1: Write the failing tests**

In `src/components/WidgetCard.test.tsx`:

```typescript
  it("never shows the raw view for a keys widget, even if the card asks for it", () => {
    // Render a keys-type widget on a card whose persisted view is "raw";
    // assert RawJsonView is not rendered and the keys table is.
  });

  it("does not offer raw as an available view for a keys widget", () => {});
```

In `src/lib/agent/agentClient.test.ts`:

```typescript
  it("excludes keys widgets from widget refs so key state never reaches the agent", () => {
    // buildWidgetRefs over a mixed list; assert the keys widget is absent
    // and a normal table widget is present.
  });
```

Write these out fully, following each file's existing patterns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/WidgetCard.test.tsx src/lib/agent/agentClient.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

In `WidgetCard.tsx`, guard the raw branch and the view list:

```tsx
    // A keys widget's rows carry credential values at tier 3; the raw view
    // would dump them verbatim. Never offer it, and ignore a persisted
    // request for it.
    if (card.view === "raw" && widget.type !== "keys") {
      return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
    }
```

and

```tsx
  const availableViews: CardView[] = ["default"];
  if (widget?.raw && widget.type !== "keys") availableViews.push("raw");
```

In `agentClient.ts`, filter inside `buildWidgetRefs` so every caller is covered rather than just `ChatPane`:

```typescript
  // Key state never goes to an LLM, whatever contextSharing says.
  .filter((w) => getWidgetDef(...)?.type !== "keys")
```

Adapt to the function's actual shape — read it before editing.

- [ ] **Step 4: Run tests, typecheck, full suite, commit**

Run: `pnpm typecheck && pnpm test:run`

```bash
git add src/components/WidgetCard.tsx src/components/WidgetCard.test.tsx src/lib/agent/agentClient.ts src/lib/agent/agentClient.test.ts
git commit -m "fix: keep keys-widget rows out of the raw view and out of Rita's context

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Probe cadence, refresh, and the right-click test (bdobb)

**Repo:** `/Users/artcashin/Developer/bdobb`

**Files:**
- Modify: `src/components/renderers/KeysRenderer.tsx`, `src/components/renderers/KeysRenderer.test.tsx`, `src/components/WidgetCard.tsx` (pass `backend`), `src/styles.css`

**Interfaces:**
- Consumes: Task 2's `GET /keys/{env_var}/test`; `fetchWidgetData` / `fetchJson` from `src/lib/dataClient.ts`; the `backend` prop pattern `LiveGridRenderer` already uses (`WidgetCard` passes `backend` and `params` to it — copy that).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing tests**

Add to `KeysRenderer.test.tsx`:

```typescript
  it("probes once on mount and not again on re-render", () => {
    // fetch impl injected; assert exactly one call with run_tests=true
  });

  it("re-probes only when Refresh is pressed", () => {});

  it("opens a context menu on right-click with a Test this service item", () => {});

  it("tests only the right-clicked provider and updates that row's dot", () => {
    // assert the single-provider endpoint was called with that env_var,
    // and that the all-providers probe was NOT called again
  });

  it("closes the context menu on Escape", () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/renderers/KeysRenderer.test.tsx`

- [ ] **Step 3: Implement**

Probe on mount with `run_tests=true`, hold results in state, and re-probe only from a Refresh control — a dashboard open must not fire ~18 vendor requests every time. Add a row context menu whose only item calls `GET /keys/{env_var}/test` and merges the result into that row. Menu behaviour: Escape closes, click-outside dismisses, arrow keys move between items, and it is reachable from the keyboard.

`WidgetCard` must pass `backend` to `KeysRenderer` the way it already does for `LiveGridRenderer`, so requests carry the backend's auth header.

- [ ] **Step 4: Run tests, typecheck, full suite, commit**

Run: `pnpm typecheck && pnpm test:run`

```bash
git add src/components/renderers/KeysRenderer.tsx src/components/renderers/KeysRenderer.test.tsx src/components/WidgetCard.tsx src/styles.css
git commit -m "feat: probe once then on demand, with a per-row Test this service action

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Tier-3 editing (bdobb)

**Repo:** `/Users/artcashin/Developer/bdobb`

**Files:**
- Modify: `src/components/renderers/KeysRenderer.tsx`, `src/components/renderers/KeysRenderer.test.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: Task 4's `PUT /keys/{env_var}` → `{status, restart_required}`; the `tier` field of the `/keys` envelope.

- [ ] **Step 1: Write the failing tests**

```typescript
  it("shows no edit control below tier 3", () => {});

  it("shows an edit control at tier 3", () => {});

  it("PUTs the new value in the request body, never in the URL", () => {
    // assert the captured URL does not contain the value, and the body does
  });

  it("refreshes the row and shows a restart notice on success", () => {});

  it("surfaces a failed write without logging or displaying the value", () => {
    // assert the typed value appears nowhere in the rendered output after
    // a rejected write
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/renderers/KeysRenderer.test.tsx`

- [ ] **Step 3: Implement**

Render an edit affordance per row only when the envelope reports `tier === 3`. Submitting sends `PUT /keys/{env_var}` with `{ value }` as the JSON body through the app's authenticated request path. On success, refresh that row's state from the server and, when `restart_required` is set, show a persistent notice naming `openbb-api` as the container to bounce — the running API cannot see the change until it restarts. The typed value must never be logged, placed in a URL, used as a React key, or put in a `title`.

- [ ] **Step 4: Run tests, typecheck, full suite, commit**

Run: `pnpm typecheck && pnpm test:run`

```bash
git add src/components/renderers/KeysRenderer.tsx src/components/renderers/KeysRenderer.test.tsx src/styles.css
git commit -m "feat: edit provider keys from the panel at admin tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end verification

**Files:** none — verification gate.

- [ ] **Step 1: Both suites**

```bash
cd /Users/artcashin/Developer/openbb-docker/key-maint && python -m pytest -q && ruff check app tests
cd /Users/artcashin/Developer/bdobb && pnpm typecheck && pnpm test:run && pnpm build && cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Grep for leaks**

Confirm no code path puts a value in a URL or a log:

```bash
cd /Users/artcashin/Developer/bdobb && grep -rn "value" src/components/renderers/KeysRenderer.tsx | grep -iE "logError|title=|key=|\\?|&"
```

Expected: no hit that interpolates a credential. Report what you found either way.

- [ ] **Step 3: Live check against the NAS (needs Art)**

The panel cannot be fully verified in vitest — it needs a real key-maint. Ask Art to add the "Provider API Keys (panel)" widget to a dashboard and confirm: dots resolve after first load, Refresh re-probes, right-click tests one service, and (from the admin instance) an edit round-trips and reports the restart requirement. Do not deploy the new key-maint image without Art's say-so.
