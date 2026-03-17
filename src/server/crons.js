import fs from 'fs';
import path from 'path';
import { runAgentLoop, withSessionLock } from './agent.js';
import { createClient } from './provider.js';
import { loadSystemPrompt, resolveSystemPrompt, PATHS } from './config.js';
import { createSession, loadSession, saveSession } from './sessions.js';
import * as cronScheduler from './cron-scheduler.js';
import { load as loadTelegramSessions } from '../channels/telegram/sessions.js';

function loadCrons() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.cronsFile, 'utf8'));
  } catch {
    return [];
  }
}

async function appendCronLog(cronId, entry) {
  const logFile = path.join(PATHS.logsDir, `cron-${cronId}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await fs.promises.appendFile(logFile, line, 'utf8');
}

async function writeSyntheticMessageToTelegramSession(entry, response, config) {
  const chatId = config.telegram?.allowedUserIds?.[0];
  if (!chatId) return;

  const sessions = loadTelegramSessions();
  const sessionId = sessions[chatId];
  if (!sessionId) return;

  const tz = config.timezone || 'Europe/Berlin';
  const ts = new Date().toLocaleString('sv', { timeZone: tz }).slice(0, 16);
  const syntheticMessage = `[Cron "${entry.name}" | ${ts}] ${response}`;

  await withSessionLock(sessionId, async () => {
    const session = await loadSession(sessionId);
    if (!session) return;
    session.messages.push({ role: 'assistant', content: syntheticMessage });
    await saveSession(sessionId, session);
  });
}

export async function runCron(entry, config) {
  console.log(`[cron] running "${entry.name}"`);

  const systemPromptTemplate = loadSystemPrompt();
  const session = createSession(systemPromptTemplate);
  session.messages.push({ role: 'user', content: entry.prompt });

  const client = createClient(config);
  const usageAccum = { prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0 };

  function prepareMessages(messages) {
    return messages.map((msg, i) => {
      if (i === 0 && msg.role === 'system') {
        return { ...msg, content: resolveSystemPrompt(msg.content, `cron-${entry.id}`) };
      }
      return msg;
    });
  }

  let run;
  let handoffCount = 0;
  let previousRemaining = null;
  const failedApproaches = [];
  const checkpointState = {};

  try {
    while (true) {
      const runStartIndex = session.messages.length;

      try {
        run = await runAgentLoop(client, config, session, prepareMessages, usageAccum);
      } catch (e) {
        run = { status: 'error', response: e.message, logSummary: e.message, runToolCalls: [] };
        break;
      }

      if (run.status !== 'checkpoint_reached') break;

      if (run.checkpoint.failedApproaches?.length > 0) {
        failedApproaches.push(...run.checkpoint.failedApproaches);
      }
      if (run.checkpoint.state && Object.keys(run.checkpoint.state).length > 0) {
        Object.assign(checkpointState, run.checkpoint.state);
      }

      // Zero-progress detection
      const currentRemaining = (run.checkpoint.remaining || '').trim();
      if (previousRemaining !== null && currentRemaining === previousRemaining) {
        run = { ...run, status: 'intervention_required', logSummary: 'Zero progress detected in cron run.' };
        session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);
        break;
      }
      previousRemaining = currentRemaining;

      // Max handoffs
      handoffCount++;
      if (handoffCount > config.maxHandoffs) {
        run = { ...run, status: 'intervention_required', logSummary: 'Max handoffs exceeded in cron run.' };
        session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);
        break;
      }

      // Strip intermediate tool history, keep wrap-up assistant response
      session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);

      // Resume with checkpoint.remaining + accumulated context
      let resumeContent = run.checkpoint.remaining || 'Continue with the task.';
      if (failedApproaches.length > 0) {
        resumeContent += `\n\n[System: The following approaches were tried and failed in previous runs — do not repeat them:\n${failedApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}]`;
      }
      if (Object.keys(checkpointState).length > 0) {
        resumeContent += `\n\n[System: Known facts from previous runs:\n${Object.entries(checkpointState).map(([k, v]) => `- ${k}: ${v}`).join('\n')}]`;
      }
      session.messages.push({ role: 'user', content: resumeContent });
    }
  } catch (e) {
    run = { status: 'error', response: e.message, logSummary: e.message, runToolCalls: [] };
  }

  // Log to cron JSONL
  await appendCronLog(entry.id, {
    cronName: entry.name,
    status: run.status,
    response: run.response,
    logSummary: run.logSummary,
  }).catch(e => console.error(`[cron] log error: ${e.message}`));

  // Write synthetic message to user's Telegram session
  await writeSyntheticMessageToTelegramSession(entry, run.response, config).catch(e => {
    console.error(`[cron] telegram session write error: ${e.message}`);
  });

  // once: true — delete after firing
  if (entry.once) {
    try {
      const crons = loadCrons().filter(c => c.id !== entry.id);
      fs.writeFileSync(PATHS.cronsFile, JSON.stringify(crons, null, 2), 'utf8');
      cronScheduler.unschedule(entry.id);
    } catch (e) {
      console.error(`[cron] cleanup error: ${e.message}`);
    }
  }
}

export function initCrons(config) {
  cronScheduler.init(runCron, config);

  const crons = loadCrons();
  for (const entry of crons) {
    try {
      cronScheduler.schedule(entry);
    } catch (e) {
      console.error(`[cron] failed to schedule "${entry.name}": ${e.message}`);
    }
  }
  console.log(`[cron] initialized ${crons.length} cron(s)`);
}
