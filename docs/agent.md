# Agent System

This document defines the v1 agent loop, tool handling, and logging. It is intended as the implementation source of truth.

## Goals

- Simple request/response flow (no streaming)
- Serial tool execution for predictable behavior
- Clear, minimal logs that explain what happened

## Core Loop (v1)

1. Build a request from the current conversation state and system prompt.
2. Send a single model request.
3. If the model returns no tool calls, return the response and stop.
4. If the model returns tool calls:
   - Execute tools in order, serially (no parallel execution).
   - Capture each tool result or error.
   - Send one follow-up model request that includes the tool results.
5. Repeat step 3-4 until no tools are requested or the **max iteration limit** is reached.

**Iteration Limit & Handoff**: The default limit is **10 iterations**. If the limit is reached before the task is complete, the server triggers a dedicated wrap-up call:

1. The server appends a one-time, non-stored system note to the conversation and sends one extra model request (does not count toward the iteration limit):

```
[System: You have reached the iteration limit. This is your final response for this run.
Respond with your normal JSON, but add a checkpoint field:

{
  "response": "Brief message to the user that the task is still in progress.",
  "logSummary": "Human-readable summary of what happened in this run.",
  "checkpoint": {
    "progress": "What has been fully completed so far.",
    "remaining": "What still needs to be done to finish the task.",
    "failedApproaches": "Comma-separated list of approaches already tried that did not work.",
    "state": { "key": "value" }
  }
}

The checkpoint field will be used to automatically resume the task in the next run.]
```

The checkpoint object has four fields:

- `progress` — what has been fully completed so far.
- `remaining` — what still needs to be done to finish the task. The server uses this as the starting prompt for the next run.
- `failedApproaches` — a record of approaches already attempted that did not work, so the next run does not repeat them. This is preserved in `session.metadata` and injected into each subsequent resume prompt.
- `state` — a flat key-value JSON object for concrete facts confirmed by tool output (file paths, binary locations, config values, etc.). It is merged into `session.metadata.checkpointState` across handoffs and injected as known facts into the next resume prompt, so the agent does not need to re-discover information it already found.

2. The server reads `checkpoint.remaining` from the response and uses it as the starting prompt for a fresh agent run.
3. The server marks the run status as `checkpoint_reached`.

- **Handoff Cap**: To prevent infinite autonomous loops, the server tracks consecutive handoffs in the session `metadata`. If `handoffCount` exceeds `maxHandoffs` (default 5), the server stops and marks the status as `intervention_required` instead of starting a new run.
- **Handoff Reset**: `handoffCount` resets to `0` whenever the server receives a new user message for that session, since this implies human review.

**Completion Logic**: The agent stops when the model returns a final text response instead of tool calls. This response is then returned to the client as the final answer.

Tool calls use the provider tool-calling API for reliability. The final user-facing response is structured JSON so we can store a human-readable summary without an extra call.

Notes:

- The loop is bounded (default 10 iterations) to avoid runaway behavior and context bloat.
- If a tool fails, its error is recorded and the model still receives the error result.

## Triggering and Execution

Jarvis runs only when explicitly triggered. In v1, a run starts when a user sends a message to the `POST /api/chat` endpoint. Each user message creates a single agent run:

1. Receive the user message and `sessionId`.
2. **Session Lookup**: Load the full conversation history for the `sessionId` from `~/.jarvis/data/conversations/<sessionId>.json`. If the session doesn't exist, initialize a new history with the system prompt.
3. **User Info Injection**: Before sending to the model, replace the `{{user_info}}` placeholder in the system prompt with the current contents of `user-info.json`. If no user info exists, replace with `(none yet)`. This resolved system prompt is sent to the model but never written back to disk — the placeholder is always preserved in the stored history.
4. **Append Message**: Append the new user message to the loaded history.
5. **Execute Core Loop**: Run the agent loop using the full conversation history.
6. **Return Response**: Return the final response and log the summary.
7. **Persistence**: Save the updated history (including any tool calls/results) back to disk.

There are no automatic background runs unless we add a scheduler later.

## Entry Points (v1)

Jarvis accepts messages only via HTTP:

- `POST /api/chat` with a JSON body

Port: `18008` (default)

Request contract (v1):

```json
{
  "sessionId": "string (optional)",
  "message": "string"
}
```

**Notes on Request**:
- The client sends only the **latest** message.
- The server is responsible for maintaining and loading the full history via the `sessionId`.
- `sessionId` is optional. If omitted, the server creates a new session and generates a UUID v4 session ID via `crypto.randomUUID()`.
- If a `sessionId` is provided, the server loads the existing session. If no session is found for that ID, a new one is created.

Response contract (v1):

```json
{
  "sessionId": "string",
  "response": "string",
  "logSummary": "string",
  "toolCalls": [
    {
      "name": "string",
      "args": {},
      "status": "ok | error",
      "result": "string"
    }
  ]
}
```

`toolCalls` is an array of all tool calls made during the run, in execution order. It is always present (empty array if no tools were called). The data is already collected during the agent loop for JSONL logging, so this adds no extra work.

The `sessionId` is always returned so the client can use it for follow-up messages. On the first message (no `sessionId` sent), the client must read this value and store it to continue the session.

**Channel adapter pattern**: External channels (e.g. a Telegram bot) act as thin adapters. They store a mapping of their own identifier (e.g. Telegram `chat_id`) to a Jarvis `sessionId`. On the first message they omit `sessionId` and store the one returned; on subsequent messages they pass it through. This keeps session management centralized on the server — no adapter needs to implement its own ID generation or session logic.

Error responses:

- `400 Bad Request` for invalid input
- `500 Internal Server Error` for runtime failures

```json
{
  "error": "string",
  "status": "model_error | format_error | tool_failed"
}
```

Interaction flow:

1. Client sends `POST /api/chat` with an optional `sessionId` and a `message`.
2. Server creates or loads the session, then runs the agent loop.
3. Server returns `sessionId`, `response`, and `logSummary` as JSON.
4. Server appends a JSONL log entry for the run.

## System Prompt (v1)

The authoritative system prompt text lives in [docs/system-prompt.md](./system-prompt.md). It is sent as the first message (`role: "system"`) in every session and stored verbatim in the conversation history.

Four placeholders are injected at runtime before the system prompt is sent to the model — none of them are ever written back to disk or stored in conversation history:

- `{{identity}}` — replaced with the full contents of `~/.jarvis/data/identity.md`. This is freeform text that describes the agent's persona and behavior.
- `{{skills}}` — replaced with a rendered list of available skills (name + description) loaded from `~/.jarvis/data/skills/`. This lets the model know which skills exist and what they do without embedding full skill content in every request.
- `{{session_id}}` — replaced with the current session UUID.
- `{{user_info}}` — replaced with the current contents of `user-info.json`. If no user info exists, replaced with `(none yet)`.

## Tools

All tools — built-in and user-defined — live in a single registry file (`tools.json`) and are executed via the same `new Function()` path. There is no separate execution mechanism for built-ins.

**Built-in tools** (seeded into `tools.json` on first server start if missing):

- `list_dir` — lists directory contents (ls -la)
- `exec` — runs arbitrary shell commands; 5-minute timeout
- `write_file` — writes a file directly via fs.promises.writeFile, bypassing shell escaping; supports optional `mode` parameter for executable scripts
- `save_user_info` — persists user facts to `user-info.json`
- `read_user_info` — returns all stored user facts
- `get_recent_sessions` — returns the most recent sessions
- `read_session_log` — returns JSONL log entries for a given session
- `npm_install` — installs an npm package into the jarvis project directory
- `system_install` — installs a system binary via brew/apt-get/snap; 5-minute timeout
- `perplexity_search` — web search via Perplexity AI
- `read_skill` — reads the full content of a skill by name from `~/.jarvis/data/skills/<name>/skill.md`
- `get_current_time` — returns current server time; used before scheduling crons with relative times
- `create_cron` — creates a scheduled cron job and writes to `crons.json`; activates immediately without restart
- `list_crons` — lists all scheduled cron jobs
- `delete_cron` — removes a cron job by name or id
- `send_telegram_message` — sends a proactive message to the Telegram user; used inside cron prompts
- `read_cron_log` — reads the JSONL execution log for a given cron id

If a built-in entry is missing from `tools.json` at startup, the server re-seeds it from its default definition. This means built-ins can be inspected and edited in place, and will be restored if accidentally deleted.

Tools are powerful (file access, network, shell) and run with the same permissions as the server.

## Tool Registry Format

Jarvis uses the same simple tool registry pattern as dai: a JSON file that maps tool names to `definition` and `code`.

Path:

- `~/.jarvis/data/tools/tools.json`

Schema example:

```json
{
  "read_user_info": {
    "definition": {
      "type": "function",
      "function": {
        "name": "read_user_info",
        "description": "Read all stored user facts.",
        "parameters": { "type": "object", "properties": {}, "required": [] }
      }
    },
    "code": "const raw = await fs.promises.readFile(path.join(process.env.HOME, '.jarvis/data/user-info.json'), 'utf8').catch(() => '{\"items\":[]}'); const { items } = JSON.parse(raw); return { status: 'ok', items };"
  }
}
```

At runtime, the server loads each tool and compiles `code` into an async function using `new Function('args', 'fs', 'path', 'process', 'require', code)`, called as `fn(args, fs, path, process, require)`.

**Tool descriptions are critical.** The system prompt does not list available tools — the model discovers them exclusively via the `tools` field in each API request. The `description` field in every tool definition is therefore the only guidance the model has for deciding when and how to use a tool. Descriptions must be specific about the tool's purpose, when to call it, and what its output means.

**Concurrency**: The server supports concurrent sessions. While tools are executed serially *within* a single run, multiple sessions can be processed in parallel by the server.

Seed tool included for sanity checks:

- `list_dir`
  - Purpose: list directory contents similar to `ls -la`
  - Input: `{ "path": "." }` (optional; defaults to current working directory)
  - Output should include the resolved path that was actually listed

## Tool Call Contract

Jarvis uses the provider tool-calling API:

1. The model returns an assistant message containing a `tool_calls` array.
2. Jarvis normalizes each tool call before appending to the conversation history: if `function.arguments` is missing or empty, it is set to `"{}"`. Some models (especially smaller/free ones) omit `arguments` for no-arg tools. Storing a malformed tool call would cause the next API request to fail with a 400 validation error.
3. Jarvis executes those tools in order, serially.
4. Each tool result is appended to the conversation as a `role: "tool"` message with a matching `tool_call_id`.
5. Jarvis calls the model again with the updated conversation.
6. When no tool calls are returned, the model must respond with JSON `{ response, logSummary }`.

Assistant message shape (appended to history when the model requests tools):

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "tool_name",
        "arguments": "{\"key\":\"value\"}"
      }
    }
  ]
}
```

Tool result message shape (appended to history after execution):

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"status\":\"ok\",\"result\":\"...\"}"
}
```

The `tool_call_id` in the tool message must match the `id` of the corresponding entry in the assistant's `tool_calls` array. Without this pairing, the provider will reject the request.

## Tool Argument Validation

Jarvis does not validate tool arguments against schemas in v1. Tool code receives the raw args and is responsible for handling missing or invalid inputs.

## Exec Tool

`exec` runs a shell command as the server user with no safeguards.

Input:

```json
{ "cmd": "string" }
```

Output (stringified JSON in tool message content):

```json
{
  "status": "ok" | "error",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "..."
}
```

## Conversation Storage

Full conversation history is stored per session ID so the agent can keep context across messages. This is separate from the human log.

Path:

- `~/.jarvis/data/conversations/<sessionId>.json`

To support persistent tracking (like `handoffCount`), each file contains a JSON object with `metadata` and an ordered list of `messages`:

```json
{
  "metadata": {
    "handoffCount": 0,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "What do you know about me?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": { "name": "read_user_info", "arguments": "{}" }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"status\":\"ok\",\"items\":[]}"
    },
    {
      "role": "assistant",
      "content": "{\"response\":\"...\",\"logSummary\":\"...\"}"
    }
  ]
}
```

The system prompt is stored as the first message in the `messages` array. The full turn sequence — user → assistant (with tool_calls) → tool → assistant (final) — is stored verbatim so that subsequent requests can be sent to the provider without any transformation.

## Sliding Window

`prepareMessages()` applies a sliding window before every model call: it always includes the system prompt (`messages[0]`) plus the most recent `contextWindow` messages (default 100, configurable via `settings.json`). The full message history is always preserved on disk — only what is sent to the model is trimmed. This prevents context overflow on long sessions without losing data.

## Provider Message Format

When sending the conversation to OpenRouter, messages must follow the OpenAI-compatible chat format.

Example tool-call flow:

**Step 1 — Initial request:**

```json
{
  "model": "openrouter/model-name",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "What do you know about me?" }
  ]
}
```

**Step 2 — Provider response (contains tool call):**

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "read_user_info",
        "arguments": "{}"
      }
    }
  ]
}
```

**Step 3 — Follow-up request (after tool execution):**

Jarvis appends the assistant message from Step 2 and then the tool result to the history and sends:

```json
{
  "model": "openrouter/model-name",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "What do you know about me?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": { "name": "read_user_info", "arguments": "{}" }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"status\":\"ok\",\"items\":[{\"key\":\"timezone\",\"value\":\"Europe/Berlin\"}]}"
    }
  ]
}
```

**Step 4 — Final model response (JSON):**

```json
{
  "response": "I know your timezone is Europe/Berlin.",
  "logSummary": "Read user info and reported timezone."
}
```

Internal flow summary:

1. Send request to provider.
2. Receive assistant message — if it contains `tool_calls`, append it to the conversation history.
3. Execute tool calls locally, in order.
4. Append each tool result as a `role: "tool"` message with matching `tool_call_id`.
5. Call the model again with the updated conversation.
6. Repeat until no tool calls are returned.

## Anthropic Provider

When `config.provider === 'anthropic'`, Jarvis uses the Anthropic SDK directly instead of OpenRouter. `src/server/provider.js` exposes an adapter that converts the OpenAI-compatible interface used throughout the codebase into Anthropic's native API format.

### Message Format Conversion

Key differences from OpenAI format:

- The `system` message is extracted from `messages[0]` and passed as a separate top-level `system` parameter (array form, to support `cache_control`).
- Assistant `tool_calls` are converted to `content` blocks of type `tool_use`.
- `role: "tool"` messages are grouped into `role: "user"` messages containing `tool_result` blocks.
- Consecutive `user` messages are merged (Anthropic requires strict user/assistant alternation).

### Prompt Caching

Jarvis enables Anthropic prompt caching to reduce cost and latency on repeated turns. The `extended-cache-ttl-2025-01-13` beta header is sent on every Anthropic request, upgrading the cache TTL from 5 minutes to **1 hour**.

Two cache breakpoints are set per request:

1. **System prompt** — the full system prompt (with `{{user_info}}` already injected) is sent as an array with `cache_control: { type: "ephemeral" }`. This is the largest static block and benefits most from caching.

2. **Tools array** — `cache_control: { type: "ephemeral" }` is added to the last tool definition. Anthropic caches everything up to and including the marked entry, so the entire tools array is cached as a unit.

Cache behaviour:
- On the first request (cold cache), tokens are processed normally and a cache entry is written.
- On subsequent requests within 1 hour, the cached prefix is reused — approximately 90% cost reduction and 85% latency reduction on the cached tokens.
- The cache TTL resets on each hit, so active conversations stay warm indefinitely as long as turns arrive within 1 hour of each other.
- If the tools array changes between turns (e.g. a new tool was saved), the cache is automatically invalidated because the content differs.

### Auth

Two auth paths are supported, detected by key prefix:

- `sk-ant-oat*` (OAuth token from `claude setup-token`): uses `authToken` (→ `Authorization: Bearer`) + `anthropic-beta: oauth-2025-04-20,extended-cache-ttl-2025-01-13`
- All other keys (standard API key): uses `apiKey` (→ `x-api-key`) + `anthropic-beta: extended-cache-ttl-2025-01-13`

### Cache Usage Tracking

The Anthropic API returns cache stats in the response `usage` object:

- `cache_read_input_tokens` — tokens served from cache (cheap)
- `cache_creation_input_tokens` — tokens written to cache (slightly more expensive than normal input)

These are accumulated alongside `prompt_tokens` and `completion_tokens` in `usageAccum` and persisted to `session.metadata.tokenUsage` as `cacheRead` and `cacheCreation`. The Telegram `/usage` command displays them when non-zero.

## Logging

We store a minimal, append-only JSONL log per session for human readability. Each line is one request/response cycle.

Path:

- `~/.jarvis/logs/session-<sessionId>.jsonl`

Each log entry includes only the essentials (no full message history). The model provides a concise `logSummary` alongside the user-facing response.

**Logging Philosophy**:
- **Transparency**: The `logSummary` must be written for a *human observer*. It should explain not just what tools were called, but the reasoning behind them.
- **Understandability**: A developer should be able to follow the agent's intent and identify where a plan went off-track just by reading the `logSummary` entries.

```json
{
  "ts": "2026-02-13T12:34:56.789Z",
  "sessionId": "abc123",
  "iteration": 1,
  "model": "openrouter/model-name",
  "userInput": "...",
  "toolCalls": [
    {
      "name": "tool_name",
      "args": { "key": "value" },
      "status": "ok",
      "result": "..."
    }
  ],
  "response": "...",
  "logSummary": "...",
  "status": "ok"
}
```

Status values:

- `ok`: normal completion
- `tool_failed`: at least one tool failed
- `model_error`: model request failed
- `checkpoint_reached`: max iterations hit; task handed off or paused
- `intervention_required`: max handoffs reached; human input needed to proceed
- `format_error`: malformed JSON response

This log is meant to be readable without digging through raw prompts.

Tool inputs/outputs:

- `read_session_log`
  - Input: `{ "sessionId": "string", "limit": 20 }`
  - Output: `{ "status": "ok", "entries": [...] }`

## Error Handling and Retries

- Model call failures: try the selected model once, then one fallback model attempt. If both fail, end the run with a `500` error and a clear message.
- Tool failures: pass the error result back to the model and continue the loop. Best case would be that the next model response include another tool call to fix the previous tool call. All tool errors (especially `exec` failures) must be reported in the `logSummary` with enough detail for a human to understand the cause.
- Malformed JSON on final response: attempt two recovery steps before giving up:
  1. **Fallback model retry** — call the fallback model with the same conversation messages (the bad response is not saved to the session yet). If this produces valid JSON, use it and continue normally.
  2. **Nudge retry** — if the fallback model also returns non-JSON, append a temporary nudge message to the conversation (not saved to the session) and call `callModelWithFallback` once more:
     ```
     Your previous response was not valid JSON. Respond only with the required JSON object: {"response": "...", "logSummary": "..."}
     ```
  3. **Give up** — if all three attempts fail, return `format_error` without pushing any assistant content to the session. The nudge message is never persisted regardless of outcome.

**Error Payload Structure**:

```json
{
  "error": "Short, human-readable description of the error",
  "details": "Optional stack trace or additional context"
}
```

- Use `400 Bad Request` for invalid client inputs.
- Use `500 Internal Server Error` for API failures, tool runtime errors, or model communication issues.
- Always append a log entry on failure so the outcome is visible in the session log.

**Synthetic error note on failure**: when a run ends with `model_error` or `format_error`, a synthetic assistant message is appended to the session before saving:

```
[System: Previous run failed (model_error): <logSummary>. Error detail: <errorDetail JSON>]
```

The full `errorDetail` (provider error body, HTTP status, etc.) is included so the model has enough information to understand and potentially recover from the failure without needing to call `read_session_log`. Without this, the session would contain a dangling user message with no reply, and the model would have no way to understand or recover from the failure.

Model configuration:

- Selected model ID is stored in the same config file created during setup.
- If the first model call fails, retry once using `fallbackModel`.

Config file:

- `~/.jarvis/data/config/settings.json`

Schema:

```json
{
  "selectedModel": "openrouter/...",
  "fallbackModel": "openrouter/free"
}
```

## Limits and Timeouts

- Max iterations per run: 10 (default).
- `checkpoint_reached` status is used when the limit is hit to trigger a handoff.
- **Handoff Safety**: `maxHandoffs` (default 5) limits the number of autonomous restarts for a single user trigger. If reached, status changes to `intervention_required`.
- No separate wall-clock timeout in v1; iterations are the only limiter.
- No additional per-run tool-call cap beyond iterations.
- No token limit enforcement in v1.

### Two-Level Tool Timeout Architecture

Every tool execution is governed by two independent timeout layers:

**Layer 1 — Outer wrapper** (`executeTool` in `src/server/tools.js`):
```js
const timeoutMs = tool.timeout || TOOL_TIMEOUT_MS;  // TOOL_TIMEOUT_MS = 60_000
return await Promise.race([fn(toolArgs, ...), timeout]);
```
This is the hard cap. `tool.timeout` is a top-level property on the tool registry entry (not inside `definition` or `code`). `exec` has `timeout: 300_000` (5 minutes); `system_install` also has 5 minutes; all other tools default to 60s.

**Layer 2 — Inner timeout** (inside the tool's `code`): e.g. `execAsync(cmd, { timeout: 270000 })`. Should be slightly shorter than Layer 1 to ensure a clean error from the inner call rather than a hard kill from the outer wrapper.

**Declaring a custom timeout on a tool** (via `save_tool`): pass the optional `timeout` parameter (in ms, capped at 600,000). This writes the top-level `timeout` property to the tool entry in `tools.json`.

**Important**: Modifying a seed tool's code via `save_tool` does NOT change its outer timeout — seed tools are restored to their original definition on server restart via `seedTools()`.

## User Info

User info is stored as a small JSON file in the Jarvis data directory: `~/.jarvis/data/user-info.json`. `save_user_info` appends to the collection, and `read_user_info` returns the full set.

Schema:

```json
{
  "items": [
    { "key": "string", "value": "string", "ts": "2026-02-13T12:34:56.789Z" }
  ]
}
```

Tool inputs/outputs:

- `save_user_info`
  - Input: `{ "items": [{ "key": "string", "value": "string" }] }`
  - Behavior: overwrite existing items with the same `key` and update `ts`.
  - Output: `{ "status": "ok", "saved": <number> }`

- `read_user_info`
  - Input: `{}`
  - Output: `{ "status": "ok", "items": [...] }`

## Session Titles

Session titles are derived from the first `logSummary` in the session log, truncated for display. `get_recent_sessions` should return these titles alongside session IDs to keep results human-readable.

Tool inputs/outputs:

- `get_recent_sessions`
  - Input: `{ "limit": 2 }`
  - Output: `{ "status": "ok", "sessions": [{ "sessionId": "...", "title": "...", "lastTs": "..." }] }`

## See Also

- [docs/system-prompt.md](./system-prompt.md) — the authoritative system prompt text
- [docs/identity.md](./identity.md) — the agent's persona and identity configuration (`~/.jarvis/data/identity.md`)
- [docs/skills.md](./skills.md) — the skills system (per-skill `skill.md` files, how they are listed and read)
- [docs/crons.md](./crons.md) — the cron scheduler (job format, `crons.json`, execution loop, logging)
