import express from 'express';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import fs, { realpathSync, existsSync, writeFileSync } from 'fs';
import { loadConfig, ensureDirectories, PATHS } from './config.js';
import { seedTools } from './tools.js';
import { handleChat } from './agent.js';
import { initCrons } from './crons.js';
import { startTelegramChannel } from '../channels/telegram/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  if (req.path === '/api/chat' && req.method === 'POST') {
    const sid = req.body.sessionId || 'new';
    console.log(`\n${chalk.magenta('>>>')} ${chalk.bold('Incoming Chat')} [SID: ${chalk.dim(sid.slice(0, 8))}]`);
  }
  next();
});

// Serve the built UI as static files
const uiDist = path.join(__dirname, '..', '..', 'ui', 'dist');
app.use(express.static(uiDist));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required', status: 'format_error' });
  }

  try {
    const result = await handleChat(app.locals.config, sessionId || null, message.trim());
    res.json(result);
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message, status: 'model_error' });
  }
});

// SPA fallback: serve index.html for non-API routes
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
    res.sendFile(path.join(uiDist, 'index.html'), (err) => {
      if (err) next();
    });
  } else {
    next();
  }
});

const DEFAULT_IDENTITY = `# Identity

You are Jarvis, a fully autonomous agent running on a local server. You have access to tools and can execute shell commands on the machine you run on.

Be concise and direct in your responses. Avoid unnecessary filler. When a task is done, say so clearly.
`;

function seedIdentity() {
  if (!existsSync(PATHS.identityFile)) {
    writeFileSync(PATHS.identityFile, DEFAULT_IDENTITY, 'utf8');
    console.log('Created default identity.md');
  }
}

const EXAMPLE_SKILL_MD = `---
name: add-two-integers
description: Adds two integer numbers by running a Node.js script
---

# Add Two Integers

Use this skill when asked to add two integer numbers.

## How to use

Run the bundled script via \`exec\` with two integer arguments:

\`\`\`sh
node ~/.jarvis/data/skills/add-two-integers/add.js <a> <b>
\`\`\`

Example:

\`\`\`sh
node ~/.jarvis/data/skills/add-two-integers/add.js 3 7
# Output: 10
\`\`\`

Both arguments must be integers. The script exits with code 1 and prints a usage error if either argument is missing or not a valid integer.
`;

const EXAMPLE_SKILL_JS = `const a = parseInt(process.argv[2], 10);
const b = parseInt(process.argv[3], 10);

if (isNaN(a) || isNaN(b)) {
  console.error('Usage: node add.js <integer_a> <integer_b>');
  process.exit(1);
}

console.log(a + b);
`;

const MANAGE_SKILL_MD = `---
name: manage-skill
description: Create, edit, or delete a skill in ~/.jarvis/data/skills/. Use this when the user asks to add a new skill, update an existing skill, or remove a skill.
---

# Manage Skill

Use this skill when the user asks to create, list, edit, or delete a skill.

## What makes a good skill

- A skill describes a **workflow or approach**, not a single command
- The name is specific and lowercase with hyphens (e.g. \`scan-open-ports\`, not \`scanning\`)
- The description (frontmatter) is the **only signal the agent has to decide whether to load the skill**. Write it so the agent reliably recognises when this skill applies: be specific about the task type, not just the topic, and include when to use it. Bad: "Manages ports." Good: "Scan a target host for open ports using nmap and return a structured report. Use this when the user asks to scan ports or check what services are running on a host."
- Instructions are written for the agent, not the user — be explicit about which tools to use
- If the skill needs a script, bundle it in the same folder and reference it by absolute path using \`~/.jarvis/data/skills/<name>/script.js\`
- Prefer \`write_file\` over \`exec+echo\` for writing any file

## Folder structure

\`\`\`
~/.jarvis/data/skills/<name>/
  skill.md       ← required
  *.js / *.sh    ← optional bundled scripts
\`\`\`

## Frontmatter format

\`\`\`yaml
---
name: skill-name
description: Description that reliably tells the agent when to use this skill
---
\`\`\`

## Create a skill

1. Create the folder: \`exec\` → \`mkdir -p ~/.jarvis/data/skills/<name>\`
2. Write \`skill.md\` with frontmatter + instructions using \`write_file\`
3. If scripts are needed, write them with \`write_file\` into the same folder

## Edit a skill

1. Read current content: \`exec\` → \`cat ~/.jarvis/data/skills/<name>/skill.md\`
2. Overwrite with updated content using \`write_file\`

## Delete a skill

1. Confirm the skill name with the user before deleting
2. \`exec\` → \`rm -rf ~/.jarvis/data/skills/<name>\`
`;

function seedSkills() {
  const skills = [
    { dir: 'add-two-integers', files: { 'skill.md': EXAMPLE_SKILL_MD, 'add.js': EXAMPLE_SKILL_JS } },
    { dir: 'manage-skill', files: { 'skill.md': MANAGE_SKILL_MD } },
  ];
  for (const skill of skills) {
    const skillDir = path.join(PATHS.skillsDir, skill.dir);
    fs.mkdirSync(skillDir, { recursive: true });
    for (const [filename, content] of Object.entries(skill.files)) {
      const filePath = path.join(skillDir, filename);
      if (!existsSync(filePath)) writeFileSync(filePath, content, 'utf8');
    }
  }
}

function startServer() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  ensureDirectories();
  seedTools();
  seedIdentity();
  seedSkills();
  initCrons(config);

  app.locals.config = config;

  const PORT = config.port;
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Jarvis server listening on 127.0.0.1:${PORT}`);
    startTelegramChannel(config);
  });
}

if (realpathSync(__filename) === realpathSync(process.argv[1])) {
  startServer();
}

export { app, startServer };
