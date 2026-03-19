import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';
import { run } from '@grammyjs/runner';
import { handleChat, requestAbort } from '../../server/agent.js';
import { loadSession } from '../../server/sessions.js';
import { PATHS } from '../../server/config.js';
import { load, save } from './sessions.js';
import { describeImage } from '../../server/vision.js';

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

export async function startTelegramChannel(config) {
  const { token, allowedUserIds } = config.telegram;

  if (!token) return;

  const bot = new Bot(token);
  const sessions = load();

  // Tracks chats with an active agent run and buffers messages arriving during that run.
  // When the run finishes all buffered messages are merged into one combined run.
  const isRunning = new Set();
  const pendingMessages = new Map(); // chatId -> [{text, attachments, ts}]

  await bot.api.setMyCommands([
    { command: 'new', description: 'Start a fresh session' },
    { command: 'usage', description: 'Show token usage for the current session' },
    { command: 'stop', description: 'Stop the current run' },
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

  bot.command('stop', async (ctx) => {
    const userId = ctx.from?.id;
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const sessionId = sessions[chatId];

    if (!isRunning.has(chatId) || !sessionId) {
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
    pendingMessages.delete(chatId);
    if (sessions[chatId]) {
      await appendTelegramChatLog(chatId, sessions[chatId], 'SYSTEM', '--- /new: session reset ---');
      delete sessions[chatId];
      save(sessions);
      console.log(`[telegram] session unlinked chat_id=${chatId}`);
    }

    await ctx.reply('New session started.');
  });

  // Runs one or more batches until the pending queue is drained.
  // Each iteration takes all currently pending messages, merges them into a
  // single user turn, calls handleChat once, and sends one response.
  async function processQueue(api, chatId, firstBatch) {
    let batch = firstBatch;
    while (batch.length > 0) {
      const sessionId = sessions[chatId] || null;
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
      try {
        result = await handleChat(config, sessionId, userText, allAttachments, async (checkpointResponse) => {
          const text = typeof checkpointResponse === 'string' ? checkpointResponse : JSON.stringify(checkpointResponse);
          lastCheckpointSent = text;
          await appendTelegramChatLog(chatId, sessions[chatId] || null, 'JARVIS', text);
          await sendMessage(api, chatId, text, sessions[chatId] || null);
        });
      } catch (e) {
        console.error(`[telegram] agent error chat_id=${chatId}: ${e.message}`);
        const errText = e.message
          ? `Sorry, something went wrong: ${e.message}`
          : 'Sorry, something went wrong. Please try again.';
        await api.sendMessage(chatId, errText).catch(() => {});
        batch = pendingMessages.get(chatId) || [];
        pendingMessages.delete(chatId);
        continue;
      }

      if (!sessions[chatId]) {
        sessions[chatId] = result.sessionId;
        save(sessions);
        console.log(`[telegram] session created sessionId=${result.sessionId.slice(0, 8)}`);
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
        // Skip sending if this response was already sent as a checkpoint update —
        // intervention_required and zero-progress reuse the last checkpoint response
        // as their finalResponse, which would otherwise cause a duplicate message.
        if (text !== lastCheckpointSent) {
          await appendTelegramChatLog(chatId, result.sessionId, 'JARVIS', text);
          await sendMessage(api, chatId, text, result.sessionId);
          console.log(`[telegram] response sent chat_id=${chatId} length=${text.length}`);
        } else {
          console.log(`[telegram] skipped duplicate final response chat_id=${chatId}`);
        }
      } catch (e) {
        console.error(`[telegram] delivery error chat_id=${chatId}: ${e.message}`);
        await api.sendMessage(chatId, 'Sorry, something went wrong sending the response. Please try again.').catch(() => {});
      }

      // Drain any messages that arrived while we were running
      batch = pendingMessages.get(chatId) || [];
      pendingMessages.delete(chatId);
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

    if (isRunning.has(chatId)) {
      if (!pendingMessages.has(chatId)) pendingMessages.set(chatId, []);
      pendingMessages.get(chatId).push(entry);
      console.log(`[telegram] buffered photo chat_id=${chatId} pending=${pendingMessages.get(chatId).length}`);
      return;
    }

    isRunning.add(chatId);
    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await processQueue(ctx.api, chatId, [entry]);
    } finally {
      clearInterval(typingInterval);
      isRunning.delete(chatId);
    }
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;

    // Allowlist guard — silently ignore unauthorized users
    if (!allowedUserIds.includes(userId)) return;

    const chatId = ctx.chat.id;
    const ts = new Date().toISOString();
    const entry = { text: ctx.message.text, attachments: [], ts };

    if (isRunning.has(chatId)) {
      if (!pendingMessages.has(chatId)) pendingMessages.set(chatId, []);
      pendingMessages.get(chatId).push(entry);
      console.log(`[telegram] buffered message chat_id=${chatId} pending=${pendingMessages.get(chatId).length}`);
      return;
    }

    isRunning.add(chatId);
    console.log(`[telegram] incoming chat_id=${chatId}`);
    await ctx.api.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await processQueue(ctx.api, chatId, [entry]);
    } finally {
      clearInterval(typingInterval);
      isRunning.delete(chatId);
    }
  });

  run(bot);
  console.log('[telegram] channel started');
}
