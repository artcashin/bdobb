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
      --env-file /root/rita.env agent-rita

Env file: see `rita.env.example`. The **live** file is `/root/rita.env`,
root-owned — `dev` cannot read it and has no passwordless sudo, so this
step needs root.

> **Do not recreate `/home/dev/rita/rita.env`.** A dev-owned copy lived
> there until 2026-08-23, three weeks stale and carrying a live 64-char
> `OPENAI_API_KEY` from the retired per-consumer key scheme. The container
> never read it, so editing it silently did nothing — and because `dev` is
> the documented operator and cannot open `/root` at all, it was the file a
> reader reached for first. It has been deleted (nothing mounted or
> referenced it). `~/rita/agent-rita`, the source checkout, is untouched.

## Model host

Rita's `OPENAI_BASE_URL` points at the box's local model stack, which is
**vLLM in Docker**, not the llama.cpp servers this file used to describe.
The stack itself is documented in the DGX Spark local-LLM runbook; only
what Rita depends on is repeated here.

| | `qwen` |
|---|---|
| Served id | `qwen3.6-35b` |
| Weights | `Qwen/Qwen3.6-35B-A3B-FP8` (35B total / 3B active MoE) |
| Local | `http://127.0.0.1:8000/v1` |
| Tailnet | `https://qwen.<your-tailnet>.ts.net/v1` |
| Context | 262144 |
| Role label | coding |

It runs from `ghcr.io/artcashin/dgx-vllm:cu130` with `--network host`,
`--restart unless-stopped`, and `com.artcashin.*` labels.

**Gemma was retired (2026-08-23)** and `gemma.<your-tailnet>.ts.net` no
longer answers. Qwen3.6 now holds its share of the unified memory pool and
serves every role. The weights stay in the host's HF cache
(`RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`) and the container config is
saved at `/root/container-configs/gemma.json`, so it can be brought back —
but restoring it means lowering Qwen3.6's `--gpu-memory-utilization`
first, since the two no longer fit as previously sized.

Two model-specific behaviours worth knowing, both verified against the
live server:

- **Reasoning is on by default**, and this vLLM returns it under
  `reasoning`, *not* `reasoning_content`. Its tokens bill to completion:
  a tool-call turn spent 78 completion tokens for an empty `content`.
  Per-request escape hatch is `chat_template_kwargs: {"enable_thinking":
  false}`.
- **Tool calling works**, which matters because the desktop app sends MCP
  descriptors on every request. A `tools` array returns
  `finish_reason: "tool_calls"` with well-formed arguments and no content
  leak. The container runs `--enable-auto-tool-choice --tool-call-parser
  qwen3_coder --reasoning-parser qwen3` (read off `docker inspect qwen`,
  2026-08-23). The parser value is model-specific and does not survive a
  model swap; if tool calls ever silently stop being emitted, check it
  first.

What changed for Rita, versus the llama.cpp deployment:

- **No auth.** The per-consumer key files (`/root/keys/{qwen,gemma}.keys`,
  `SPARK_KEY_RITA`) are gone. `OPENAI_API_KEY` is now a non-empty
  placeholder the SDK requires, not a credential.
- **Loopback, not a tailnet IP.** vLLM binds via host networking, and Rita
  is also `--network host`, so `http://127.0.0.1:<port>/v1` is enough. The
  old `<SPARK_TS_IP>` step is obsolete.
- **Model ids changed.** `qwen3-coder` and `qwen3-14b` are both gone; the
  served id is now `qwen3.6-35b`.
- **No startup key reload.** The `docker restart llm` / "~1-2 min of HTTP
  503 while it warms back up" caveat was a llama.cpp key-file behaviour and
  no longer applies.

### One base URL, one model

Rita reads a single `OPENAI_BASE_URL`, so it reaches exactly **one**
server. `DEFAULT_MODEL` must name the model that server serves.
Everything else advertised in `agents.json`'s `model` picker — the
`openai:gpt-*` and `ollama:*` entries, which Rita hardcodes — fails
against this deployment:

    event: copilotStatusUpdate
    data: {"eventType":"ERROR","message":"Model error: The model `gpt-5.5` does not exist.","group":"reasoning"}

That is why the desktop app renders the model as **read-only text**, not a
`<select>`: see the `NoteButton` in `src/components/chat/ChatPane.tsx`, and
the comment above `modelFeature` explaining that `default` is both what is
displayed and what is actually sent. Nothing on the app side needs to
change when the model here changes — it follows `agents.json`.

To repoint Rita, edit `/root/rita.env` (`OPENAI_BASE_URL` port +
`DEFAULT_MODEL`) as root and `docker restart rita`. There is no
dev-readable copy — if editing an env file appears to change nothing,
check that you are editing the one under `/root`.

`rita.env.example` matches the live deployment: `:8000` /
`openai:qwen3.6-35b`. Still read the real value from the agent rather than
from this file — the model has moved twice, and a doc is not authority:

    curl -s http://<agent-host>:8002/agents.json \
      | jq -r '.[].features.model.default'

## Networking

`--network host`, matching the vLLM containers' posture. This is the
simplest option that satisfies both directions of required reachability
with no extra config:

- **Inbound**: Rita's Hono server binds `0.0.0.0:8002` (Bun default), so
  with host networking it's immediately reachable at
  `http://<agent-host>:8002` over the tailnet — no port publishing,
  no bridge/NAT hairpin issues.
- **Outbound**: Rita calls `OPENAI_BASE_URL=http://127.0.0.1:8000/v1`,
  which the vLLM container is already listening on in the same network
  namespace.

A bridge network would have needed `--add-host=host.docker.internal:...`
or explicit port publishing plus caring about which interface Tailscale
presents inside the container namespace; host networking sidesteps all of
that and matches the box's established pattern.

## Ports & endpoints

- Rita: `http://<agent-host>:8002` — `GET /agents.json`, `GET /status`,
  `POST /v1/query` (SSE, `event: copilotMessageChunk`).
- Model: `:8000` (`qwen3.6-35b`) — see [Model host](#model-host).
  Unauthenticated, so `/v1/models` and `/v1/chat/completions` are both
  directly curl-able. `:8001` served Gemma until it was retired and is now
  closed.

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

The repo's own live suite covers the same ground plus MCP discovery —
fill in `.env.local` and run:

    OPENBB_LIVE=1 pnpm test:run src/test/integration

### Tool calling

The desktop app sends MCP tool descriptors on **every** request, so tool
calling is not optional here. `qwen3.6-35b` was verified against
`/v1/chat/completions` with a `tools` array: `finish_reason: "tool_calls"`,
well-formed arguments, empty `content` (no leak). End to end through Rita,
a `/v1/query` carrying one real MCP descriptor produced a clean
`copilotFunctionCall`:

    event: copilotFunctionCall
    data: {"function":"execute_agent_tool","input_arguments":{"server_id":"openbb","tool_name":"available_categories","parameters":{}}}

with no `copilotStatusUpdate` ERROR event. This depends on the container's
`--enable-auto-tool-choice` plus a `--tool-call-parser` matching the model.
That value moves with the model and has changed every time: `qwen3_xml`,
then `hermes` for Qwen 3 14B, now **`qwen3_coder`** for Qwen 3.6 —
confirmed against the running container, not inferred. Get it wrong and
there is no error to find: the server returns HTTP 200 with
`finish_reason: stop` and an empty `tool_calls` array while the call sits
unparsed in `content`, so the agent just answers from its own knowledge
and quietly stops using your tools.

## History: `/v1/query` SSE and the Chat Completions patch

The Chat Completions patch predates the vLLM migration but stays in place.

`@ai-sdk/openai@3.0.49`'s bare `openai(id)` factory (as used by the
unpatched `src/lib/providers.ts`) defaults to the OpenAI **Responses API**
(`POST /responses`), not classic Chat Completions — confirmed by reading
`node_modules/@ai-sdk/openai/dist/index.js` inside the built container: the
default model factory calls `createResponsesModel`; only `openai.chat(id)`
uses `/chat/completions`. llama.cpp's `/v1/responses` streaming emulation
reissued the streamed text-part `id` between the reasoning and answer
segments, which `ai` v6's `stream-text.ts` state machine treats as a fatal
"part not found" error (it requires the same `id` to open in `text-start`
and close in `text-delta`/`text-end`).

The fix is commit `955e0fc0934a0aaeb9daac43bc7926e16e7c2b04`: change
`resolve: (id) => openai(id)` to `resolve: (id) => openai.chat(id)` for the
`openai:` provider entry only (openrouter/groq/ollama untouched).
`/v1/chat/completions` is also vLLM's primary, most-tested surface, so the
patch remains the right default — it has not been re-tested against vLLM's
own `/v1/responses` implementation, and there is no reason to.
