# CLI and Server Lifecycle

This document specifies the requirements for the `jarvis` CLI and its relationship with the Jarvis server.

## Architectural Separation

Jarvis consists of two distinct components:

1.  **The Server**: The core agent system that handles chat requests, triggers tools, and manages persistent memory.
2.  **The CLI**: A management tool used for configuration (onboarding) and controlling the server process.

## Global Installation Requirements

The project must be prepared for global installation via `npm i -g`. This requires the `package.json` to define appropriate `bin` entries:

```json
{
  "name": "jarvis",
  "bin": {
    "jarvis": "./src/index.js",
    "jarvis-setup": "./src/scripts/onboarding.js"
  }
}
```

## Server Lifecycle Commands

Lifecycle management is handled by the CLI using the **programmatic PM2 API** for process stability and fine-grained control.

### `jarvis start`
- **Pre-flight Check**: Verifies that `.env` and `settings.json` exist. If missing, it prints an error message ("Please run `jarvis setup` first") and exits with code 1. This prevents PM2 from infinite restart loops when no configuration is present.
- Starts the server as a background process using the PM2 API.
- The process is named `jarvis-server`.
- Enables `autorestart` on crash.
- Merges logs into a single file in the user's data directory.

### `jarvis stop`
- Stops the background process named `jarvis-server` using PM2.

### `jarvis status`
- Displays the current status of the `jarvis-server` process.
- Outputs: name, status, PID, uptime, restart count, and log file path.

## Local Development

For development in the repository, the server can be run in the foreground:

### `npm run dev`
- Starts the server directly without PM2 or daemonization.
- Uses the same environment loading logic as production.
