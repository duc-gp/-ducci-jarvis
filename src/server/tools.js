import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from './config.js';

const _require = createRequire(import.meta.url);
const __jarvisDir = path.dirname(fileURLToPath(import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const TOOL_TIMEOUT_MS = 60_000;

const SEED_TOOLS = {
  read_file: {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from disk. Returns the file content as a string. Use offset and limit to read large files in chunks instead of loading everything at once.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or relative path to the file to read.',
            },
            offset: {
              type: 'number',
              description: 'Line number to start reading from (1-based). Omit to start from the beginning.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of lines to return. Omit to read the entire file (or remainder from offset).',
            },
          },
          required: ['path'],
        },
      },
    },
    code: `
      const _p = args.path; const targetPath = path.resolve(_p === '~' || _p.startsWith('~/') ? require('os').homedir() + _p.slice(1) : _p);
      const raw = await fs.promises.readFile(targetPath, 'utf8');
      const lines = raw.split('\\n');
      const offset = args.offset ? args.offset - 1 : 0;
      const slice = args.limit ? lines.slice(offset, offset + args.limit) : lines.slice(offset);
      const totalLines = lines.length;
      return { status: 'ok', path: targetPath, content: slice.join('\\n'), totalLines, returnedLines: slice.length, offset: offset + 1 };
    `,
  },
  exec: {
    timeout: 300_000, // 5 minutes — scans, builds, and long commands need more than 60s
    definition: {
      type: 'function',
      function: {
        name: 'exec',
        description: 'Execute an arbitrary shell command on the server. Returns stdout, stderr, and exit code. Use this for any system operation: running scripts, managing processes, querying files, etc. Has a 5-minute timeout. Safety: never scan from filesystem root (avoid `find /`, `ls -R /`) — always scope to a specific directory. Prefer `grep`, `head`, or `tail` over `cat` on unknown files. Use `which <binary>` to locate executables. Avoid commands with unbounded runtime.',
        parameters: {
          type: 'object',
          properties: {
            cmd: {
              type: 'string',
              description: 'The shell command to execute.',
            },
          },
          required: ['cmd'],
        },
      },
    },
    code: `
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);
      try {
        const { stdout, stderr } = await execAsync(args.cmd, {
          encoding: "utf8",
          timeout: 270000, // 4.5 min — leaves headroom before the outer 5-min tool timeout
          maxBuffer: 2 * 1024 * 1024,
        });
        return { status: "ok", exitCode: 0, stdout, stderr };
      } catch (e) {
        return { status: "error", exitCode: e.code || 1, stdout: e.stdout || "", stderr: e.stderr || "" };
      }
    `,
  },
  save_user_info: {
    definition: {
      type: 'function',
      function: {
        name: 'save_user_info',
        description: 'Persist facts about the user (e.g., name, timezone, preferences). Items with the same key are overwritten. Use this whenever the user shares personal information worth remembering.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Fact identifier (e.g., "timezone", "name").' },
                  value: { type: 'string', description: 'The fact value.' },
                },
                required: ['key', 'value'],
              },
              description: 'Array of key-value facts to save.',
            },
          },
          required: ['items'],
        },
      },
    },
    code: `const filePath = path.join(process.env.HOME, '.jarvis/data/user-info.json'); const raw = await fs.promises.readFile(filePath, 'utf8').catch(() => '{"items":[]}'); const data = JSON.parse(raw); const items = args.items || []; for (const item of items) { const idx = data.items.findIndex(i => i.key === item.key); const entry = { key: item.key, value: item.value, ts: new Date().toISOString() }; if (idx >= 0) data.items[idx] = entry; else data.items.push(entry); } await fs.promises.mkdir(path.dirname(filePath), { recursive: true }); await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8'); return { status: 'ok', saved: items.length };`,
  },
  read_user_info: {
    definition: {
      type: 'function',
      function: {
        name: 'read_user_info',
        description: 'Read all stored user facts. Returns the full list of known user information. Use this when you need to recall something about the user.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    code: `const filePath = path.join(process.env.HOME, '.jarvis/data/user-info.json'); const raw = await fs.promises.readFile(filePath, 'utf8').catch(() => '{"items":[]}'); const { items } = JSON.parse(raw); return { status: 'ok', items };`,
  },
  npm_install: {
    definition: {
      type: 'function',
      function: {
        name: 'npm_install',
        description: 'Install an npm package into the jarvis project so it can be used in tool code via require(). Always use this instead of exec to install packages.',
        parameters: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'The npm package name to install, e.g. "@perplexity-ai/sdk" or "axios".',
            },
          },
          required: ['packageName'],
        },
      },
    },
    code: `
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const projectRoot = path.resolve(__jarvisDir, '../..');
      try {
        const { stdout, stderr } = await execAsync('npm install ' + args.packageName, {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 60000,
        });
        return { status: 'ok', packageName: args.packageName, stdout, stderr };
      } catch (e) {
        return { status: 'error', packageName: args.packageName, stderr: e.stderr || e.message };
      }
    `,
  },
  perplexity_search: {
    requires: 'PERPLEXITY_API_KEY',
    definition: {
      type: 'function',
      function: {
        name: 'perplexity_search',
        description: 'Search the web using Perplexity AI. Returns an answer grounded in real-time web results with citations. Use this for current events, factual lookups, or research questions. Use sparingly — at most 3 searches per topic. Do not repeat the same query with minor variations; if an initial search does not yield what you need, switch to a different approach or verify locally with exec.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query or question.',
            },
            model: {
              type: 'string',
              enum: ['sonar', 'sonar-pro', 'sonar-deep-research'],
              description: 'Search model to use. sonar: fast and cheap, good for simple lookups. sonar-pro: deeper multi-step search, more citations, better for complex questions. sonar-deep-research: long-form research reports. Defaults to sonar.',
            },
            search_recency_filter: {
              type: 'string',
              enum: ['hour', 'day', 'week', 'month', 'year'],
              description: 'Optional time filter to restrict results to recent content.',
            },
          },
          required: ['query'],
        },
      },
    },
    code: `
      const OpenAI = require('openai');
      const client = new OpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY,
        baseURL: 'https://api.perplexity.ai',
      });
      const params = {
        model: args.model || 'sonar',
        messages: [{ role: 'user', content: args.query }],
      };
      if (args.search_recency_filter) params.search_recency_filter = args.search_recency_filter;
      const response = await client.chat.completions.create(params);
      const answer = response.choices[0].message.content;
      const citations = response.citations || [];
      return { answer, citations };
    `,
  },
  system_install: {
    timeout: 300_000, // 5 minutes — package downloads and installs routinely exceed 60s
    definition: {
      type: 'function',
      function: {
        name: 'system_install',
        description: 'Install a system binary using the available package manager (brew on macOS, apt-get on Debian/Ubuntu, snap as fallback). Always use this instead of exec for installing system packages — it auto-detects the package manager and has a 5-minute timeout sized for real downloads. If the binary is already on PATH it returns immediately without installing. Examples: nuclei, subfinder, naabu, jq, curl, git.',
        parameters: {
          type: 'object',
          properties: {
            package: {
              type: 'string',
              description: 'The package name to install, e.g. "nuclei", "jq", "curl".',
            },
            packageManager: {
              type: 'string',
              enum: ['brew', 'apt-get', 'snap'],
              description: 'Optional. Force a specific package manager instead of auto-detecting.',
            },
          },
          required: ['package'],
        },
      },
    },
    code: `
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      // If the binary is already installed, return immediately.
      try {
        const { stdout: whichOut } = await execAsync('which ' + args.package, { timeout: 5000 });
        if (whichOut.trim()) {
          return { status: 'ok', alreadyInstalled: true, package: args.package, path: whichOut.trim() };
        }
      } catch {}

      // Auto-detect package manager if not specified.
      let pm = args.packageManager;
      if (!pm) {
        for (const candidate of ['brew', 'apt-get', 'snap']) {
          try {
            await execAsync('which ' + candidate, { timeout: 5000 });
            pm = candidate;
            break;
          } catch {}
        }
      }

      if (!pm) {
        return { status: 'error', package: args.package, error: 'No supported package manager found (brew, apt-get, snap). Install one first or use exec to install manually.' };
      }

      // Build install command. apt-get always runs update first to avoid stale
      // package lists causing "package not found" errors.
      let cmd;
      if (pm === 'apt-get') {
        cmd = 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y ' + args.package;
      } else if (pm === 'brew') {
        cmd = 'brew install ' + args.package;
      } else {
        cmd = pm + ' install ' + args.package;
      }

      try {
        const { stdout, stderr } = await execAsync(cmd, {
          encoding: 'utf8',
          timeout: 270000, // 4.5 min — leaves headroom before the outer 5-min tool timeout
          maxBuffer: 2 * 1024 * 1024,
        });
        return { status: 'ok', packageManager: pm, package: args.package, stdout, stderr };
      } catch (e) {
        return { status: 'error', packageManager: pm, package: args.package, exitCode: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
      }
    `,
  },
  write_file: {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new file or completely overwrite an existing file. Content is written exactly as provided — dollar signs, backslashes, and special characters are preserved without modification. Always prefer this over exec+echo, exec+printf, or exec+heredoc. For shell scripts, pass mode: "755". For targeted edits to an existing file (changing a specific line or section), use edit_file instead.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or relative path to the file to write. Parent directories are created automatically.',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file. Written as-is — no shell interpretation occurs.',
            },
            mode: {
              type: 'string',
              description: 'Optional Unix file mode in octal string form, e.g. "755" for executable scripts, "644" for regular files. Defaults to "644".',
            },
          },
          required: ['path', 'content'],
        },
      },
    },
    code: `
      const _p = args.path; const targetPath = path.resolve(_p === '~' || _p.startsWith('~/') ? require('os').homedir() + _p.slice(1) : _p);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, args.content, 'utf8');
      if (args.mode) {
        await fs.promises.chmod(targetPath, parseInt(args.mode, 8));
      }
      const bytes = Buffer.byteLength(args.content, 'utf8');
      return { status: 'ok', path: targetPath, bytes, mode: args.mode || '644' };
    `,
  },
  edit_file: {
    definition: {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace an exact string in a file with a new string. Use this for targeted edits — you only need to provide the specific section to change, not the whole file. old_string must match exactly (including whitespace and indentation) and must appear exactly once in the file. If it appears more than once, add more surrounding context to make it unique. For creating new files or rewriting entire files, use write_file instead.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or relative path to the file to edit.',
            },
            old_string: {
              type: 'string',
              description: 'The exact string to find and replace. Must match character-for-character including whitespace and indentation.',
            },
            new_string: {
              type: 'string',
              description: 'The string to replace old_string with.',
            },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    code: `
      const _p = args.path; const targetPath = path.resolve(_p === '~' || _p.startsWith('~/') ? require('os').homedir() + _p.slice(1) : _p);
      const content = await fs.promises.readFile(targetPath, 'utf8');
      const count = content.split(args.old_string).length - 1;
      if (count === 0) {
        return { status: 'error', error: 'old_string not found in file. Check for exact whitespace and indentation match.' };
      }
      if (count > 1) {
        return { status: 'error', error: \`old_string found \${count} times. Add more surrounding context to make it unique.\` };
      }
      const updated = content.replace(args.old_string, args.new_string);
      await fs.promises.writeFile(targetPath, updated, 'utf8');
      return { status: 'ok', path: targetPath };
    `,
  },
  get_current_time: {
    definition: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Returns the current server time. Always call this before creating a cron. Note: returns server time — if you know the user\'s timezone, convert the desired user-local time to server time before computing the cron expression.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    code: `
      const now = new Date();
      return {
        status: 'ok',
        iso: now.toISOString(),
        local: now.toLocaleString(),
        utcOffset: -now.getTimezoneOffset() / 60,
      };
    `,
  },
  create_cron: {
    definition: {
      type: 'function',
      function: {
        name: 'create_cron',
        description: 'Schedule a recurring or one-time task. The prompt is executed by a fresh agent with no prior context — write it as a self-contained task. For one-time tasks (e.g. "remind me in 2 hours"), set once: true. Always call get_current_time first and convert user-local time to server time before computing the cron expression.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short identifier for this cron, e.g. "backup-nightly".' },
            schedule: { type: 'string', description: 'Cron expression, e.g. "0 3 * * *" for 3am daily. For a one-time task, compute the exact time from get_current_time and express it as a cron expression.' },
            prompt: { type: 'string', description: 'The task prompt the agent will receive when this cron fires. Must be self-contained. If notification is desired, include: "use send_telegram_message to notify the user with the result. Prefix the message with [Cron: \"<name>\" | <timestamp>] where <name> is the cron name and <timestamp> is the current date and time."' },
            once: { type: 'boolean', description: 'If true, the cron deletes itself after firing once. Use for one-time reminders or tasks.' },
          },
          required: ['name', 'schedule', 'prompt'],
        },
      },
    },
    code: `
      const { randomUUID } = require('crypto');
      const cronsFile = path.join(process.env.HOME, '.jarvis/data/crons.json');
      const crons = JSON.parse(await fs.promises.readFile(cronsFile, 'utf8').catch(() => '[]'));
      const entry = {
        id: randomUUID(),
        name: args.name,
        schedule: args.schedule,
        prompt: args.prompt,
        once: args.once || false,
        createdAt: new Date().toISOString(),
      };
      crons.push(entry);
      await fs.promises.mkdir(path.dirname(cronsFile), { recursive: true });
      await fs.promises.writeFile(cronsFile, JSON.stringify(crons, null, 2), 'utf8');
      return { status: 'ok', cron: entry };
    `,
  },
  list_crons: {
    definition: {
      type: 'function',
      function: {
        name: 'list_crons',
        description: 'List all scheduled cron jobs.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    code: `
      const cronsFile = path.join(process.env.HOME, '.jarvis/data/crons.json');
      const crons = JSON.parse(await fs.promises.readFile(cronsFile, 'utf8').catch(() => '[]'));
      return { status: 'ok', crons };
    `,
  },
  update_cron: {
    definition: {
      type: 'function',
      function: {
        name: 'update_cron',
        description: 'Update an existing cron job. Only the fields you provide will be changed. If updating the schedule, call get_current_time first and convert user-local time to server time before computing the cron expression.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The cron id to update.' },
            name: { type: 'string', description: 'New name.' },
            schedule: { type: 'string', description: 'New cron expression.' },
            prompt: { type: 'string', description: 'New prompt.' },
            once: { type: 'boolean', description: 'New once value.' },
          },
          required: ['id'],
        },
      },
    },
    code: `
      const cronsFile = path.join(process.env.HOME, '.jarvis/data/crons.json');
      const crons = JSON.parse(await fs.promises.readFile(cronsFile, 'utf8').catch(() => '[]'));
      const idx = crons.findIndex(c => c.id === args.id);
      if (idx === -1) return { status: 'not_found' };
      const updated = { ...crons[idx] };
      if (args.name !== undefined) updated.name = args.name;
      if (args.schedule !== undefined) updated.schedule = args.schedule;
      if (args.prompt !== undefined) updated.prompt = args.prompt;
      if (args.once !== undefined) updated.once = args.once;
      crons[idx] = updated;
      await fs.promises.writeFile(cronsFile, JSON.stringify(crons, null, 2), 'utf8');
      return { status: 'ok', cron: updated };
    `,
  },
  delete_cron: {
    definition: {
      type: 'function',
      function: {
        name: 'delete_cron',
        description: 'Delete a scheduled cron job by name or id.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The cron name to delete.' },
            id: { type: 'string', description: 'The cron id to delete.' },
          },
        },
      },
    },
    code: `
      const cronsFile = path.join(process.env.HOME, '.jarvis/data/crons.json');
      const crons = JSON.parse(await fs.promises.readFile(cronsFile, 'utf8').catch(() => '[]'));
      const idx = crons.findIndex(c => c.id === args.id || c.name === args.name);
      if (idx === -1) return { status: 'not_found' };
      const [removed] = crons.splice(idx, 1);
      await fs.promises.writeFile(cronsFile, JSON.stringify(crons, null, 2), 'utf8');
      return { status: 'ok', id: removed.id, name: removed.name };
    `,
  },
  send_telegram_message: {
    definition: {
      type: 'function',
      function: {
        name: 'send_telegram_message',
        description: 'Send a message to the Telegram user. Use this inside cron prompts to notify the user with the result of a task.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message text to send.' },
          },
          required: ['message'],
        },
      },
    },
    code: `
      const https = require('https');
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const settingsFile = path.join(process.env.HOME, '.jarvis/data/config/settings.json');
      const settings = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
      const chatId = settings.channels?.telegram?.allowedUserIds?.[0];
      if (!chatId) return { status: 'error', error: 'No Telegram chat_id configured.' };
      if (!token) return { status: 'error', error: 'No TELEGRAM_BOT_TOKEN configured.' };
      const sendRequest = (body) => new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: '/bot' + token + '/sendMessage',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const parsed = JSON.parse(data);
            if (!parsed.ok) reject(Object.assign(new Error(parsed.description), { description: parsed.description, error_code: parsed.error_code }));
            else resolve(parsed);
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      try {
        await sendRequest(JSON.stringify({ chat_id: chatId, text: args.message, parse_mode: 'HTML' }));
      } catch (e) {
        if (e.error_code === 400) {
          await sendRequest(JSON.stringify({ chat_id: chatId, text: args.message }));
        } else {
          throw e;
        }
      }
      try {
        const tgSessionsFile = path.join(process.env.HOME, '.jarvis/data/channels/telegram/sessions.json');
        const tgSessions = JSON.parse(await fs.promises.readFile(tgSessionsFile, 'utf8').catch(() => '{}'));
        const chatData = tgSessions[String(chatId)];
        const sessionId = typeof chatData === 'string'
          ? chatData
          : chatData?.slots?.[String(chatData?.active ?? 1)] ?? null;
        const prefix = sessionId ? String(sessionId).slice(0, 8) : 'unknown';
        const logDir = path.join(process.env.HOME, '.jarvis/telegram-chats');
        const logFile = path.join(logDir, String(chatId) + '-' + prefix + '.log');
        const ts = new Date().toISOString();
        await fs.promises.mkdir(logDir, { recursive: true });
        await fs.promises.appendFile(logFile, ts + ' [CRON] ' + String(args.message).replace(/\\n/g, ' ') + '\\n', 'utf8');
        if (sessionId) {
          const convFile = path.join(process.env.HOME, '.jarvis/data/conversations/' + sessionId + '.json');
          try {
            const conv = JSON.parse(await fs.promises.readFile(convFile, 'utf8'));
            conv.messages.push({ role: 'assistant', content: String(args.message) });
            conv.metadata.updatedAt = ts;
            await fs.promises.writeFile(convFile, JSON.stringify(conv, null, 2), 'utf8');
          } catch {}
        }
      } catch {}
      return { status: 'ok', chatId };
    `,
  },
  read_cron_log: {
    definition: {
      type: 'function',
      function: {
        name: 'read_cron_log',
        description: 'Read cron execution logs. Without id: returns recent runs across all crons (last 8 most recently active cron files, 5 entries each). With id: returns runs for that specific cron. Each cron execution logs one entry per handoff. Use verbose:true to include tool call details for debugging.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The cron id. Omit to get an overview across all crons.' },
            limit: { type: 'number', description: 'Max entries to return when reading a specific cron. Defaults to 20.' },
            verbose: { type: 'boolean', description: 'Include toolCalls array in each entry. Default false.' },
          },
          required: [],
        },
      },
    },
    code: `
      const logsDir = path.join(process.env.HOME, '.jarvis/logs');
      const verbose = !!args.verbose;
      function strip(entry) {
        if (verbose) return entry;
        const { toolCalls, ...rest } = entry;
        return rest;
      }
      if (!args.id) {
        const files = await fs.promises.readdir(logsDir).catch(() => []);
        const cronFiles = files.filter(f => f.startsWith('cron-') && f.endsWith('.jsonl'));
        const withMtime = await Promise.all(cronFiles.map(async f => {
          const stat = await fs.promises.stat(path.join(logsDir, f));
          return { file: f, mtime: stat.mtimeMs };
        }));
        withMtime.sort((a, b) => b.mtime - a.mtime);
        const allEntries = [];
        for (const { file } of withMtime.slice(0, 8)) {
          const content = await fs.promises.readFile(path.join(logsDir, file), 'utf8').catch(() => '');
          const lines = content.trim().split('\\n').filter(Boolean);
          allEntries.push(...lines.slice(-5).map(line => strip(JSON.parse(line))));
        }
        allEntries.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        return { status: 'ok', entries: allEntries };
      }
      const logFile = path.join(logsDir, 'cron-' + args.id + '.jsonl');
      const content = await fs.promises.readFile(logFile, 'utf8').catch(() => '');
      const lines = content.trim().split('\\n').filter(Boolean);
      const entries = lines.slice(-(args.limit || 20)).map(line => strip(JSON.parse(line)));
      return { status: 'ok', entries };
    `,
  },
  spawn_subagent: {
    definition: {
      type: 'function',
      function: {
        name: 'spawn_subagent',
        description: 'Spawn an independent subagent to handle a single subtask in its own isolated context and session. Use this when processing many similar items (e.g. emails, files, URLs) where doing them serially in the same context would overflow. Each subagent runs a full agent loop with access to all tools and returns its final response. Multiple spawn_subagent calls in a single response run in parallel. The subagent has no access to the current conversation — the prompt must be fully self-contained. Do not instruct subagents to use send_telegram_message; collect their results and notify the user yourself.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The self-contained task for the subagent. Must include all necessary context — the subagent has no access to the current conversation history.',
            },
            context: {
              type: 'string',
              description: 'Optional extra context to prepend to the prompt (e.g. the item to process, such as an email body or file path).',
            },
            label: {
              type: 'string',
              description: 'Optional short label for this subagent, used in logging (e.g. "email-42", "file-scan-/tmp/foo.txt").',
            },
            maxIterations: {
              type: 'number',
              description: 'Optional cap on the number of iterations the subagent may use. Defaults to the global maxIterations setting. Use a lower value (e.g. 5) for simple subtasks in bulk processing.',
            },
          },
          required: ['prompt'],
        },
      },
    },
    code: `return { status: 'error', error: 'spawn_subagent is a native tool handled by the agent runtime.' };`,
  },
  read_skill: {
    definition: {
      type: 'function',
      function: {
        name: 'read_skill',
        description: 'Read the full instructions of a skill by name. Call this before executing a skill so you have the complete workflow. The skill name must match one of the available skills listed in your system prompt.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The skill name, e.g. "add-two-integers".',
            },
          },
          required: ['name'],
        },
      },
    },
    code: `
      const skillDir = path.join(process.env.HOME, '.jarvis/data/skills', args.name);
      const dirFiles = await fs.promises.readdir(skillDir).catch(() => []);
      const skillFileName = dirFiles.find(f => f.toLowerCase() === 'skill.md') || 'skill.md';
      const skillFile = path.join(skillDir, skillFileName);
      const content = await fs.promises.readFile(skillFile, 'utf8').catch(() => null);
      if (!content) return { status: 'not_found', name: args.name };
      return { status: 'ok', name: args.name, content };
    `,
  },
  analyze_image: {
    definition: {
      type: 'function',
      function: {
        name: 'analyze_image',
        description: 'Fetch an image from a URL and analyze it using the configured vision model. Returns a detailed description of the image. Use this whenever a user shares an image URL and asks about its content.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the image to analyze (http or https).',
            },
            prompt: {
              type: 'string',
              description: 'Optional question or instruction for the vision model, e.g. "What text is visible?" or "Describe the chart". Defaults to a general description.',
            },
          },
          required: ['url'],
        },
      },
    },
    code: `
      const settingsPath = path.join(process.env.HOME, '.jarvis/data/config/settings.json');
      const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8').catch(() => '{}'));
      const visionModel = settings.visionModel;
      const visionProvider = settings.visionProvider;
      if (!visionModel || !visionProvider) {
        return { status: 'error', message: 'No vision model configured. Set visionModel and visionProvider in settings.' };
      }
      let apiKey, baseURL;
      if (visionProvider === 'z-ai') {
        apiKey = process.env.ZAI_API_KEY;
        baseURL = 'https://api.z.ai/api/coding/paas/v4/';
      } else {
        apiKey = process.env.OPENROUTER_API_KEY;
        baseURL = 'https://openrouter.ai/api/v1';
      }
      if (!apiKey) return { status: 'error', message: 'No API key found for vision provider: ' + visionProvider };
      const imgResponse = await fetch(args.url);
      if (!imgResponse.ok) return { status: 'error', message: 'Failed to fetch image: HTTP ' + imgResponse.status };
      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
      const dataUrl = 'data:' + contentType + ';base64,' + base64;
      const textPrompt = args.prompt?.trim()
        ? 'The user shared this image with the following question/context: "' + args.prompt.trim() + '"\\n\\nPlease describe what you see, paying special attention to anything relevant to their message.'
        : 'Please describe this image in detail. Include all visible text, objects, colors, layout, and any other relevant details.';
      const apiResponse = await fetch(baseURL + (baseURL.endsWith('/') ? '' : '/') + 'chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: visionModel,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: textPrompt },
          ]}],
        }),
      });
      const result = await apiResponse.json();
      if (!apiResponse.ok) return { status: 'error', message: result.error?.message || 'Vision API error' };
      const description = result.choices?.[0]?.message?.content?.trim() || '(no description returned)';
      return { status: 'ok', description };
    `,
  },
};

export function seedTools() {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(PATHS.toolsFile, 'utf8'));
  } catch {
    // File doesn't exist yet
  }

  let changed = false;
  for (const [name, tool] of Object.entries(SEED_TOOLS)) {
    // Always keep seed tools up to date — user-created tools have different names
    // and are never touched by this loop.
    if (JSON.stringify(existing[name]) !== JSON.stringify(tool)) {
      existing[name] = tool;
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(PATHS.toolsDir, { recursive: true });
    fs.writeFileSync(PATHS.toolsFile, JSON.stringify(existing, null, 2), 'utf8');
  }

  return existing;
}

export async function loadTools() {
  try {
    const raw = await fs.promises.readFile(PATHS.toolsFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function getToolDefinitions(tools) {
  const defs = [];
  for (const [name, t] of Object.entries(tools)) {
    if (t.requires && !process.env[t.requires]) {
      continue;
    }
    const params = t.definition?.function?.parameters;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      console.warn(`[tools] Skipping tool '${name}': parameters is not a valid object (got ${typeof params})`);
      continue;
    }
    defs.push(t.definition);
  }
  return defs;
}

export async function executeTool(tools, name, toolArgs) {
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const fn = new AsyncFunction('args', 'fs', 'path', 'process', 'require', '__jarvisDir', tool.code);

  // Tools can declare their own timeout (e.g. system_install needs 5 min).
  // Falls back to the global default of 60s.
  const timeoutMs = tool.timeout || TOOL_TIMEOUT_MS;

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Tool '${name}' timed out after ${timeoutMs / 1000}s`)),
      timeoutMs
    )
  );

  return await Promise.race([fn(toolArgs, fs, path, process, _require, __jarvisDir), timeout]);
}
