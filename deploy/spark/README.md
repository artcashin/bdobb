# Agent Rita on your GPU host

Stock OpenBB-finance/agent-rita, built from the Gitea fork
`your git mirror of OpenBB-finance/agent-rita` branch `spark` (patches:
honor `OPENAI_BASE_URL` in the OpenAI provider, and force the Chat
Completions API instead of the Responses API for that same provider —
both in `src/lib/providers.ts`; permissive CORS was already present
upstream, `app.use("*", cors())` in `src/server.ts`, no patch needed).
Runs as a Docker container as `dev` (no sudo, docker group) — Docker
with `--restart unless-stopped` instead of a systemd unit, because `dev`
has no passwordless sudo on that box.

Pinned commit deployed: **`955e0fc0934a0aaeb9daac43bc7926e16e7c2b04`**
("spark: force Chat Completions API for the OpenAI-compatible
provider").

## Deploy / update

    ssh <user>@<agent-host>
    cd ~/rita/agent-rita && git pull
    docker build --target rita -t agent-rita .
    docker rm -f rita 2>/dev/null || true
    docker run -d --name rita --restart unless-stopped --network host \
      --env-file ~/rita/rita.env agent-rita

Env file: see `rita.env.example` (real file at `~/rita/rita.env`,
mode 600, dev-owned, never committed).

## Networking

`--network host`, matching the llama.cpp containers' posture (`llm` and
`gemma` also run `--network host` with an explicit `--host <tailnet-ip>`
bind). This is the simplest option that satisfies both directions of
required reachability with no extra config:

- **Inbound**: Rita's Hono server binds `0.0.0.0:8002` (Bun default), so
  with host networking it's immediately reachable at
  `http://<agent-host>:8002` over the tailnet — no port publishing,
  no bridge/NAT hairpin issues.
- **Outbound**: Rita calls `OPENAI_BASE_URL=http://<llm-host-tailnet-ip>:8000/v1`
  (the tailnet IP the `llm` container itself binds to, not localhost).
  With host networking the container shares the host's network stack, so
  that tailnet IP is directly routable with no extra `--add-host` or
  Docker bridge-to-host plumbing.

A bridge network would have needed `--add-host=host.docker.internal:...`
or explicit port publishing plus caring about which interface Tailscale
presents inside the container namespace; host networking sidesteps all of
that and matches the box's established pattern.

## Ports & endpoints

- Rita: `http://<agent-host>:8002` — `GET /agents.json`, `GET /status`,
  `POST /v1/query` (SSE, `event: copilotMessageChunk`).
- Model: llama.cpp `llm` (Qwen, model id `qwen3-coder`) on :8000, `gemma`
  on :8001. Auth via per-consumer keys in `/root/keys/{qwen,gemma}.keys`;
  the Rita key is the `rita` line in `qwen.keys`. Keys load at startup —
  `docker restart llm` after any change (~40s, drops in-flight requests,
  then ~1-2 min of HTTP 503 "Loading model" while it warms back up).
  `/v1/models` is UNAUTHENTICATED; test auth against
  `/v1/chat/completions` only.

## MCP (NOT configured in Rita)

The OpenBB custom-agent protocol passes tool descriptors per request, so
Rita carries no MCP config. The NAS endpoints the desktop app hands it:

- https://openbb.<your-tailnet>.ts.net:8443/mcp/  (openbb-mcp-server -> Platform API)
- https://openbb.<your-tailnet>.ts.net:8444/mcp/  (stores: ArcticDB/kdb read-only)

Rita's optional companion MCP server (port 8787, Tavily/Daytona) is not
deployed.

## Smoke test (from the Mac)

    curl -s http://<agent-host>:8002/agents.json | jq .
    curl -s -o /dev/null -w '%{http_code}\n' http://<agent-host>:8002/status
    curl -si http://<agent-host>:8002/agents.json -H 'Origin: http://localhost:1420' \
      | grep -i '^access-control-allow-origin'
    curl -N -X POST http://<agent-host>:8002/v1/query \
      -H 'Content-Type: application/json' \
      -d '{"messages":[{"role":"human","content":"Say hello in five words."}]}'

`/agents.json`, `/status`, and CORS all verified working as of this deploy
(agent id `openbb_agent_rita`, `200`, `Access-Control-Allow-Origin: *`).

## Fixed: `/v1/query` SSE round trip

Previously the SSE round trip errored mid-stream (see history below for the
full root cause). **Fixed** by pinning the OpenAI-compatible provider to the
Chat Completions API instead of letting `@ai-sdk/openai@3.0.49` default to
the Responses API.

`@ai-sdk/openai@3.0.49`'s bare `openai(id)` factory (as used by the
unpatched `src/lib/providers.ts`) defaults to the OpenAI **Responses API**
(`POST /responses`), not classic Chat Completions — confirmed by reading
`node_modules/@ai-sdk/openai/dist/index.js` inside the built container: the
default model factory calls `createResponsesModel`; only `openai.chat(id)`
uses `/chat/completions`. llama.cpp's `/v1/responses` streaming emulation
reissues/changes the streamed text-part `id` between the reasoning and
answer segments for `qwen3-coder`, which `ai` v6's `stream-text.ts` state
machine treats as a fatal "part not found" error (it requires the same `id`
to open in `text-start` and close in `text-delta`/`text-end`). This is
consistent with the earlier finding (see `dgx-spark-local-llm` notes) that
llama.cpp's Responses-API surface works for simpler clients (Codex) but is
not a byte-for-byte match of OpenAI's actual Responses streaming contract.
`/v1/chat/completions` streaming against the same model is llama.cpp's
primary, most-tested surface and was verified clean (proper role/content
deltas, `finish_reason: "stop"`).

The fix is commit `955e0fc0934a0aaeb9daac43bc7926e16e7c2b04`: change
`resolve: (id) => openai(id)` to `resolve: (id) => openai.chat(id)` for the
`openai:` provider entry only (openrouter/groq/ollama untouched).

**Verified end-to-end after the fix**, three separate `/v1/query` requests
against the redeployed container, all HTTP 200, all completing with no
`copilotStatusUpdate` ERROR event and no server-side `streamText error part`
in `docker logs rita`:

    event: copilotMessageChunk
    data: {"delta":"OK"}

and, for a longer prompt ("Explain in two sentences what a moving
average is."), a full multi-chunk stream (58 output tokens) that
concatenates to a coherent, correct two-sentence answer and ends cleanly.
