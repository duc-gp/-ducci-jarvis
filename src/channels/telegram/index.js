import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';
import { run } from '@grammyjs/runner';
import { handleChat } from '../../server/agent.js';
import { loadSession } from '../../server/sessions.js';
import { PATHS } from '../../server/config.js';
import { load, save } from './sessions.js';

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

async function sendMessage(api, chatId, text, sessionId) {
  const MAX_TG = 4096;
  // Telegram HTML mode does not support <br> — replace with newlines before sending
  text = text.replace(/<br\s*\/?>/gi, '\n');
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
        await api.sendMessage(chatId, chunk);
      } else {
        throw e;
      }
    }
  }
}

export async function startTelegramChannel(config) {
  const { token, allowedUserIds } = config.telegram;

  if (!token) return;

  const bot = new Bot(token);
  const sessions = load();

  await bot.api.setMyCommands([
    { command: 'new', description: 'Start a fresh session' },
    { command: 'usage', description: 'Show token usage for the current session' },
  ]);

  bot.command('usage', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const sessionId = sessions[chatId];
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
      `Token usage for current session:\nIn:    ${u.prompt.toLocaleString()}\nOut:   ${u.completion.toLocaleString()}\nTotal: ${total.toLocaleString()}${cacheLines}`
    );
  });

  bot.command('new', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    if (sessions[chatId]) {
      await appendTelegramChatLog(chatId, sessions[chatId], 'SYSTEM', '--- /new: session reset ---');
      delete sessions[chatId];
      save(sessions);
      console.log(`[telegram] session unlinked chat_id=${chatId}`);
    }

    await ctx.reply('New session started.');
  });

  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const sessionId = sessions[chatId] || null;

    console.log(`[telegram] incoming photo chat_id=${chatId}`);

    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    const userTs = new Date().toISOString();
    let result;
    try {
      const photo = ctx.message.photo.filter(p => p.width <= 800).at(-1)
        ?? ctx.message.photo[0];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const imgResponse = await fetch(fileUrl);
      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      const caption = ctx.message.caption || '';
      result = await handleChat(config, sessionId, caption, [{ url: dataUrl }]);
    } catch (e) {
      console.error(`[telegram] agent error chat_id=${chatId}: ${e.message}`);
      const errText = e.message
        ? `Sorry, something went wrong: ${e.message}`
        : 'Sorry, something went wrong. Please try again.';
      await ctx.reply(errText).catch(() => {});
      clearInterval(typingInterval);
      return;
    }

    if (!sessions[chatId]) {
      sessions[chatId] = result.sessionId;
      save(sessions);
      console.log(`[telegram] session created sessionId=${result.sessionId.slice(0, 8)}`);
    }

    const captionText = ctx.message.caption || '[photo]';
    await appendTelegramChatLog(chatId, result.sessionId, 'USER', `[photo] ${captionText}`, userTs);

    try {
      const rawResponse = typeof result.response === 'string'
        ? result.response
        : result.response != null ? JSON.stringify(result.response, null, 2) : '';
      const text = rawResponse.trim()
        || 'The agent encountered an error and could not produce a response. Please try again.';
      await appendTelegramChatLog(chatId, result.sessionId, 'JARVIS', text);
      await sendMessage(ctx.api, chatId, text, result.sessionId);
      console.log(`[telegram] response sent chat_id=${chatId} length=${text.length}`);
    } catch (e) {
      console.error(`[telegram] delivery error chat_id=${chatId}: ${e.message}`);
      await ctx.api.sendMessage(chatId, 'Sorry, something went wrong sending the response. Please try again.').catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;

    // Allowlist guard — silently ignore unauthorized users
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const sessionId = sessions[chatId] || null;

    console.log(`[telegram] incoming chat_id=${chatId}`);

    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    const userTs = new Date().toISOString();
    let result;
    try {
      result = await handleChat(config, sessionId, ctx.message.text);
    } catch (e) {
      console.error(`[telegram] agent error chat_id=${chatId}: ${e.message}`);
      const errText = e.message
        ? `Sorry, something went wrong: ${e.message}`
        : 'Sorry, something went wrong. Please try again.';
      await ctx.reply(errText).catch(() => {});
      clearInterval(typingInterval);
      return;
    }

    // Persist new session mapping on first message
    if (!sessions[chatId]) {
      sessions[chatId] = result.sessionId;
      save(sessions);
      console.log(`[telegram] session created sessionId=${result.sessionId.slice(0, 8)}`);
    }

    await appendTelegramChatLog(chatId, result.sessionId, 'USER', ctx.message.text, userTs);

    try {
      // Guard against empty or non-string response (e.g. model returns array instead of string)
      const rawResponse = typeof result.response === 'string'
        ? result.response
        : result.response != null ? JSON.stringify(result.response, null, 2) : '';
      const text = rawResponse.trim()
        || 'The agent encountered an error and could not produce a response. Please try again.';
      await appendTelegramChatLog(chatId, result.sessionId, 'JARVIS', text);
      await sendMessage(ctx.api, chatId, text, result.sessionId);
      console.log(`[telegram] response sent chat_id=${chatId} length=${text.length}`);
    } catch (e) {
      console.error(`[telegram] delivery error chat_id=${chatId}: ${e.message}`);
      await ctx.api.sendMessage(chatId, 'Sorry, something went wrong sending the response. Please try again.').catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  });

  run(bot);
  console.log('[telegram] channel started');
}
