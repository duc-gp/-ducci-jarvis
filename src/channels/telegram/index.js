import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: JARVIS_VERSION } = _require('../../../package.json');
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import { handleChat, requestAbort } from '../../server/agent.js';
import { loadSession } from '../../server/sessions.js';
import { PATHS } from '../../server/config.js';
import { isRunningCron, getRunningCrons } from '../../server/cron-scheduler.js';
import { load, save } from './sessions.js';
import { describeImage } from '../../server/vision.js';
import { textToSpeech, speechToText, generateTtsSummary } from '../../server/fish-audio.js';

function getTelegramChatLogPath(chatId, sessionId) {
  const prefix = sessionId ? String(sessionId).slice(0, 8) : 'unknown';
  return path.join(PATHS.telegramChatsDir, `${chatId}-${prefix}.log`);
}

async function appendTelegramChatLog(chatId, sessionId, direction, text, ts = null) {
  const logFile = getTelegramChatLogPath(chatId, sessionId);
  const timestamp = ts || new Date().toISOString();
  const line = `${timestamp} [${direction}] ${String(text).replace(/\n/g, ' ')}\n`;
  await fs.promises.appendFile(logFile, line, 'utf8').catch(() => {});
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Strip HTML for passing plain text to the TTS summary LLM.
function toPlainText(htmlText) {
  let text = htmlText;
  // Remove <pre> code blocks entirely — not useful spoken
  text = text.replace(/<pre>[\s\S]*?<\/pre>/gi, '');
  // Remove <code> inline tags but keep content
  text = text.replace(/<code>([^<]*)<\/code>/gi, '$1');
  return stripHtml(text).replace(/[ \t]+/g, ' ').trim();
}

function markdownToHtml(text) {
  // 0. Sanitize unsupported Telegram HTML tags
  // Headings → <b>
  text = text.replace(/<h[1-6](\s[^>]*)?>/gi, '<b>');
  text = text.replace(/<\/h[1-6]>/gi, '</b>');
  // List items → bullet prefix (strip both opening and closing tags)
  text = text.replace(/<li(\s[^>]*)?>/gi, '• ');
  text = text.replace(/<\/li>/gi, '');
  // Block layout tags → newlines (strip tags, keep content)
  text = text.replace(/<\/?(ul|ol|div|p)(\s[^>]*)?>/gi, '\n');
  // Inline layout tags → strip
  text = text.replace(/<\/?(span)(\s[^>]*)?>/gi, '');
  // <hr> → strip entirely
  text = text.replace(/<hr(\s[^>]*)?\/?>/gi, '');
  // Collapse 3+ consecutive newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // 1. Block fences: ```[lang]\ncontent\n``` → <pre>content</pre>
  text = text.replace(/```[\w]*\n([\s\S]*?)\n?```/g, (_, content) => {
    return `<pre>${escapeHtml(content)}</pre>`;
  });
  // 2. Inline code: `content` → <code>content</code> (no newlines inside)
  text = text.replace(/`([^`\n]+)`/g, (_, content) => {
    return `<code>${escapeHtml(content)}</code>`;
  });
  return text;
}

async function sendMessage(api, chatId, text, sessionId) {
  const MAX_TG = 4096;
  // Telegram HTML mode does not support <br> — replace with newlines before sending
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Convert leftover Markdown code fences to HTML (model sometimes mixes both formats)
  text = markdownToHtml(text);
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_TG) {
    chunks.push(text.slice(i, i + MAX_TG));
  }
  for (const chunk of chunks) {
    try {
      await api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    } catch (e) {
      if (e.error_code === 400) {
        console.error(`[telegram] HTML parse error chat_id=${chatId}, falling back to plaintext: ${e.description}`);
        if (sessionId) {
          const logFile = path.join(PATHS.logsDir, `session-${sessionId}.jsonl`);
          fs.promises.appendFile(logFile, JSON.stringify({
            ts: new Date().toISOString(),
            sessionId,
            type: 'telegram_parse_error',
            description: e.description || e.message,
          }) + '\n', 'utf8').catch(() => {});
        }
        await api.sendMessage(chatId, stripHtml(chunk));
      } else {
        throw e;
      }
    }
  }
}

// Known model context windows in tokens. Used by /context command.
// Partial match: checked with model.includes(key) so short keys like 'gpt-4o' match 'openrouter/gpt-4o'.
const MODEL_CONTEXT_WINDOWS = {
  'claude': 200000,         // all claude models (opus, sonnet, haiku)
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-3.5': 16385,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-2': 1000000,
  'llama-3.3': 128000,
  'llama-3.1': 128000,
  'mistral': 32000,
  'deepseek': 64000,
  'glm-5': 200000,
  'glm-4': 128000,
};

function lookupContextWindow(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (m.includes(key)) return size;
  }
  return null;
}

function nextCronDate(expression) {
  try {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minE, hourE, domE, monE, dowE] = parts;

    function matchField(expr, val) {
      if (expr === '*') return true;
      if (expr.includes(',')) return expr.split(',').some(p => matchField(p, val));
      if (expr.includes('/')) {
        const [range, step] = expr.split('/');
        const s = parseInt(step, 10);
        if (range === '*') return val % s === 0;
        const [lo, hi] = range.split('-').map(Number);
        return val >= lo && val <= hi && (val - lo) % s === 0;
      }
      if (expr.includes('-')) {
        const [lo, hi] = expr.split('-').map(Number);
        return val >= lo && val <= hi;
      }
      return parseInt(expr, 10) === val;
    }

    const candidate = new Date();
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    for (let i = 0; i < 10080; i++) {
      if (matchField(minE, candidate.getMinutes()) &&
          matchField(hourE, candidate.getHours()) &&
          matchField(domE, candidate.getDate()) &&
          matchField(monE, candidate.getMonth() + 1) &&
          matchField(dowE, candidate.getDay())) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  } catch { return null; }
}

function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export async function startTelegramChannel(config) {
  const { token, allowedUserIds } = config.telegram;

  if (!token) return;

  const bot = new Bot(token);
  const sessions = load();

  // Tracks chats with an active agent run per slot.
  // Keys are "chatId:slot" strings.
  const isRunning = new Set();
  const pendingMessages = new Map(); // "chatId:slot" -> [{text, attachments, ts}]
  const runStartTimes = new Map();   // "chatId:slot" -> Date

  // --- Slot helpers ---
  // sessions[chatId] is either:
  //   - undefined (no session yet)
  //   - string (legacy: single session ID, treated as slot 1)
  //   - { active: number, slots: { "1": sessionId, "2": sessionId, ... } }

  function getActiveSlot(chatId) {
    const d = sessions[chatId];
    if (!d || typeof d === 'string') return 1;
    return d.active ?? 1;
  }

  function getSessionId(chatId, slot) {
    const d = sessions[chatId];
    if (!d) return null;
    if (typeof d === 'string') return slot == 1 ? d : null;
    return d.slots?.[String(slot)] ?? null;
  }

  function setSessionId(chatId, slot, sessionId) {
    const d = sessions[chatId];
    if (!d || typeof d === 'string') {
      const legacy = typeof d === 'string' ? d : null;
      sessions[chatId] = { active: Number(slot), slots: {} };
      if (legacy) sessions[chatId].slots['1'] = legacy;
    }
    if (sessionId === null) {
      delete sessions[chatId].slots[String(slot)];
      if (Object.keys(sessions[chatId].slots).length === 0) {
        delete sessions[chatId];
      }
    } else {
      sessions[chatId].slots[String(slot)] = sessionId;
    }
    save(sessions);
  }

  function setActiveSlot(chatId, slot) {
    const d = sessions[chatId];
    if (!d || typeof d === 'string') {
      const legacy = typeof d === 'string' ? d : null;
      sessions[chatId] = { active: Number(slot), slots: {} };
      if (legacy) sessions[chatId].slots['1'] = legacy;
    } else {
      sessions[chatId].active = Number(slot);
    }
    save(sessions);
  }

  function slotKey(chatId, slot) {
    return `${chatId}:${slot}`;
  }

  // --- Commands ---

  await bot.api.setMyCommands([
    { command: 'new',     description: 'Reset the active slot (fresh session)' },
    { command: 'usage',   description: 'Token usage for the active slot' },
    { command: 'context', description: 'Estimated context size vs model limit' },
    { command: 'stop',    description: 'Stop the running agent on the active slot' },
    { command: 'slots',   description: 'Show all slots and their status' },
    { command: 'crons',   description: 'Show all crons, running status and next run' },
    { command: 'voice',   description: 'Toggle voice responses on/off (fish.audio TTS)' },
    { command: 'version', description: 'Show Jarvis version' },
    { command: 'update',  description: 'Update Jarvis to the latest version' },
    { command: 'restart', description: 'Restart Jarvis' },
  ]);

  bot.command('usage', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const slot = getActiveSlot(chatId);
    const sessionId = getSessionId(chatId, slot);
    if (!sessionId) {
      await ctx.reply('No active session. Send a message to start one.');
      return;
    }

    const session = await loadSession(sessionId);
    const u = session?.metadata?.tokenUsage;
    if (!u || (u.prompt === 0 && u.completion === 0)) {
      await ctx.reply('No token usage recorded for this session yet.');
      return;
    }

    const total = u.prompt + u.completion;
    const cacheRead = u.cacheRead || 0;
    const cacheCreation = u.cacheCreation || 0;
    const cacheLines = (cacheRead > 0 || cacheCreation > 0)
      ? `\nCache read:    ${cacheRead.toLocaleString()}\nCache written: ${cacheCreation.toLocaleString()}`
      : '';
    await ctx.reply(
      `Token usage for slot ${slot}:\nIn:    ${u.prompt.toLocaleString()}\nOut:   ${u.completion.toLocaleString()}\nTotal: ${total.toLocaleString()}${cacheLines}`
    );
  });

  bot.command('version', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;
    await ctx.reply(`Jarvis v${JARVIS_VERSION}`);
  });

  bot.command('update', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;
    await ctx.reply('Updating Jarvis...');
    try {
      const { stdout, stderr } = await execAsync('npm install -g @ducci/jarvis@latest', { timeout: 120000 });
      const out = (stdout + stderr).trim().slice(-1000) || 'Done.';
      await ctx.api.sendMessage(ctx.chat.id, `Update complete:\n${out}`);
    } catch (e) {
      await ctx.api.sendMessage(ctx.chat.id, `Update failed:\n${e.message.slice(0, 1000)}`);
    }
  });

  bot.command('restart', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;
    await ctx.reply('Restarting Jarvis...');
    // Fire and forget — process will exit before a response could be sent
    setTimeout(() => execAsync('jarvis restart').catch(() => {}), 500);
  });

  bot.command('context', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const slot = getActiveSlot(chatId);
    const sessionId = getSessionId(chatId, slot);
    if (!sessionId) {
      await ctx.reply('No active session. Send a message to start one.');
      return;
    }

    const session = await loadSession(sessionId);
    if (!session) {
      await ctx.reply('Could not load session.');
      return;
    }

    const totalMessages = Math.max(0, session.messages.length - 1); // exclude system prompt
    const windowed = session.messages.length <= config.messageWindow + 1
      ? session.messages
      : [session.messages[0], ...session.messages.slice(-config.messageWindow)];
    const inContext = Math.max(0, windowed.length - 1);
    const estimatedTokens = Math.round(JSON.stringify(windowed).length / 4);
    const model = config.selectedModel || 'unknown';
    const contextWindow = config.modelContextWindow || lookupContextWindow(model);

    let lines = [
      `<b>Context — Slot ${slot}</b>`,
      `Model: <code>${escapeHtml(model)}</code>`,
      `Messages on disk: ${totalMessages} | in context: ${inContext}`,
      `Estimated tokens: ~${estimatedTokens.toLocaleString()}`,
    ];

    if (contextWindow) {
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      const bar = pct >= 90 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
      lines.push(`Model context window: ${contextWindow.toLocaleString()}`);
      lines.push(`Usage: ${bar} ~${pct}%`);
    } else {
      lines.push(`Model context window: unknown`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('stop', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const slot = getActiveSlot(chatId);
    const sessionId = getSessionId(chatId, slot);
    const key = slotKey(chatId, slot);

    if (!isRunning.has(key) || !sessionId) {
      await ctx.reply('Nothing is currently running.');
      return;
    }

    requestAbort(sessionId);
    await appendTelegramChatLog(chatId, sessionId, 'SYSTEM', '--- /stop requested ---');
    await ctx.reply('Stopping current run... I\'ll send a summary when done.');
  });

  bot.command('new', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const slot = getActiveSlot(chatId);
    const key = slotKey(chatId, slot);
    pendingMessages.delete(key);
    const oldSessionId = getSessionId(chatId, slot);
    if (oldSessionId) {
      await appendTelegramChatLog(chatId, oldSessionId, 'SYSTEM', '--- /new: session reset ---');
      setSessionId(chatId, slot, null);
      console.log(`[telegram] session unlinked chat_id=${chatId} slot=${slot}`);
    }

    await ctx.reply(`New session started on slot ${slot}.`);
  });

  function buildSlotsDisplay(chatId) {
    const d = sessions[chatId];
    const activeSlot = getActiveSlot(chatId);

    const slotsMap = {};
    if (typeof d === 'string') {
      slotsMap['1'] = d;
    } else if (d && d.slots) {
      Object.assign(slotsMap, d.slots);
    }

    const slotNums = [...new Set(['1', ...Object.keys(slotsMap)])].sort((a, b) => Number(a) - Number(b));
    const maxSlot = Math.max(...slotNums.map(Number));
    const nextSlot = maxSlot + 1;

    // Status text
    const lines = ['<b>Slots:</b>'];
    for (const sn of slotNums) {
      const n = Number(sn);
      const sid = slotsMap[sn] ?? null;
      const key = slotKey(chatId, n);
      const activeMarker = n === activeSlot ? ' ← aktiv' : '';
      let statusIcon;
      if (isRunning.has(key)) {
        const startTime = runStartTimes.get(key);
        let elapsed = '';
        if (startTime) {
          const secs = Math.floor((Date.now() - startTime.getTime()) / 1000);
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          elapsed = m > 0 ? ` (seit ${m}m ${s}s)` : ` (seit ${s}s)`;
        }
        statusIcon = `🟢 läuft${elapsed}`;
      } else if (sid) {
        statusIcon = '💬 bereit';
      } else {
        statusIcon = '➕ leer';
      }
      lines.push(`Slot ${n}: ${statusIcon}${activeMarker}`);
    }
    if (!isRunning.has(slotKey(chatId, nextSlot)) && !slotsMap[String(nextSlot)]) {
      lines.push(`Slot ${nextSlot}: ➕ leer`);
    }

    // Inline keyboard
    const kb = new InlineKeyboard();
    for (const sn of slotNums) {
      const n = Number(sn);
      const sid = slotsMap[sn] ?? null;
      const key = slotKey(chatId, n);
      const running = isRunning.has(key);
      if (n === activeSlot) {
        kb.text(`✓ Slot ${n} (aktiv)`, `slots_noop`);
      } else {
        kb.text(`↩️ Slot ${n}`, `slots_switch_${n}`);
      }
      if (sid && !running) {
        kb.text(`🗑️`, `slots_del_${n}`);
      }
      kb.row();
    }
    // Button for the next empty slot
    kb.text(`➕ Slot ${nextSlot} (neu)`, `slots_switch_${nextSlot}`);

    return { text: lines.join('\n'), keyboard: kb };
  }

  bot.command('slots', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const { text, keyboard } = buildSlotsDisplay(chatId);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery(/^slots_switch_(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) { await ctx.answerCallbackQuery(); return; }

    const chatId = ctx.chat.id;
    const n = parseInt(ctx.match[1], 10);
    setActiveSlot(chatId, n);
    const key = slotKey(chatId, n);
    const sid = getSessionId(chatId, n);
    let status;
    if (isRunning.has(key)) status = '🟢 läuft';
    else if (sid) status = '💬 bereit';
    else status = '➕ leer (neue Session beim nächsten Message)';

    const { text, keyboard } = buildSlotsDisplay(chatId);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery(`Slot ${n} aktiv — ${status}`);
  });

  bot.callbackQuery(/^slots_del_(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) { await ctx.answerCallbackQuery(); return; }

    const chatId = ctx.chat.id;
    const n = parseInt(ctx.match[1], 10);
    const key = slotKey(chatId, n);

    if (isRunning.has(key) || pendingMessages.has(key)) {
      await ctx.answerCallbackQuery(`Slot ${n} läuft gerade — erst /stop`);
      return;
    }

    const oldSid = getSessionId(chatId, n);
    if (oldSid) {
      await appendTelegramChatLog(chatId, oldSid, 'SYSTEM', `--- slot del ${n} (via keyboard) ---`);
    }
    setSessionId(chatId, n, null);
    pendingMessages.delete(key);
    runStartTimes.delete(key);

    if (getActiveSlot(chatId) === n) {
      setActiveSlot(chatId, 1);
    }

    const { text, keyboard } = buildSlotsDisplay(chatId);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery(`Slot ${n} gelöscht`);
  });

  bot.callbackQuery('slots_noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.command('crons', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(PATHS.cronsFile, 'utf8'));
    } catch { /* no crons file */ }

    if (entries.length === 0) {
      await ctx.reply('Keine Crons konfiguriert.');
      return;
    }

    const runningMap = getRunningCrons(); // id -> startDate
    const now = Date.now();
    const lines = ['<b>Crons:</b>'];

    for (const entry of entries) {
      const running = isRunningCron(entry.id);
      let statusLine;

      if (running) {
        const startDate = runningMap.get(entry.id);
        let elapsed = '';
        if (startDate) {
          const secs = Math.floor((now - startDate.getTime()) / 1000);
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          elapsed = m > 0 ? ` (seit ${m}m ${s}s)` : ` (seit ${s}s)`;
        }
        statusLine = `🟢 läuft${elapsed}`;
      } else {
        const nextDate = nextCronDate(entry.schedule);
        if (nextDate) {
          const diffMins = Math.round((nextDate.getTime() - now) / 60000);
          statusLine = `⏰ in ${formatMinutes(diffMins)}`;
        } else {
          statusLine = `⏰ unbekannt`;
        }
      }

      const onceMark = entry.once ? ' <i>(einmalig)</i>' : '';
      lines.push(`\n<b>${escapeHtml(entry.name)}</b>${onceMark}`);
      lines.push(`${statusLine}`);
      lines.push(`<code>${escapeHtml(entry.schedule)}</code>`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('voice', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    if (!config.fishAudioApiKey) {
      await ctx.reply('fish.audio not configured. Add FISH_AUDIO_API_KEY to ~/.jarvis/.env first.');
      return;
    }

    // Toggle voiceEnabled in settings.json and update live config
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8'));
    } catch { /* ignore */ }
    settings.voiceEnabled = !config.voiceEnabled;
    fs.writeFileSync(PATHS.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    config.voiceEnabled = settings.voiceEnabled;

    const status = config.voiceEnabled ? 'on' : 'off';
    await ctx.reply(`Voice responses: <b>${status}</b>`, { parse_mode: 'HTML' });
  });

  // Runs one or more batches until the pending queue is drained.
  // Each iteration takes all currently pending messages, merges them into a
  // single user turn, calls handleChat once, and sends one response.
  async function processQueue(api, chatId, slot, firstBatch) {
    let batch = firstBatch;
    while (batch.length > 0) {
      const sessionId = getSessionId(chatId, slot) || null;
      const combinedText = batch.length === 1
        ? batch[0].text
        : batch.map(m => m.text).join('\n\n');
      const rawAttachments = batch.flatMap(m => m.attachments);

      // If a vision model is configured and the batch contains images, run a one-shot
      // image analysis first and inject the result as text into the main agent turn.
      let userText = combinedText;
      let allAttachments = rawAttachments;
      if (config.visionModel && config.visionApiKey && rawAttachments.length > 0) {
        try {
          const results = await Promise.allSettled(
            rawAttachments.map(a => describeImage(a, combinedText, config))
          );
          const successfulDescs = results
            .filter(r => r.status === 'fulfilled')
            .map(r => `[Image analysis: ${r.value}]`);
          const failedCount = results.filter(r => r.status === 'rejected').length;
          if (failedCount > 0) {
            console.error(`[telegram] vision error for ${failedCount}/${results.length} image(s), those will be sent directly to main agent`);
          }
          if (successfulDescs.length > 0) {
            const descBlock = successfulDescs.join('\n\n');
            userText = combinedText ? `${descBlock}\n\n${combinedText}` : descBlock;
          }
          // Only clear attachments for images that were successfully described
          allAttachments = rawAttachments.filter((_, i) => results[i].status === 'rejected');
        } catch (e) {
          console.error(`[telegram] vision error, falling back to direct image: ${e.message}`);
          // allAttachments and userText stay unchanged — main agent gets the raw image
        }
      }

      let lastCheckpointSent = null;
      let result;
      const key = slotKey(chatId, slot);
      try {
        result = await handleChat(config, sessionId, userText, allAttachments, async (checkpointResponse) => {
          const rawText = typeof checkpointResponse === 'string' ? checkpointResponse : JSON.stringify(checkpointResponse);
          const currentActive = getActiveSlot(chatId);
          const prefixed = slot !== currentActive ? `[Slot ${slot}] ${rawText}` : rawText;
          lastCheckpointSent = prefixed;
          await appendTelegramChatLog(chatId, getSessionId(chatId, slot) || null, 'JARVIS', prefixed);
          await sendMessage(api, chatId, prefixed, getSessionId(chatId, slot) || null);
        });
      } catch (e) {
        console.error(`[telegram] agent error chat_id=${chatId} slot=${slot}: ${e.message}`);
        const errText = e.message
          ? `Sorry, something went wrong: ${e.message}`
          : 'Sorry, something went wrong. Please try again.';
        await api.sendMessage(chatId, errText).catch(() => {});
        batch = pendingMessages.get(key) || [];
        pendingMessages.delete(key);
        continue;
      }

      if (!getSessionId(chatId, slot)) {
        setSessionId(chatId, slot, result.sessionId);
        console.log(`[telegram] session created slot=${slot} sessionId=${result.sessionId.slice(0, 8)}`);
      }

      // Log each original message individually with its own timestamp
      for (const m of batch) {
        await appendTelegramChatLog(chatId, result.sessionId, 'USER', m.text || '[photo]', m.ts);
      }

      try {
        const rawResponse = typeof result.response === 'string'
          ? result.response
          : result.response != null ? JSON.stringify(result.response, null, 2) : '';
        const text = rawResponse.trim()
          || 'The agent encountered an error and could not produce a response. Please try again.';
        // Prefix response with slot number if the user has switched away from this slot
        const currentActive = getActiveSlot(chatId);
        const displayText = slot !== currentActive ? `[Slot ${slot}] ${text}` : text;
        // Skip sending if this response was already sent as a checkpoint update —
        // intervention_required and zero-progress reuse the last checkpoint response
        // as their finalResponse, which would otherwise cause a duplicate message.
        if (displayText !== lastCheckpointSent) {
          await appendTelegramChatLog(chatId, result.sessionId, 'JARVIS', displayText);
          await sendMessage(api, chatId, displayText, result.sessionId);
          console.log(`[telegram] response sent chat_id=${chatId} slot=${slot} length=${displayText.length}`);
          // TTS: send audio summary if voice is enabled (config.voiceEnabled checked live, updated by /voice toggle)
          if (config.voiceEnabled && config.fishAudioApiKey) {
            try {
              // If the response is a raw JSON blob (format_error recovery), extract the actual text
              let ttsSource = displayText;
              try {
                const parsed = JSON.parse(displayText);
                if (parsed?.response) ttsSource = parsed.response;
              } catch { /* not JSON, use as-is */ }
              const plain = toPlainText(ttsSource);
              if (plain) {
                const ttsText = await generateTtsSummary(plain, config);
                if (ttsText) {
                  const audioBuffer = await textToSpeech(ttsText, config);
                  await api.sendAudio(chatId, new InputFile(audioBuffer, 'response.mp3'));
                  console.log(`[telegram] voice sent chat_id=${chatId} slot=${slot} tts_chars=${ttsText.length}`);
                }
              }
            } catch (e) {
              console.error(`[telegram] TTS error chat_id=${chatId}: ${e.message}`);
              await api.sendMessage(chatId, `[TTS error: ${e.message}]`).catch(() => {});
            }
          }
        } else {
          console.log(`[telegram] skipped duplicate final response chat_id=${chatId} slot=${slot}`);
        }
      } catch (e) {
        console.error(`[telegram] delivery error chat_id=${chatId} slot=${slot}: ${e.message}`);
        await api.sendMessage(chatId, 'Sorry, something went wrong sending the response. Please try again.').catch(() => {});
      }

      // Drain any messages that arrived while we were running
      batch = pendingMessages.get(key) || [];
      pendingMessages.delete(key);
    }
  }

  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const ts = new Date().toISOString();

    console.log(`[telegram] incoming photo chat_id=${chatId}`);

    // Download the photo first regardless of whether we buffer or run immediately
    let attachment;
    try {
      const photo = ctx.message.photo.filter(p => p.width <= 800).at(-1)
        ?? ctx.message.photo[0];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const imgResponse = await fetch(fileUrl);
      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      attachment = { url: `data:image/jpeg;base64,${base64}` };
    } catch (e) {
      console.error(`[telegram] photo download error chat_id=${chatId}: ${e.message}`);
      await ctx.reply('Sorry, could not process the photo.').catch(() => {});
      return;
    }

    const entry = { text: ctx.message.caption || '', attachments: [attachment], ts };
    const slot = getActiveSlot(chatId);
    const key = slotKey(chatId, slot);

    if (isRunning.has(key)) {
      if (!pendingMessages.has(key)) pendingMessages.set(key, []);
      pendingMessages.get(key).push(entry);
      console.log(`[telegram] buffered photo chat_id=${chatId} slot=${slot} pending=${pendingMessages.get(key).length}`);
      return;
    }

    isRunning.add(key);
    runStartTimes.set(key, new Date());
    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await processQueue(ctx.api, chatId, slot, [entry]);
    } finally {
      clearInterval(typingInterval);
      isRunning.delete(key);
      runStartTimes.delete(key);
    }
  });

  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const ts = new Date().toISOString();

    if (!config.fishAudioApiKey) {
      await ctx.reply('Voice input not configured. Add FISH_AUDIO_API_KEY to ~/.jarvis/.env first.');
      return;
    }

    console.log(`[telegram] incoming voice chat_id=${chatId}`);
    await ctx.api.sendChatAction(chatId, 'typing');

    // Download voice file (OGG/Opus from Telegram)
    let transcription;
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      transcription = await speechToText(audioBuffer, config);
    } catch (e) {
      console.error(`[telegram] STT error chat_id=${chatId}: ${e.message}`);
      await ctx.reply(`Voice transcription failed: ${e.message}`).catch(() => {});
      return;
    }

    if (!transcription) {
      await ctx.reply('Could not transcribe voice message (empty result).').catch(() => {});
      return;
    }

    console.log(`[telegram] voice transcribed chat_id=${chatId}: "${transcription.slice(0, 80)}"`);
    // Echo transcription back so user can confirm what was understood
    await ctx.reply(`<i>🎤 ${escapeHtml(transcription)}</i>`, { parse_mode: 'HTML' }).catch(() => {});

    const entry = { text: transcription, attachments: [], ts };
    const slot = getActiveSlot(chatId);
    const key = slotKey(chatId, slot);

    if (isRunning.has(key)) {
      if (!pendingMessages.has(key)) pendingMessages.set(key, []);
      pendingMessages.get(key).push(entry);
      console.log(`[telegram] buffered voice chat_id=${chatId} slot=${slot} pending=${pendingMessages.get(key).length}`);
      return;
    }

    isRunning.add(key);
    runStartTimes.set(key, new Date());
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await processQueue(ctx.api, chatId, slot, [entry]);
    } finally {
      clearInterval(typingInterval);
      isRunning.delete(key);
      runStartTimes.delete(key);
    }
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;

    // Allowlist guard — silently ignore unauthorized users
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const ts = new Date().toISOString();
    const entry = { text: ctx.message.text, attachments: [], ts };
    const slot = getActiveSlot(chatId);
    const key = slotKey(chatId, slot);

    if (isRunning.has(key)) {
      if (!pendingMessages.has(key)) pendingMessages.set(key, []);
      pendingMessages.get(key).push(entry);
      console.log(`[telegram] buffered message chat_id=${chatId} slot=${slot} pending=${pendingMessages.get(key).length}`);
      return;
    }

    isRunning.add(key);
    runStartTimes.set(key, new Date());
    console.log(`[telegram] incoming chat_id=${chatId} slot=${slot}`);
    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await processQueue(ctx.api, chatId, slot, [entry]);
    } finally {
      clearInterval(typingInterval);
      isRunning.delete(key);
      runStartTimes.delete(key);
    }
  });

  run(bot);
  console.log('[telegram] channel started');
}
