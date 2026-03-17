# UI

A minimal chat interface to interact with the Jarvis agent. The goal is function over form — just enough UI to send messages, read responses, and inspect tool calls.

## Stack

- Vite + React + Tailwind
- Lives in a `ui/` folder at the project root (separate from server code)

## Layout

Single page, three regions:

1. **Header** — app name ("Jarvis") on the left, "New Session" button on the right
2. **Message area** — scrollable list of messages, newest at the bottom
3. **Input area** — textarea + send button, pinned to the bottom

Light mode only. Minimal styling — no shadows, gradients, or animations.

## Message Types

**User message** — right-aligned, plain text.

**Assistant message** — left-aligned. Shows the `response` field from the API.

**Tool call block** — rendered inline inside the assistant turn, above the final response text. Each tool call shows:
- Tool name
- Args (JSON, collapsed by default)
- Status (`ok` or `error`)
- Result (truncated if long, expandable)

Tool call blocks use a monospace font and a light gray background to visually separate them from chat text.

## Session Management

- On load: no `sessionId` — the first message creates a new session
- After the first response: store the returned `sessionId` in React state and pass it on every subsequent request
- "New Session" button: clears messages and resets `sessionId` to null

## API Communication

All requests go to `POST /api/chat` on the same host/port.

Request:
```json
{ "sessionId": "string | null", "message": "string" }
```

Response fields used by the UI: `sessionId`, `response`, `toolCalls`.

`logSummary` is not displayed in the UI.

While waiting for a response, the input is disabled and a simple loading indicator is shown in the message area.

## Development

Vite dev server runs on its default port (5173) and proxies `/api` requests to `http://localhost:18008`. Configure this in `vite.config.js`:

```js
export default {
  server: {
    proxy: {
      '/api': 'http://localhost:18008'
    }
  }
}
```

## Production

The server serves the built UI (`ui/dist/`) as static files at `/`. The Express static middleware is added in `src/server/app.js`. No separate process needed.
