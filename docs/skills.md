# Skills

Skills are predefined workflows that guide how the agent approaches specific tasks. Unlike tools (which execute code), skills are instructions written in Markdown — they tell the agent how to do something rather than doing it directly.

## Folder Structure

Each skill lives in its own subdirectory under `~/.jarvis/data/skills/`:

```
~/.jarvis/data/skills/
  <skill-name>/
    skill.md       ← required: frontmatter + instructions
    *.js / *.sh    ← optional: bundled scripts the skill references
```

## skill.md Format

Every `skill.md` starts with YAML frontmatter:

```yaml
---
name: skill-name
description: What this skill does and when to use it. Use this when the user asks to...
---

# Skill Title

Instructions for the agent...
```

The `description` field is the only signal the agent has to decide whether to load the skill. Write it so the agent reliably recognises when the skill applies — be specific about the task type and include a "Use this when..." clause.

Bad: `"Manages ports."`
Good: `"Scan a target host for open ports using nmap and return a structured report. Use this when the user asks to scan ports or check what services are running on a host."`

## How Skills Are Used

At runtime, `resolveSystemPrompt()` reads all skill directories and builds a list of available skills (name + description only) injected via the `{{skills}}` placeholder in the system prompt. The agent sees this list on every request and decides which skill (if any) is relevant.

When the agent decides to use a skill, it calls the `read_skill` tool to fetch the full instructions:

```json
{ "name": "skill-name" }
```

The tool returns the full `skill.md` content. The agent then follows the instructions.

This two-step approach (list in system prompt → full content on demand) keeps the prompt small while making all skills discoverable.

## Bundled Scripts

A skill folder can contain scripts that the skill's instructions reference. Scripts are called via `exec`:

```sh
node ~/.jarvis/data/skills/<name>/script.js <args>
```

Always reference scripts by their absolute path. Use `write_file` to create scripts — never `exec+echo`.

## Seed Skills

Two skills are created on first server start if they do not exist:

- **`add-two-integers`** — example skill demonstrating the skill + bundled script pattern
- **`manage-skill`** — create, edit, or delete skills; includes guidance on what makes a good skill

## Creating and Managing Skills

Use the `manage-skill` skill. The agent will read it when asked to create, edit, or list skills.

## What Makes a Good Skill

- Describes a **workflow or approach**, not a single command
- Name is specific and lowercase with hyphens (`scan-open-ports`, not `scanning`)
- Description reliably signals to the agent when to use it (see example above)
- Instructions are written for the agent, not the user
- Uses `write_file` for any file creation inside the skill workflow
