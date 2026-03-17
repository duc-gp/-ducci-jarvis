# Identity

This document describes how Jarvis's identity is defined and injected.

## What It Is

`~/.jarvis/data/identity.md` is a plain Markdown file that defines who the agent is — its name, purpose, tone, and communication style. It is loaded at runtime and injected into the system prompt via the `{{identity}}` placeholder on every request.

This means you can change how Jarvis behaves without touching the system prompt or restarting the server. Editing `identity.md` takes effect on the next message.

## Default Content

Created automatically on first server start if the file does not exist:

```md
# Identity

You are Jarvis, a fully autonomous agent running on a local server. You have access to tools and can execute shell commands on the machine you run on.

Be concise and direct in your responses. Avoid unnecessary filler. When a task is done, say so clearly.
```

## How It Is Injected

`resolveSystemPrompt()` in `src/server/config.js` reads `identity.md` at call time and substitutes it for `{{identity}}` in the system prompt template. The resolved prompt is sent to the model but never written to disk — the placeholder is always preserved in the stored session history.

## Customisation

Edit `~/.jarvis/data/identity.md` directly. Examples of what you can change:

- **Name** — rename the agent to anything
- **Tone** — formal, casual, verbose, terse
- **Domain** — focus the agent on a specific area (e.g. "You are a security researcher...")
- **Personality** — add quirks, communication preferences, or constraints

## What Belongs Here vs. the System Prompt

`identity.md` is for **who the agent is**. The system prompt (`docs/system-prompt.md`) is for **how the agent must behave** — response format, tool use rules, exec safety, failure recovery. Keep technical rules in the system prompt where they cannot be accidentally deleted.
