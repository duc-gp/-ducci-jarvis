# Crons

Crons let you schedule recurring or one-time tasks. The agent executes the task autonomously and optionally notifies you via Telegram.

## Storage

All cron jobs are stored in `~/.jarvis/data/crons.json`:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "backup-nightly",
    "schedule": "0 3 * * *",
    "prompt": "Backup folder /home/xyz to /backups/xyz. When done, use send_telegram_message to notify the user with the result.",
    "once": false,
    "createdAt": "2026-03-11T10:00:00.000Z"
  }
]
```

## How a Cron Runs

When a cron fires:

1. A **fresh agent run** starts with no prior conversation context — only the stored `prompt`
2. The agent executes the task, optionally calling `send_telegram_message` to notify you
3. The result is logged to `~/.jarvis/logs/cron-<id>.jsonl`
4. A synthetic message is appended to your Telegram session so the agent has context if you reply:

```
[Cron "backup-nightly" | 2026-03-11 03:00] Backup completed. 2.3GB written to /backups/xyz.
```

5. If `once: true`, the cron deletes itself after firing

## Scheduling

Crons use standard cron expressions:

| Expression | Meaning |
|---|---|
| `0 3 * * *` | Every day at 3am |
| `0 */2 * * *` | Every 2 hours |
| `0 9 * * 1` | Every Monday at 9am |
| `30 14 11 3 *` | Once on March 11 at 14:30 |

For one-time tasks specified as relative times ("in 2 hours", "at 3pm today"), the agent calls `get_current_time` first, calculates the exact schedule, and sets `once: true`.

## Notifications

Notification is opt-in via the prompt. Include this in the prompt when you want a notification:

> "When done, use `send_telegram_message` to notify the user with the result. Prefix the message with [Cron: \"backup-nightly\" | <current timestamp>]."

If you don't want a notification, omit it. The agent follows the prompt literally — conditional notifications work naturally:

> "Check disk usage. If any partition is above 90%, use `send_telegram_message` to alert the user. Otherwise do nothing."

## Dynamic Scheduling

When `create_cron`, `update_cron`, or `delete_cron` runs successfully, the agent loop immediately updates the in-memory scheduler — no server restart required.

On server restart, all crons in `crons.json` are re-loaded and rescheduled. `once: true` crons that already fired (and deleted themselves) are gone from the file and will not re-run.

## Logs

Each cron has its own JSONL log at `~/.jarvis/logs/cron-<id>.jsonl`. One entry per run:

```json
{
  "ts": "2026-03-11T03:00:01.234Z",
  "cronName": "backup-nightly",
  "status": "ok",
  "response": "Backup completed. 2.3GB written to /backups/xyz.",
  "logSummary": "Ran rsync from /home/xyz to /backups/xyz. Exit code 0."
}
```

Use `read_cron_log` with a cron id to inspect a specific cron, or without an id to get an overview of the last 8 active crons (5 entries each), sorted by time. Ask Jarvis "did my backup run last night?" and it will call `list_crons` + `read_cron_log`.

## Tools

| Tool | Purpose |
|---|---|
| `create_cron` | Schedule a new cron job |
| `list_crons` | List all active crons |
| `update_cron` | Modify an existing cron (name, schedule, prompt, once) |
| `delete_cron` | Remove a cron by name or id |
| `read_cron_log` | Read execution history — omit id for cross-cron overview |
| `get_current_time` | Get current server time for relative scheduling |
| `send_telegram_message` | Send a proactive message to the Telegram user |

## Triggering Without Saying "Cron"

The system prompt instructs the agent to recognise scheduling intent from natural language. Examples that will create a cron:

- "every night at 3am, backup my projects folder"
- "remind me in 2 hours"
- "check my server disk usage every day and alert me if it's getting full"
- "send me a good morning message every day at 8am"
