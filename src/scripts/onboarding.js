#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';

const jarvisDir = path.join(os.homedir(), '.jarvis');
const envFile = path.join(jarvisDir, '.env');
const configDir = path.join(jarvisDir, 'data', 'config');
const logsDir = path.join(jarvisDir, 'logs');
const settingsFile = path.join(configDir, 'settings.json');

function ensureDirectories() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function loadEnvVar(key) {
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (match) return match[1].trim();
  }
  return null;
}

function saveEnvVar(key, value) {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=`, 'm'))) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    content = content ? `${content.trim()}\n${line}\n` : `${line}\n`;
  }
  fs.writeFileSync(envFile, content, 'utf8');
}

function loadSettings() {
  if (fs.existsSync(settingsFile)) {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

async function fetchOpenRouterModels(apiKey) {
  console.log(chalk.blue('Fetching models from OpenRouter...'));
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error(chalk.red('Failed to fetch models:'), error.message);
    return [];
  }
}

const ANTHROPIC_MODELS_FALLBACK = [
  { id: 'claude-opus-4-6', description: 'Most capable' },
  { id: 'claude-sonnet-4-6', description: 'Balanced' },
  { id: 'claude-3-5-sonnet-20241022', description: 'Balanced (stable)' },
  { id: 'claude-haiku-4-5-20251001', description: 'Fast & cheap' },
  { id: 'claude-3-5-haiku-20241022', description: 'Fast & cheap (stable)' },
];

async function fetchAnthropicModels(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.data.map(m => ({ id: m.id, description: '' }));
  } catch {
    return ANTHROPIC_MODELS_FALLBACK;
  }
}

async function fetchZaiModels(apiKey) {
  console.log(chalk.blue('Fetching models from Z.AI...'));
  try {
    const response = await fetch('https://api.z.ai/api/paas/v4/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(chalk.red('Failed to fetch Z.AI models:'), error.message);
    return [];
  }
}

async function run() {
  ensureDirectories();

  console.log(chalk.green.bold('\n=== Jarvis Setup ===\n'));

  let settings = loadSettings();

  // --- PROVIDER STEP ---
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which AI provider do you want to use?',
      choices: [
        { name: 'OpenRouter (access many models via one key)', value: 'openrouter' },
        { name: 'Anthropic Direct (use your Anthropic API key)', value: 'anthropic' },
        { name: 'Z.AI Direct (GLM models, use your Z.AI API key)', value: 'z-ai' },
      ],
      default: settings.provider || 'openrouter',
    }
  ]);

  // --- API KEY STEP ---
  let apiKey;

  if (provider === 'anthropic') {
    const existingKey = loadEnvVar('ANTHROPIC_API_KEY');
    apiKey = existingKey;

    if (existingKey) {
      const { keepKey } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keepKey',
          message: 'An ANTHROPIC_API_KEY is already configured. Do you want to keep it?',
          default: true,
        }
      ]);
      if (!keepKey) apiKey = null;
    }

    if (!apiKey) {
      const { newKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'newKey',
          message: 'Enter your Anthropic API key:',
          validate: (input) => input.length >= 10 || 'API key must be at least 10 characters long.',
        }
      ]);
      apiKey = newKey;
      saveEnvVar('ANTHROPIC_API_KEY', apiKey);
      console.log(chalk.green('Anthropic API key saved.'));
    }
  } else if (provider === 'z-ai') {
    const existingKey = loadEnvVar('ZAI_API_KEY');
    apiKey = existingKey;

    if (existingKey) {
      const { keepKey } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keepKey',
          message: 'A ZAI_API_KEY is already configured. Do you want to keep it?',
          default: true,
        }
      ]);
      if (!keepKey) apiKey = null;
    }

    if (!apiKey) {
      const { newKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'newKey',
          message: 'Enter your Z.AI API key (from open.bigmodel.cn):',
          validate: (input) => input.length >= 10 || 'API key must be at least 10 characters long.',
        }
      ]);
      apiKey = newKey;
      saveEnvVar('ZAI_API_KEY', apiKey);
      console.log(chalk.green('Z.AI API key saved.'));
    }
  } else {
    const existingKey = loadEnvVar('OPENROUTER_API_KEY');
    apiKey = existingKey;

    if (existingKey) {
      const { keepKey } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keepKey',
          message: 'An OPENROUTER_API_KEY is already configured. Do you want to keep it?',
          default: true,
        }
      ]);
      if (!keepKey) apiKey = null;
    }

    if (!apiKey) {
      const { newKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'newKey',
          message: 'Enter your OpenRouter API key:',
          validate: (input) => input.length >= 10 || 'API key must be at least 10 characters long.',
        }
      ]);
      apiKey = newKey;
      saveEnvVar('OPENROUTER_API_KEY', apiKey);
      console.log(chalk.green('OpenRouter API key saved.'));
    }
  }

  // --- MODEL SELECTION STEP ---
  // Reset model selection when switching providers
  let selectedModel = settings.provider === provider ? settings.selectedModel : null;

  if (selectedModel) {
    const { keepModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'keepModel',
        message: `Current model is ${chalk.yellow(selectedModel)}. Do you want to keep it or change it?`,
        choices: [
          { name: 'Keep current model', value: true },
          { name: 'Change model', value: false },
        ]
      }
    ]);
    if (!keepModel) selectedModel = null;
  }

  if (!selectedModel) {
    if (provider === 'z-ai') {
      const models = await fetchZaiModels(apiKey);
      let choices;
      if (models.length > 0) {
        choices = models.map(m => ({ name: m.id, value: m.id }));
      } else {
        console.log(chalk.yellow('Falling back to manual entry due to fetch failure.'));
        choices = [];
      }
      choices.push({ name: 'Enter model ID manually', value: '__manual__' });

      const { browsedModel } = await inquirer.prompt([
        {
          type: 'list',
          name: 'browsedModel',
          message: 'Select a Z.AI model:',
          choices,
          pageSize: 20,
        }
      ]);

      if (browsedModel === '__manual__') {
        const { manualModel } = await inquirer.prompt([
          {
            type: 'input',
            name: 'manualModel',
            message: 'Enter Z.AI model ID (e.g., glm-5):',
            validate: (input) => input.trim().length > 0 || 'Model ID cannot be empty.',
          }
        ]);
        selectedModel = manualModel.trim();
      } else {
        selectedModel = browsedModel;
      }
    } else if (provider === 'anthropic') {
      console.log(chalk.blue('Fetching available Claude models...'));
      const models = await fetchAnthropicModels(apiKey);
      const choices = models.map(m => ({
        name: m.description ? `${m.id}  ${chalk.dim(m.description)}` : m.id,
        value: m.id,
      }));
      choices.push({ name: 'Enter model ID manually', value: '__manual__' });

      const { browsedModel } = await inquirer.prompt([
        {
          type: 'list',
          name: 'browsedModel',
          message: 'Select a Claude model:',
          choices,
          pageSize: 20,
        }
      ]);

      if (browsedModel === '__manual__') {
        const { manualModel } = await inquirer.prompt([
          {
            type: 'input',
            name: 'manualModel',
            message: 'Enter Anthropic model ID (e.g., claude-sonnet-4-6):',
            validate: (input) => input.trim().length > 0 || 'Model ID cannot be empty.',
          }
        ]);
        selectedModel = manualModel.trim();
      } else {
        selectedModel = browsedModel;
      }
    } else {
      const { modelSelectionMethod } = await inquirer.prompt([
        {
          type: 'list',
          name: 'modelSelectionMethod',
          message: 'How would you like to select a model?',
          choices: [
            { name: 'Browse OpenRouter models', value: 'browse' },
            { name: 'Enter model ID manually', value: 'manual' },
          ]
        }
      ]);

      if (modelSelectionMethod === 'manual') {
        const { manualModel } = await inquirer.prompt([
          {
            type: 'input',
            name: 'manualModel',
            message: 'Enter OpenRouter model ID (e.g., anthropic/claude-3.5-sonnet):',
            validate: (input) => input.trim().length > 0 || 'Model ID cannot be empty.',
          }
        ]);
        selectedModel = manualModel.trim();
      } else {
        const models = await fetchOpenRouterModels(apiKey);
        if (models.length === 0) {
          console.log(chalk.yellow('Falling back to manual entry due to fetch failure.'));
          const { manualModel } = await inquirer.prompt([
            {
              type: 'input',
              name: 'manualModel',
              message: 'Enter OpenRouter model ID:',
              validate: (input) => input.trim().length > 0 || 'Model ID cannot be empty.',
            }
          ]);
          selectedModel = manualModel.trim();
        } else {
          models.sort((a, b) => {
            const isFreeA = a.pricing && parseFloat(a.pricing.prompt) === 0 && parseFloat(a.pricing.completion) === 0;
            const isFreeB = b.pricing && parseFloat(b.pricing.prompt) === 0 && parseFloat(b.pricing.completion) === 0;
            if (isFreeA && !isFreeB) return -1;
            if (!isFreeA && isFreeB) return 1;
            return a.id.localeCompare(b.id);
          });
          const choices = models.map(m => {
            const isFree = m.pricing && parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0;
            return { name: `${m.id} ${isFree ? chalk.green('(Free)') : ''}`, value: m.id };
          });
          const { browsedModel } = await inquirer.prompt([
            {
              type: 'list',
              name: 'browsedModel',
              message: 'Select a model:',
              choices,
              pageSize: 20,
            }
          ]);
          selectedModel = browsedModel;
        }
      }
    }
  }

  const previousProvider = settings.provider || 'openrouter';
  settings.provider = provider;
  settings.selectedModel = selectedModel;
  // Reset fallback to provider-appropriate default when switching providers or on first run
  if (!settings.fallbackModel || previousProvider !== provider) {
    if (provider === 'anthropic') settings.fallbackModel = 'claude-haiku-4-5-20251001';
    else if (provider === 'z-ai') settings.fallbackModel = 'glm-4-flash';
    else settings.fallbackModel = 'openrouter/free';
  }
  if (settings.maxIterations === undefined) {
    settings.maxIterations = 10;
  }
  if (settings.maxHandoffs === undefined) {
    settings.maxHandoffs = 5;
  }
  if (settings.port === undefined) {
    settings.port = 18008;
  }

  saveSettings(settings);
  console.log(chalk.green(`\nModel ${chalk.bold(selectedModel)} saved to settings.`));

  // --- TELEGRAM CHANNEL STEP (OPTIONAL) ---
  const { configureTelegram } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureTelegram',
      message: 'Do you want to configure the Telegram channel?',
      default: false
    }
  ]);

  if (configureTelegram) {
    // Bot token
    const existingToken = loadEnvVar('TELEGRAM_BOT_TOKEN');
    let keepToken = false;
    if (existingToken) {
      const { keep } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keep',
          message: 'A TELEGRAM_BOT_TOKEN is already configured. Do you want to keep it?',
          default: true
        }
      ]);
      keepToken = keep;
    }
    if (!keepToken) {
      const { token } = await inquirer.prompt([
        {
          type: 'password',
          name: 'token',
          message: 'Enter your Telegram bot token (from BotFather):',
          validate: (input) => input.trim().length > 0 || 'Bot token cannot be empty.'
        }
      ]);
      saveEnvVar('TELEGRAM_BOT_TOKEN', token.trim());
      console.log(chalk.green('Telegram bot token saved.'));
    }

    // Allowed user IDs
    const existingIds = settings.channels?.telegram?.allowedUserIds;
    let keepIds = false;
    if (existingIds && existingIds.length > 0) {
      const { keep } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keep',
          message: `Allowed Telegram user IDs are already configured (${existingIds.join(', ')}). Keep them?`,
          default: true
        }
      ]);
      keepIds = keep;
    }
    if (!keepIds) {
      const { rawIds } = await inquirer.prompt([
        {
          type: 'input',
          name: 'rawIds',
          message: 'Enter allowed Telegram user ID(s), comma-separated:',
          validate: (input) => {
            const parts = input.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length === 0) return 'At least one user ID is required.';
            if (parts.some(p => !/^\d+$/.test(p))) return 'All values must be numeric user IDs.';
            return true;
          }
        }
      ]);
      const ids = rawIds.split(',').map(s => parseInt(s.trim(), 10));
      if (!settings.channels) settings.channels = {};
      if (!settings.channels.telegram) settings.channels.telegram = {};
      settings.channels.telegram.allowedUserIds = ids;
      saveSettings(settings);
      console.log(chalk.green(`Allowed user IDs saved: ${ids.join(', ')}`));
    }
  }

  // --- PERPLEXITY STEP (OPTIONAL) ---
  const existingPerplexityKey = loadEnvVar('PERPLEXITY_API_KEY');
  const { configurePerplexity } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configurePerplexity',
      message: 'Do you want to configure Perplexity web search?',
      default: !!existingPerplexityKey
    }
  ]);

  if (configurePerplexity) {
    let keepPerplexityKey = false;
    if (existingPerplexityKey) {
      const { keep } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'keep',
          message: 'A PERPLEXITY_API_KEY is already configured. Do you want to keep it?',
          default: true
        }
      ]);
      keepPerplexityKey = keep;
    }
    if (!keepPerplexityKey) {
      const { perplexityKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'perplexityKey',
          message: 'Enter your Perplexity API key (from perplexity.ai/settings/api):',
          validate: (input) => input.trim().length > 0 || 'API key cannot be empty.'
        }
      ]);
      saveEnvVar('PERPLEXITY_API_KEY', perplexityKey.trim());
      console.log(chalk.green('Perplexity API key saved.'));
    }
  }

  // --- PM2 + LOG ROTATION STEP ---
  const pm2Check = spawnSync('pm2', ['--version'], { stdio: 'pipe' });
  if (pm2Check.status !== 0) {
    console.log(chalk.blue('Installing pm2 globally...'));
    spawnSync('npm', ['install', '-g', 'pm2'], { stdio: 'inherit' });
  }

  const logrotateModuleDir = path.join(os.homedir(), '.pm2', 'modules', 'pm2-logrotate');
  const logrotateInstalled = fs.existsSync(logrotateModuleDir);

  if (logrotateInstalled) {
    console.log(chalk.green('pm2-logrotate is already installed — server.log will be rotated automatically.'));
  } else {
    const { setupLogrotate } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupLogrotate',
        message: 'Install pm2-logrotate to prevent server.log from growing indefinitely?',
        default: true,
      }
    ]);

    if (setupLogrotate) {
      console.log(chalk.blue('Installing pm2-logrotate...'));
      const install = spawnSync('pm2', ['install', 'pm2-logrotate'], { stdio: 'inherit' });
      if (install.status !== 0) {
        console.log(chalk.yellow('Installation failed — make sure pm2 is installed globally (`npm install -g pm2`) and try again.'));
      } else {
        spawnSync('pm2', ['set', 'pm2-logrotate:max_size', '10M'], { stdio: 'inherit' });
        spawnSync('pm2', ['set', 'pm2-logrotate:retain', '5'], { stdio: 'inherit' });
        spawnSync('pm2', ['set', 'pm2-logrotate:compress', 'true'], { stdio: 'inherit' });
        spawnSync('pm2', ['set', 'pm2-logrotate:rotateInterval', '0 0 * * *'], { stdio: 'inherit' });
        console.log(chalk.green('pm2-logrotate installed: 10 MB max, 5 rotated files kept, daily rotation.'));
      }
    }
  }

  console.log(chalk.green.bold('\nSetup complete!'));
}

run().catch(error => {
  console.error(chalk.red('Setup failed:'), error);
  process.exit(1);
});
