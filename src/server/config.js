import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JARVIS_DIR = path.join(os.homedir(), '.jarvis');

export const PATHS = {
  jarvisDir: JARVIS_DIR,
  envFile: path.join(JARVIS_DIR, '.env'),
  configDir: path.join(JARVIS_DIR, 'data', 'config'),
  settingsFile: path.join(JARVIS_DIR, 'data', 'config', 'settings.json'),
  conversationsDir: path.join(JARVIS_DIR, 'data', 'conversations'),
  toolsDir: path.join(JARVIS_DIR, 'data', 'tools'),
  toolsFile: path.join(JARVIS_DIR, 'data', 'tools', 'tools.json'),
  logsDir: path.join(JARVIS_DIR, 'logs'),
  telegramChatsDir: path.join(JARVIS_DIR, 'telegram-chats'),
  userInfoFile: path.join(JARVIS_DIR, 'data', 'user-info.json'),
  identityFile: path.join(JARVIS_DIR, 'data', 'identity.md'),
  skillsDir: path.join(JARVIS_DIR, 'data', 'skills'),
  cronsFile: path.join(JARVIS_DIR, 'data', 'crons.json'),
  systemPromptFile: path.join(__dirname, '..', '..', 'docs', 'system-prompt.md'),
};

export function ensureDirectories() {
  for (const dir of [PATHS.configDir, PATHS.conversationsDir, PATHS.toolsDir, PATHS.logsDir, PATHS.telegramChatsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig() {
  dotenv.config({ path: PATHS.envFile });

  if (!fs.existsSync(PATHS.settingsFile)) {
    throw new Error('settings.json not found. Run `jarvis setup` first.');
  }

  const settings = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8'));
  const provider = settings.provider || 'openrouter';

  let apiKey;
  if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not found. Run `jarvis setup` first.');
  } else if (provider === 'z-ai') {
    apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) throw new Error('ZAI_API_KEY not found. Add it to ~/.jarvis/.env first.');
  } else {
    apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not found. Run `jarvis setup` first.');
  }

  // Vision model (optional) — separate provider/model for one-shot image analysis
  const visionProvider = settings.visionProvider || null;
  const visionModel = settings.visionModel || null;
  let visionApiKey = null;
  if (visionProvider === 'z-ai') {
    visionApiKey = process.env.ZAI_API_KEY || null;
  } else if (visionProvider === 'openrouter') {
    visionApiKey = process.env.OPENROUTER_API_KEY || null;
  }

  return {
    provider,
    apiKey,
    selectedModel: settings.selectedModel,
    fallbackModel: settings.fallbackModel || (provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'openrouter/free'),
    maxIterations: settings.maxIterations || 20,
    maxHandoffs: settings.maxHandoffs || 3,
    contextWindow: settings.contextWindow || 300,
    modelContextWindow: settings.modelContextWindow || null,
    port: settings.port || 18008,
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || null,
      allowedUserIds: settings.channels?.telegram?.allowedUserIds || [],
    },
    visionProvider,
    visionModel,
    visionApiKey,
  };
}

export function loadSystemPrompt() {
  const content = fs.readFileSync(PATHS.systemPromptFile, 'utf8');
  const match = content.match(/```\n([\s\S]*?)```/);
  if (!match) throw new Error('Could not parse system prompt from docs/system-prompt.md');
  return match[1].trim();
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) meta[key.trim()] = rest.join(':').trim();
  }
  return meta;
}

export function resolveSystemPrompt(promptTemplate, sessionId) {
  let identity = '';
  try {
    identity = fs.readFileSync(PATHS.identityFile, 'utf8').trim();
  } catch {
    // File doesn't exist yet
  }

  let skillsList = '(none)';
  try {
    const entries = fs.readdirSync(PATHS.skillsDir, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFileName = fs.readdirSync(path.join(PATHS.skillsDir, entry.name))
        .find(f => f.toLowerCase() === 'skill.md') || 'skill.md';
      const skillFile = path.join(PATHS.skillsDir, entry.name, skillFileName);
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        const meta = parseSkillFrontmatter(content);
        if (meta?.name && meta?.description) {
          skills.push(`- ${meta.name}: ${meta.description}`);
        }
      } catch { /* skip malformed skills */ }
    }
    if (skills.length > 0) skillsList = skills.join('\n');
  } catch { /* skills dir doesn't exist yet */ }

  let userInfo = '(none yet)';
  try {
    const raw = fs.readFileSync(PATHS.userInfoFile, 'utf8');
    const { items } = JSON.parse(raw);
    if (items && items.length > 0) {
      userInfo = items.map(i => `- ${i.key}: ${i.value}`).join('\n');
    }
  } catch {
    // File doesn't exist yet
  }

  return promptTemplate
    .replace('{{identity}}', identity)
    .replace('{{skills}}', skillsList)
    .replace('{{session_id}}', sessionId || 'unknown')
    .replace('{{user_info}}', userInfo);
}
