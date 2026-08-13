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

## Model host

Rita's `OPENAI_BASE_URL` points at the box's local model stack, which is
**vLLM in Docker**, not the llama.cpp servers this file used to describe.
The stack itself is documented in the DGX Spark local-LLM runbook; only
what Rita depends on is repeated here.

| | `qwen` | `gemma` |
|---|---|---|
| Served id | `qwen3-14b` | `gemma-4-26b` |
| Weights | `Qwen/Qwen3-14B-FP8` | `RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic` |
| Local | `http://127.0.0.1:8000/v1` | `http://127.0.0.1:8001/v1` |
| Tailnet | `https://qwen.<your-tailnet>.ts.net/v1` | `https://gemma.<your-tailnet>.ts.net/v1` |
| Role label | coding | general |

Both run from `ghcr.io/artcashin/dgx-vllm:cu130` with `--network host`,
`--restart unless-stopped`, and `com.artcashin.*` labels; Gemma
additionally needs a host-mounted `tool_chat_template_gemma4.jinja`
because the custom image ships no vLLM examples directory. Start Gemma
first and let it become healthy before starting Qwen — they share
unified GPU memory.

What changed for Rita, versus the llama.cpp deployment:

- **No auth.** The per-consumer key files (`/root/keys/{qwen,gemma}.keys`,
  `SPARK_KEY_RITA`) are gone. `OPENAI_API_KEY` is now a non-empty
  placeholder the SDK requires, not a credential.
- **Loopback, not a tailnet IP.** vLLM binds via host networking, and Rita
  is also `--network host`, so `http://127.0.0.1:<port>/v1` is enough. The
  old `<SPARK_TS_IP>` step is obsolete.
- **Model ids changed.** `qwen3-coder` no longer exists; it is `qwen3-14b`.
- **No startup key reload.** The `docker restart llm` / "~1-2 min of HTTP
  503 while it warms back up" caveat was a llama.cpp key-file behaviour and
  no longer applies.

### One base URL, one model

Rita reads a single `OPENAI_BASE_URL`, so it can reach exactly **one** of
the two servers. `DEFAULT_MODEL` must name the model that server serves.
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

To switch Rita between the two, edit `~/rita/rita.env` (`OPENAI_BASE_URL`
port + `DEFAULT_MODEL`) and `docker restart rita`.

`rita.env.example` ships the **Qwen** pairing, because the model runbook
names Qwen the primary coding/agent model. The **currently deployed**
`~/rita/rita.env` is on Gemma (`:8001` / `openai:gemma-4-26b`) — a
deliberate choice: Gemma's tool calling is verified working (below) and it
serves the larger context window. Read the live value from the agent
itself rather than from this file:

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
- Models: `:8000` (`qwen3-14b`), `:8001` (`gemma-4-26b`) — see
  [Model host](#model-host). Unauthenticated, so `/v1/models` and
  `/v1/chat/completions` are both directly curl-able.

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
calling is not optional here. Both models were verified against
`/v1/chat/completions` with a `tools` array: each returned
`finish_reason: "tool_calls"` with well-formed arguments. End to end
through Rita, a `/v1/query` carrying one real MCP descriptor produced a
clean `copilotFunctionCall`:

    event: copilotFunctionCall
    data: {"function":"execute_agent_tool","input_arguments":{"server_id":"openbb","tool_name":"available_categories","parameters":{}}}

with no `copilotStatusUpdate` ERROR event. Gemma's tool calling depends on
the mounted `tool_chat_template_gemma4.jinja` plus
`--enable-auto-tool-choice --tool-call-parser gemma4`; Qwen's on
`--tool-call-parser qwen3_xml`. If either flag or the template mount is
dropped, tool calls silently stop being emitted and the agent answers from
the model's own knowledge instead.

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
