# Setup and Start

This document is the implementation spec for how Jarvis is configured and started.
Another LLM should be able to implement the CLI and startup behavior from this alone.

## Dependencies

Jarvis relies on the following key libraries:

- `commander`: CLI framework for handling commands and arguments.
- `pm2`: For process management and daemonization of the Jarvis server.
- `dotenv`: To load environment variables from `.env`.
- `openai`: Official SDK for interacting with the OpenRouter (OpenAI-compatible) API.
- `inquirer`: For interactive CLI prompts during onboarding.
- `chalk`: For terminal styling and colored output.

## Commands

### `jarvis setup` (interactive onboarding)

Purpose: collect API key and model selection and persist them on disk.

Behavior:

1. API key step
   - Read existing `.env` from the Jarvis config directory (see Data Layout).
   - If `OPENROUTER_API_KEY` exists, prompt to keep or replace.
   - If missing, prompt for a new key (password input, min length 10).
   - Write/update `OPENROUTER_API_KEY=...` in `.env`.

2. Model selection step
   - Read current model from `data/config/settings.json` under key `selectedModel`.
   - If a model exists, prompt to keep or change it.
   - If changing, offer two paths:
     - Manual entry of model ID.
     - Browse models from OpenRouter:
       - Fetch `https://openrouter.ai/api/v1/models` with Bearer auth.
       - Sort models with free models first, then alphabetical.
       - Show a paginated list (page size ~20).

- Persist the chosen model as `selectedModel` in `data/config/settings.json`.
- Set `fallbackModel` to `openrouter/free` only if it is not set yet.

Notes:

- The setup command can be run as many times as desired.
- The setup command must be usable even if the server is not running.
- For local development without a global install, run the setup script directly
  (example: `npm run setup` in the server directory).

## Data Layout

Jarvis data is always stored in the user home directory and never in the repo.
There is no environment variable override for this path.

Base directory:

- `~/.jarvis/`

Within this directory:

- `.env` (OpenRouter API key)
- `data/`
  - `config/settings.json`:
    ```json
    {
      "selectedModel": "openrouter/anthropic/claude-3.5-sonnet",
      "fallbackModel": "openrouter/free",
      "maxIterations": 10,
      "maxHandoffs": 5,
      "port": 18008
    }
    ```
  - `conversations/` — per-session conversation history
  - `tools/tools.json` — seed and custom tool definitions
  - `user-info.json` — key-value facts about the user (written by `save_user_info` tool)
- `logs/`
  - `server.log` — PM2 stdout/stderr (process-level log)
  - `session-<id>.jsonl` — structured per-session JSONL logs written by the agent

## Telegram Channel Setup (Optional)

At the end of `jarvis setup`, after the model selection step, the user is asked whether they want to configure the Telegram channel:

```
Do you want to configure the Telegram channel? (y/N)
```

If yes:

1. Bot token step
   - Check if `TELEGRAM_BOT_TOKEN` already exists in `.env`.
   - If it exists, prompt to keep or replace.
   - If missing, prompt for a new token (password input).
   - Write/update `TELEGRAM_BOT_TOKEN=...` in `.env`.

2. Allowed user IDs step
   - Read current value from `channels.telegram.allowedUserIds` in `settings.json`.
   - If values exist, show them and prompt to keep or replace.
   - If missing, prompt for one or more Telegram user IDs (comma-separated input, parsed as integers).
   - Write to `channels.telegram.allowedUserIds` in `settings.json`.

If the user answers no, the Telegram step is skipped entirely and the existing channel config (if any) is left unchanged.

## Post-Setup Restart

After `jarvis setup` completes (including the optional Telegram step), the CLI checks whether `jarvis-server` is currently running via PM2.

If the server is running, prompt:

```
Server is running. Restart now to apply changes? (Y/n)
```

- If yes (or Enter): restart the server using PM2 restart.
- If no: print a reminder — `Run \`jarvis stop && jarvis start\` when ready to apply changes.`

If the server is not running, no prompt is shown.

## First Run Flow

1. User installs Jarvis globally.
2. User runs `jarvis setup` to configure API key, model, and optionally the Telegram channel.
3. User runs `jarvis start` to launch the background server.
