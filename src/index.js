#!/usr/bin/env node

import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import pm2 from 'pm2';
import inquirer from 'inquirer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const JARVIS_DIR = path.join(os.homedir(), '.jarvis');
const ENV_FILE = path.join(JARVIS_DIR, '.env');
const SETTINGS_FILE = path.join(JARVIS_DIR, 'data', 'config', 'settings.json');
const SERVER_SCRIPT = path.join(__dirname, 'server', 'start.js');
const PROCESS_NAME = 'jarvis-server';
const LOG_FILE = path.join(JARVIS_DIR, 'logs', 'server.log');

function preflight() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error('Error: .env not found. Please run `jarvis setup` first.');
    process.exit(1);
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.error('Error: settings.json not found. Please run `jarvis setup` first.');
    process.exit(1);
  }
  // Ensure logs directory exists for PM2 output
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function connectPm2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pm2Start() {
  return new Promise((resolve, reject) => {
    pm2.start({
      script: SERVER_SCRIPT,
      name: PROCESS_NAME,
      autorestart: true,
      output: LOG_FILE,
      error: LOG_FILE,
      merge_logs: true,
    }, (err, proc) => {
      if (err) reject(err);
      else resolve(proc);
    });
  });
}

function pm2Stop() {
  return new Promise((resolve, reject) => {
    pm2.stop(PROCESS_NAME, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pm2Delete() {
  return new Promise((resolve, reject) => {
    pm2.delete(PROCESS_NAME, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pm2Describe() {
  return new Promise((resolve, reject) => {
    pm2.describe(PROCESS_NAME, (err, desc) => {
      if (err) reject(err);
      else resolve(desc);
    });
  });
}

function pm2Restart() {
  return new Promise((resolve, reject) => {
    pm2.restart(PROCESS_NAME, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const program = new Command();

program
  .name('jarvis')
  .description('A fully automated agent system that lives on a server.')
  .version(version);

program
  .command('setup')
  .description('Run interactive onboarding to configure API key and model.')
  .action(async () => {
    const onboardingScript = path.join(__dirname, 'scripts', 'onboarding.js');
    spawnSync('node', [onboardingScript], { stdio: 'inherit' });

    // Offer to restart the server if it is currently running
    try {
      await connectPm2();
      const desc = await pm2Describe().catch(() => []);
      const isRunning = desc.length > 0 && desc[0].pm2_env?.status === 'online';
      pm2.disconnect();

      if (isRunning) {
        const { doRestart } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'doRestart',
            message: 'Server is running. Restart now to apply changes?',
            default: true
          }
        ]);
        if (doRestart) {
          await connectPm2();
          await pm2Restart();
          pm2.disconnect();
          console.log('Jarvis server restarted.');
        } else {
          console.log('Run `jarvis stop && jarvis start` when ready to apply changes.');
        }
      }
    } catch {
      // PM2 not available or server not managed — silently skip
    }
  });

program
  .command('start')
  .description('Start the Jarvis server in the background.')
  .action(async () => {
    preflight();
    try {
      await connectPm2();
      // Check if already running
      const desc = await pm2Describe().catch(() => []);
      if (desc.length > 0 && desc[0].pm2_env?.status === 'online') {
        console.log('Jarvis server is already running.');
        pm2.disconnect();
        return;
      }
      await pm2Start();
      console.log('Jarvis server started.');
      pm2.disconnect();
    } catch (e) {
      console.error('Failed to start Jarvis server:', e.message);
      pm2.disconnect();
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the Jarvis server.')
  .action(async () => {
    try {
      await connectPm2();
      await pm2Stop();
      await pm2Delete();
      console.log('Jarvis server stopped.');
      pm2.disconnect();
    } catch (e) {
      console.error('Failed to stop Jarvis server:', e.message);
      pm2.disconnect();
      process.exit(1);
    }
  });

program
  .command('restart')
  .description('Restart the Jarvis server (starts it if not running).')
  .action(async () => {
    preflight();
    try {
      await connectPm2();
      const desc = await pm2Describe().catch(() => []);
      const isRunning = desc.length > 0 && desc[0].pm2_env?.status === 'online';
      if (isRunning) {
        await pm2Restart();
        console.log('Jarvis server restarted.');
      } else {
        await pm2Start();
        console.log('Jarvis server started.');
      }
      pm2.disconnect();
    } catch (e) {
      console.error('Failed to restart Jarvis server:', e.message);
      pm2.disconnect();
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Display the status of the Jarvis server.')
  .action(async () => {
    try {
      await connectPm2();
      const desc = await pm2Describe().catch(() => []);
      if (desc.length === 0) {
        console.log('Jarvis server is not running.');
      } else {
        const proc = desc[0];
        const env = proc.pm2_env || {};
        console.log(`Name:      ${proc.name}`);
        console.log(`Status:    ${env.status}`);
        console.log(`PID:       ${proc.pid}`);
        console.log(`Uptime:    ${env.pm_uptime ? new Date(env.pm_uptime).toISOString() : 'N/A'}`);
        console.log(`Restarts:  ${env.restart_time || 0}`);
        console.log(`Log file:  ${LOG_FILE}`);
      }
      pm2.disconnect();
    } catch (e) {
      console.error('Failed to get status:', e.message);
      pm2.disconnect();
      process.exit(1);
    }
  });

program.parse();
