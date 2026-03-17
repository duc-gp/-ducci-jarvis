# Evaluation

This document exists so that an AI coding agent (e.g. Claude Code) can evaluate how well Jarvis is working and propose concrete improvements — to the system prompt, tool definitions, or server code.

## How to Use This Document

When asked to evaluate Jarvis, an AI coding agent should:

1. Read the relevant files listed below
2. Identify signals that indicate problems
3. Propose specific improvements (to code, `tools.json`, or the system prompt)

The agent should not make changes without user approval.

## Relevant Files

- `~/.jarvis/logs/session-*.jsonl` — one log file per session; each line is one agent run
- `~/.jarvis/data/tools/tools.json` — all tool definitions and their code
- `~/.jarvis/data/conversations/*.json` — full conversation histories
- `docs/system-prompt.md` — the system prompt sent to the model on every session

## What "Good" Looks Like

- Tasks complete within a small number of iterations (well under the limit of 10)
- `intervention_required` status is rare
- `checkpoint_reached` status is occasional but not frequent
- `logSummary` entries are specific and explain reasoning, not just actions
- Tool errors (`tool_failed`) are rare and the agent recovers from them

## Problem Signals

| Signal | Possible Cause |
|---|---|
| Frequent `intervention_required` | Agent loops without making progress; possibly a prompt or tool issue |
| Frequent `checkpoint_reached` | Tasks are too complex for the iteration limit, or the agent is inefficient |
| Frequent `tool_failed` | Tool code is broken, or the agent is calling tools with wrong arguments |
| Vague `logSummary` (e.g. "Called exec.") | System prompt guidance for logSummary is not being followed |
| Frequent `format_error` | Model is not following the JSON response format; system prompt may need adjustment |

## What Can Be Improved

- **System prompt** (`docs/system-prompt.md`) — if the agent is behaving incorrectly or producing poor logSummaries
- **Tool definitions** (`~/.jarvis/data/tools/tools.json`) — if tools are failing or their descriptions are causing misuse
- **Server code** (`src/`) — if there are bugs in the agent loop, error handling, or session management
