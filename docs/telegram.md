# Telegram Channel

This document specifies the Telegram channel adapter for Jarvis. It is intended as the implementation source of truth.

## Goals

- Thin adapter — no agent logic lives here; all intelligence is in the existing agent layer
- Long-polling via grammy-runner for reliable, concurrent update handling
- Session continuity — each Telegram user resumes the same Jarvis session across messages
- Runs inside the `jarvis-server` process — no second process or PM2 entry needed
- Allowlist-based access — only messages from configured user IDs are processed

## Architecture

The Telegram channel starts as part of the Jarvis server process. When the server boots, it checks if `TELEGRAM_BOT_TOKEN` is set in `.env`. If present, it initializes the bot and starts long polling alongside the Express server.

The channel calls the agent layer directly (no HTTP hop) — it imports and calls the same internal function that the HTTP handler uses. The `chat_id → sessionId` mapping is maintained by the channel and passed into the agent call the same way the HTTP handler passes a `sessionId`.

```
Telegram user
    ↓ (text or photo message)
Telegram Bot API  ←→  grammy-runner (long polling)
    ↓
Channel adapter (src/channels/telegram/index.js)
    ↓ direct function call
Agent layer (src/server/agent.js)
    ↓
Channel adapter
    ↓ sendMessage
Telegram user
```

## Dependencies

- `grammy` — Telegram bot framework
- `@grammyjs/runner` — concurrent long polling runner

These are added to the root `package.json`.

## File Layout

```
src/channels/telegram/
├── index.js        — bot setup, allowlist guard, message handler, polling start
└── sessions.js     — chat_id → sessionId mapping (load/save)
```

Persistent state:

```
~/.jarvis/data/channels/telegram/sessions.json
```

## Configuration

**Bot token** — stored in `~/.jarvis/.env` (it is a secret):

```
TELEGRAM_BOT_TOKEN=<token from BotFather>
```

**Allowed user IDs** — stored in `~/.jarvis/data/config/settings.json` (it is config):

```json
{
  "selectedModel": "...",
  "channels": {
    "telegram": {
      "allowedUserIds": [123456789]
    }
  }
}
```

If `TELEGRAM_BOT_TOKEN` is absent from `.env` at server startup, the Telegram channel is silently skipped — the server starts normally without it.

## Allowlist Guard

Every incoming message is checked against `allowedUserIds` before any processing occurs. The check uses `ctx.from.id` (the sender's Telegram user ID).

- If the sender is on the allowlist: process the message normally.
- If the sender is not on the allowlist: silently ignore — no reply, no log entry. This avoids confirming that the bot exists and is active.

## Session Mapping

Each Telegram `chat_id` (a number) maps to a Jarvis `sessionId` (a UUID string). The mapping persists to disk so sessions survive process restarts.

Path:

```
~/.jarvis/data/channels/telegram/sessions.json
```

Schema:

```json
{
  "12345678": "550e8400-e29b-41d4-a716-446655440000"
}
```

`sessions.js` exposes:

- `load()` — read the file from disk; returns an empty object if missing
- `save(map)` — write the full map to disk (creates parent directories if needed)

The map is loaded once at startup and held in memory. It is written to disk after every new session is created (i.e. after the first message from a new user).

## Message Handler

On each incoming Telegram text message:

1. Check `ctx.from.id` against `allowedUserIds` — silently drop if not allowed
2. Read `chat_id` from `ctx.chat.id`
3. Look up `sessionId` in the in-memory map (may be `undefined` for new users)
4. Start a typing indicator interval (see below)
5. Call the agent function directly with `{ sessionId, message: ctx.message.text }`
6. If this was the first message (`sessionId` was `undefined`), store the returned `sessionId` in the map and save to disk
7. Send `response` back to the user via `ctx.reply(response)`
8. Clear the typing indicator interval

On any error during the agent call, clear the interval and reply with:

```
Sorry, something went wrong. Please try again.
```

## Typing Indicator

Telegram's `sendChatAction('typing')` shows a "typing…" indicator in the chat, but it expires after **5 seconds**. A single call before the agent runs is not sufficient — the agent can take well over 5 seconds when tool use or multiple handoffs are involved.

The solution is to send the action once immediately, then repeat it on a 4-second interval while the agent is running. The interval fires just under the 5-second expiry so the indicator stays alive continuously. The interval is always cleared in a `finally` block to avoid leaking it on errors.

```js
await ctx.api.sendChatAction(chatId, 'typing');
const typingInterval = setInterval(() => {
  ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
}, 4000);

try {
  const result = await handleChat(...);
  // ...
} finally {
  clearInterval(typingInterval);
}
```

Errors on the interval call are silently swallowed (`.catch(() => {})`) — a failed heartbeat should never abort the agent run.

## Long Polling with grammy-runner

Use `run(bot)` from `@grammyjs/runner` instead of `bot.start()`. The runner fetches updates concurrently and processes them with a default concurrency level.

```js
import { Bot } from 'grammy'
import { run } from '@grammyjs/runner'

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)

bot.on('message:text', async (ctx) => { /* ... */ })

run(bot)
```

The runner handles graceful shutdown on `SIGINT`/`SIGTERM` automatically. The server's existing shutdown logic does not need to change.

## Server Integration

The Telegram channel is initialized from the server entry point after the Express server is ready:

```js
// src/server/app.js (or equivalent entry point)
import { startTelegramChannel } from '../channels/telegram/index.js'

// after app.listen(...)
startTelegramChannel()
```

`startTelegramChannel()` checks for `TELEGRAM_BOT_TOKEN` and exits silently if it is not set. No error is thrown.

## CLI Integration

The Telegram channel is configured as an optional step inside `jarvis setup` — there is no separate command. The full setup flow is specified in [docs/setup.md](./setup.md). After setup completes, the CLI offers to restart the server automatically.

## Logging

Log lines use a simple prefix format, written to stdout (captured by PM2 alongside server logs in `~/.jarvis/logs/`):

```
[telegram] channel started
[telegram] incoming chat_id=12345678
[telegram] session resolved sessionId=550e8400
[telegram] response sent chat_id=12345678
[telegram] error chat_id=12345678: <error message>
```

No JSONL session logging — that is handled by the agent layer for every run.

## Proactive Notifications

The Telegram channel supports proactive outbound messages initiated by the agent, not by the user. This is used by the cron system.

**`send_telegram_message` tool**: any agent run (including cron runs) can call this tool to send a message directly to the configured Telegram user. The tool reads the bot token from `TELEGRAM_BOT_TOKEN` and the chat_id from `settings.json channels.telegram.allowedUserIds[0]`. For private Telegram chats, `chat_id === user_id`.

**Synthetic cron messages**: after a cron run completes, the cron runner appends a synthetic assistant message to the user's normal Telegram session so the agent has context if the user replies:

```
[Cron "backup-nightly" | 2026-03-11 03:00] Backup completed successfully. 2.3GB written to /backups/xyz.
```

This uses the session queue (`withSessionLock`) to avoid race conditions if the user is chatting simultaneously.

## Commands

### `/new` — Start a fresh session

Sending `/new` resets the conversation. The `chat_id → sessionId` mapping for the sender is removed from the in-memory map and from `sessions.json` on disk. The underlying session file is left on disk (not deleted) — it is simply unlinked from the Telegram chat.

The next text message after `/new` will create a new session as if the user were messaging for the first time.

### `/usage` — Show token usage

Sending `/usage` displays the token usage for the current session. Shows input tokens, output tokens, total, and (if non-zero) Anthropic prompt cache read/write tokens. If no session exists or no tokens have been recorded yet, a short message is shown instead.

**Command registration**

Commands are registered with the Telegram Bot API at startup via `bot.api.setMyCommands()`. This makes them visible to users in two places:

- The autocomplete menu that appears when the user types `/` in the chat input
- The `⌘` menu button next to the chat input field

Without registration the command still works if typed manually, but users would not see it suggested. Registration is idempotent — calling `setMyCommands()` on every startup is safe.

```js
await bot.api.setMyCommands([
  { command: 'new', description: 'Start a fresh session' },
  { command: 'usage', description: 'Show token usage for this session' },
]);
```

**Behavior summary**

| State | What happens |
|---|---|
| User sends `/new`, has an existing session | Session unlinked, confirmation sent: "New session started." |
| User sends `/new`, no session exists yet | No-op, same confirmation sent |
| Next text message after `/new` | New session created, mapped to `chat_id` |

## Photo Support

The bot handles incoming photos (`message:photo`) in addition to text. When a user sends a photo, the adapter selects the best resolution under 800px wide to keep token usage reasonable.

### Photo selection

Telegram always delivers multiple resolutions of every photo as an array of `PhotoSize` objects, sorted ascending by resolution. The adapter picks the last entry with `width <= 800`:

```js
const photo = ctx.message.photo.filter(p => p.width <= 800).at(-1)
  ?? ctx.message.photo[0]; // fallback: smallest if all variants exceed 800px
```

This gives the highest quality image below the 800px threshold. Sending the full-resolution original would consume significantly more tokens for no practical benefit in most tasks.

### Download and base64 encoding

The image is downloaded immediately at receive time using the Telegram file URL (`https://api.telegram.org/file/bot<token>/<file_path>`) and converted to a base64 data URL (`data:image/jpeg;base64,...`). The data URL is stored directly in the session message, so the image remains available across handoffs and future conversation turns without depending on a Telegram URL that would expire after ~1 hour. Base64 encoding does not cost more tokens than a URL — image token cost is based on pixel dimensions, not transport format.

### Image processing paths

How the image reaches the model depends on whether a dedicated vision model is configured:

**Path 1 — `visionModel` configured** (`settings.json: visionProvider + visionModel`):
Before the main agent call, the adapter calls `describeImage()` — a separate, one-shot API call to the vision model. The result (a text description of the image) is injected into the user turn as plain text. The main agent never sees the image itself; it only sees the description. This allows a cheap non-multimodal main model to handle image conversations.

**Path 2 — No `visionModel`, multimodal main model**:
The base64 data URL is passed directly to the main model as an `image_url` content block alongside any caption. The model processes the image natively.

```js
const content = [
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
  { type: 'text', text: caption },
];
```

**Fallback — model rejects image input**:
If the main model returns an error indicating it does not support image input (`isImageUnsupportedError`), the agent responds with a clear message ("This model does not support image input…") and strips the image from the session so subsequent messages are not permanently broken. A text placeholder is inserted in its place so the model retains context.

### Caption

If the user attaches a caption to the photo (`ctx.message.caption`), it is included alongside the image (as a text block in multimodal mode, or appended to the vision description in Path 1). If there is no caption, only the image content is sent.

### Unsupported incoming media types

Documents, audio files, video, stickers, and other non-photo non-voice media types sent by the user are not handled — the bot silently ignores them.

## Outgoing Files

The agent can send files from the server to the Telegram chat using the `send_file` seed tool. This complements the text-only `send_telegram_message` tool for cases where the agent has produced or located a file the user needs.

### Tool interface

```js
send_file({ path: '/absolute/or/~/path/to/file', caption: 'Optional caption' })
```

The tool resolves `~` to the home directory, checks that the file exists, and calls the channel-provided `sendFile` callback. It returns `{ status: 'error', error: '...' }` if the file is not found or the channel does not support file sending.

### Channel integration

The Telegram adapter passes an `onSendFile` callback to `handleChat`:

```js
handleChat(config, sessionId, userText, attachments, onCheckpoint, async (filePath, caption) => {
  await api.sendDocument(chatId, new InputFile(filePath), caption ? { caption } : {});
});
```

`InputFile(filePath)` streams the file from disk — no in-memory buffering of the full file. The callback is threaded through `handleChat → _runHandleChat → runAgentLoop → executeTool` and injected into the tool's `AsyncFunction` as the `sendFile` parameter.

### Channel support

`send_file` only works in channels that register an `onSendFile` callback (currently: Telegram). In other contexts (web UI, cron runs), the tool returns an error immediately rather than silently succeeding.

## Non-Goals (v1)

- No support for receiving documents, audio files, video, or other non-photo non-voice media from the user
- No inline keyboards or callback queries
- No group chat support (only private chats)
- No message editing or deletion handling
