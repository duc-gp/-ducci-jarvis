# Jarvis

A self-hosted AI agent that runs as a background server. Chat with it via a web UI or Telegram, give it tools to run shell commands and manage files, and schedule recurring tasks — all powered by any model on OpenRouter, z.ai, or the Anthropic API.

## Features

- **Agent loop** — runs tools autonomously, hands off to a fresh context when it hits the iteration limit, and keeps going until the task is done
- **Web UI** — built-in chat interface served at `http://localhost:18008`
- **Telegram** — optional channel adapter; chat from your phone, send photos, get proactive notifications
- **Cron scheduler** — schedule recurring or one-time tasks in plain English; agent runs them autonomously and can notify you via Telegram
- **Skills** — Markdown-defined workflows the agent discovers and follows for specific task types
- **Custom tools** — define tools in JSON (name, description, JS code); the agent picks them up without a restart
- **Multi-provider** — OpenRouter, z.ai, or Anthropic directly (with prompt caching)
- **Persistent sessions** — full conversation history per session, sliding context window

## Quick start

```
npm i -g @ducci/jarvis
jarvis setup       # configure API key, model, and optionally Telegram
jarvis start       # start the background server (auto-restarts on crash)
```

Open `http://localhost:18008` to use the chat UI.

```
jarvis stop        # stop the server
jarvis status      # show PID, uptime, restart count
```

## Recommended models

Any OpenRouter model works, but here's what's worth trying right now:

| Model | Provider | Notes |
|---|---|---|
| `glm-5` | [z.ai](https://z.ai) directly | Personal pick — strong at coding and tool use, great value |

**z.ai tip**: z.ai offers a "Coding Plan Pro" subscription that gives you direct, high-rate access to GLM-5. If you do a lot of agentic coding tasks, it's worth it. Run `jarvis setup` and select z.ai as your provider — it will configure the endpoint and model automatically.

Fallback recommendation: set `fallbackModel` to `openrouter/auto` in `settings.json` so failed requests automatically retry on a capable free model.

## Docs

- [Setup and configuration](./docs/setup.md)
- [CLI and server lifecycle](./docs/cli.md)
- [Agent system](./docs/agent.md)
- [Telegram channel](./docs/telegram.md)
- [Cron scheduler](./docs/crons.md)
- [Skills](./docs/skills.md)
- [Identity and persona](./docs/identity.md)
- [UI](./docs/ui.md)

## Development

```
npm run dev        # start server with nodemon (auto-reload)
```

For UI hot-reload, run both the server and the Vite dev server:

```
npm run dev        # server on :18008
cd ui && npm install && npm run dev   # UI on :5173, proxies /api to :18008
```

Build the UI for production:

```
cd ui && npm run build   # outputs to ui/dist/, served automatically by the server
```

## Security

Jarvis is designed for **local or private server use only**. The API has no authentication — do not expose port `18008` to the public internet. The `exec` tool runs shell commands with the same permissions as the server process.

## Data

All runtime data lives in `~/.jarvis/` and is never stored in the repo:

- `~/.jarvis/.env` — API keys
- `~/.jarvis/data/config/settings.json` — model, port, channel config
- `~/.jarvis/data/conversations/` — session history
- `~/.jarvis/data/tools/tools.json` — tool registry
- `~/.jarvis/data/skills/` — skill definitions
- `~/.jarvis/logs/` — per-session JSONL logs, cron logs, PM2 stdout
