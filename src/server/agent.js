import crypto from 'crypto';
import { createClient } from './provider.js';
import { loadSystemPrompt, resolveSystemPrompt } from './config.js';
import { loadSession, saveSession, createSession } from './sessions.js';
import { loadTools, getToolDefinitions, executeTool } from './tools.js';
import { appendLog } from './logging.js';
import * as cronScheduler from './cron-scheduler.js';
import chalk from 'chalk';

const FORMAT_NUDGE = 'Your previous response was not valid JSON. Respond only with the required JSON object: {"response": "...", "logSummary": "..."}';
const LOOP_DETECTION_THRESHOLD = 3;

// Strip markdown code fences (```json...``` or ```...```) that models sometimes
// wrap around JSON responses, which would otherwise cause JSON.parse to throw.
function stripCodeFence(text) {
  return text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/, '$1').trim();
}

// Sanitize raw model output before JSON.parse:
// 1. Strip code fences
// 2. Escape literal control characters (e.g. real newlines in <pre> blocks) inside
//    JSON string values — models sometimes forget to escape \n as \\n
// 3. Remove trailing commas before } and ] (JS-valid but JSON-invalid)
function sanitizeJson(text) {
  let s = stripCodeFence(text);

  // State machine: walk the string and fix unescaped control chars inside strings
  let result = '';
  let inString = false;
  let escaped = false;
  const controlEscapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      result += ch;
      escaped = false;
    } else if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
    } else if (ch === '"') {
      result += ch;
      inString = !inString;
    } else if (inString && ch.charCodeAt(0) < 0x20) {
      result += controlEscapes[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else {
      result += ch;
    }
  }

  // Remove trailing commas before } and ]
  return result.replace(/,(\s*[}\]])/g, '$1');
}
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const MAX_TOOL_RESULT = 4000;

const ABORT_NOTE = `[System: The user has requested an immediate stop. This is your final response for this run.
Respond with your normal JSON, but add a checkpoint field:

{
  "response": "Brief message to the user acknowledging the stop and summarising what was completed.",
  "logSummary": "Human-readable summary of what happened before the stop.",
  "checkpoint": {
    "progress": "What has been fully completed — only include items confirmed by tool output.",
    "remaining": "What still needs to be done to finish the original task — as a plain text string, never an array or object.",
    "failedApproaches": ["Concise description of each approach that failed. Leave as empty array if nothing failed."],
    "state": {"factKey": "factValue — concrete facts confirmed by tool output: file paths, binary locations, config values. Use {} if nothing concrete was discovered."}
  }
}

The checkpoint will allow the task to be resumed later if needed.]`;

const WRAP_UP_NOTE = `[System: You have reached the iteration limit. This is your final response for this run.
Respond with your normal JSON, but add a checkpoint field:

{
  "response": "Brief message to the user that the task is still in progress.",
  "logSummary": "Human-readable summary of what happened in this run.",
  "checkpoint": {
    "progress": "What has been fully completed — only include items confirmed by tool output (e.g., successful exec with exit code 0, or verified by ls/cat). Do not report planned steps as completed.",
    "remaining": "What still needs to be done to finish the task — as a plain text string, never an array or object.",
    "failedApproaches": ["Concise description of each approach that was tried and failed, e.g. 'downloading subfinder via curl from GitHub releases — connection reset'. Omit array entries for things that succeeded. Leave as empty array if nothing failed."],
    "state": {"factKey": "factValue — concrete facts confirmed by tool output this run: file paths created, binary locations found, config values discovered. Use short stable keys, e.g. projectDir, zapBinary, scanScriptPath. Omit or use {} if nothing concrete was discovered."}
  }
}

The checkpoint field will be used to automatically resume the task in the next run. failedApproaches is injected into the next run so the agent does not waste iterations repeating strategies that already failed. state is injected verbatim so the next run does not need to rediscover file paths or binary locations. remaining must be a plain text string. failedApproaches must be a JSON array of strings. state must be a flat JSON object.]`;

// Serializes concurrent requests for the same session. Maps sessionId to the
// tail of the current request chain (a Promise that resolves when the last
// queued request finishes).
const sessionQueues = new Map();

// Abort flags: set by requestAbort(), checked at each iteration boundary in
// runAgentLoop. Always cleared in _runHandleChat's finally block to prevent
// stale flags from killing subsequent runs.
const sessionAborts = new Map();

export function requestAbort(sessionId) {
  sessionAborts.set(sessionId, true);
}

function accumulateUsage(accum, result) {
  const u = result?.usage;
  if (!u) return;
  accum.prompt += u.prompt_tokens || 0;
  accum.completion += u.completion_tokens || 0;
  accum.cacheRead += u.cache_read_input_tokens || 0;
  accum.cacheCreation += u.cache_creation_input_tokens || 0;
}

async function callModel(client, model, messages, tools) {
  const params = { model, messages };
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  return await client.chat.completions.create(params);
}

function isImageUnsupportedError(apiErrors) {
  if (!apiErrors) return false;
  return [apiErrors.primary?.message, apiErrors.fallback?.message]
    .some(m => m?.toLowerCase().includes('image input'));
}

function extractApiError(err, model) {
  return {
    model,
    httpStatus: err?.status ?? null,
    message: err?.message ?? String(err),
    body: err?.error ?? null,
  };
}

async function callModelWithFallback(client, config, messages, tools) {
  let primaryErr = null;
  try {
    return await callModel(client, config.selectedModel, messages, tools);
  } catch (err) {
    primaryErr = err;
  }
  try {
    return await callModel(client, config.fallbackModel, messages, tools);
  } catch (fallbackErr) {
    const combined = new Error(
      `Both primary (${config.selectedModel}) and fallback (${config.fallbackModel}) models failed. Last error: ${fallbackErr.message}`
    );
    combined.apiErrors = {
      primary: extractApiError(primaryErr, config.selectedModel),
      fallback: extractApiError(fallbackErr, config.fallbackModel),
    };
    throw combined;
  }
}

/**
 * Returns true if the last two assistant messages in the session are both
 * synthetic model_error notes, indicating a confirmed failure loop that cannot
 * self-resolve (e.g. persistent empty choices from context overflow).
 */
function hasConsecutiveModelErrors(messages) {
  const assistantTail = messages
    .filter(m => m.role === 'assistant')
    .slice(-2);
  return (
    assistantTail.length === 2 &&
    assistantTail.every(
      m =>
        typeof m.content === 'string' &&
        m.content.startsWith('[System: Previous run failed (model_error)')
    )
  );
}

/**
 * Runs a subagent in its own isolated session for a single self-contained task.
 * Called when the parent agent invokes the spawn_subagent tool.
 */
async function runSubagent(client, config, args, parentSessionId) {
  const subSessionId = `sub-${crypto.randomUUID()}`;
  const systemPromptTemplate = loadSystemPrompt();
  const subSession = createSession(systemPromptTemplate);

  let userContent = args.prompt;
  if (args.context) {
    userContent = `[Context: ${args.context}]\n\n${args.prompt}`;
  }
  subSession.messages.push({ role: 'user', content: userContent });

  const subConfig = {
    ...config,
    excludeTools: ['spawn_subagent'],
    maxIterations: args.maxIterations || config.maxIterations,
    _sessionId: subSessionId,
  };

  const usageAccum = { prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0 };

  function prepareMessages(messages) {
    const resolved = messages.map((msg, i) => {
      if (i === 0 && msg.role === 'system') {
        return { ...msg, content: resolveSystemPrompt(msg.content, subSessionId) };
      }
      return msg;
    });
    if (resolved.length <= subConfig.contextWindow + 1) return resolved;
    return [resolved[0], ...resolved.slice(-(subConfig.contextWindow))];
  }

  const run = await runAgentLoop(client, subConfig, subSession, prepareMessages, usageAccum);

  await appendLog(subSessionId, {
    iteration: run.iteration,
    model: config.selectedModel,
    userInput: args.prompt,
    toolCalls: run.runToolCalls,
    response: run.response,
    logSummary: run.logSummary,
    status: run.status,
    parentSessionId: parentSessionId || null,
    label: args.label || null,
    tokenUsage: { ...usageAccum },
  });

  subSession.metadata.tokenUsage = { ...usageAccum };

  try {
    await saveSession(subSessionId, subSession);
  } catch (e) {
    console.error(`Failed to save subagent session ${subSessionId}:`, e);
  }

  return {
    status: 'ok',
    response: run.response,
    runStatus: run.status,
    sessionId: subSessionId,
  };
}

/**
 * Runs a single agent loop up to maxIterations.
 * Returns { iteration, response, logSummary, status, runToolCalls, checkpoint }.
 */
export async function runAgentLoop(client, config, session, prepareMessages, usageAccum) {
  let tools = await loadTools();
  let toolDefs = getToolDefinitions(tools);
  if (config.excludeTools?.length) {
    toolDefs = toolDefs.filter(t => !config.excludeTools.includes(t.function?.name));
  }
  let iteration = 0;
  const runToolCalls = [];
  const loopTracker = new Map();
  let done = false;
  let response = '';
  let logSummary = '';
  let status = 'ok';
  let consecutiveFailures = 0;
  const stderrTracker = new Map();

  while (iteration < config.maxIterations) {
    iteration++;

    // Check for user-requested stop. Do a wrap-up call so the user gets a
    // meaningful summary and the session can be resumed later if needed.
    if (sessionAborts.get(config._sessionId)) {
      sessionAborts.delete(config._sessionId);
      const abortMessages = [
        ...prepareMessages(session.messages),
        { role: 'user', content: ABORT_NOTE },
      ];
      try {
        const abortResult = await callModelWithFallback(client, config, abortMessages, []);
        accumulateUsage(usageAccum, abortResult);
        const abortContent = abortResult.choices[0]?.message?.content || '';
        let parsedAbort = null;
        try { parsedAbort = JSON.parse(sanitizeJson(abortContent)); } catch { /* use raw */ }
        session.messages.push({ role: 'assistant', content: abortContent });
        if (parsedAbort?.checkpoint) {
          const cp = parsedAbort.checkpoint;
          if (typeof cp.remaining !== 'string') cp.remaining = Array.isArray(cp.remaining) ? cp.remaining.map(String).join('\n') : cp.remaining != null ? JSON.stringify(cp.remaining) : '';
          if (!Array.isArray(cp.failedApproaches)) cp.failedApproaches = [];
          else cp.failedApproaches = cp.failedApproaches.map(i => typeof i === 'string' ? i : JSON.stringify(i));
          if (typeof cp.state !== 'object' || cp.state === null || Array.isArray(cp.state)) cp.state = {};
        }
        return {
          iteration,
          response: parsedAbort?.response || abortContent || 'Run stopped.',
          logSummary: parsedAbort?.logSummary || 'Run stopped by user request.',
          status: 'aborted',
          runToolCalls,
          checkpoint: parsedAbort?.checkpoint || null,
        };
      } catch (e) {
        return {
          iteration,
          response: 'Run stopped.',
          logSummary: `Run stopped by user request. Wrap-up call failed: ${e.message}`,
          status: 'aborted',
          runToolCalls,
          checkpoint: null,
        };
      }
    }

    let modelResult;
    const iterationsLeft = config.maxIterations - iteration + 1;
    const base = prepareMessages(session.messages);
    const preparedMessages = iterationsLeft <= 5
      ? [...base, { role: 'user', content: `[System: ${iterationsLeft} iteration${iterationsLeft === 1 ? '' : 's'} remaining in this run. Budget your remaining steps accordingly — if you cannot finish in time, consolidate progress and provide a checkpoint.]` }]
      : base;
    try {
      modelResult = await callModelWithFallback(client, config, preparedMessages, toolDefs);
      accumulateUsage(usageAccum, modelResult);
    } catch (e) {
      return {
        iteration,
        response: e.message,
        logSummary: `Model error on iteration ${iteration}: ${e.message}`,
        status: 'model_error',
        runToolCalls,
        checkpoint: null,
        errorDetail: e.apiErrors ?? { message: e.message, stack: e.stack },
        contextInfo: { messageCount: preparedMessages.length },
      };
    }

    if (!modelResult.choices || modelResult.choices.length === 0) {
      return {
        iteration,
        response: `Model returned an empty response (${preparedMessages.length} messages in context). This typically happens when the conversation is too long for the model. Try starting a new session or switching to a model with a larger context window.`,
        logSummary: `Model error on iteration ${iteration}: Empty choices array.`,
        status: 'model_error',
        runToolCalls,
        checkpoint: null,
        errorDetail: { message: 'Empty choices array from LLM' },
        contextInfo: { messageCount: preparedMessages.length },
      };
    }

    const assistantMessage = modelResult.choices[0].message;

    // Tool calls present — execute in parallel, then process results in order
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      session.messages.push({
        role: 'assistant',
        content: assistantMessage.content || null,
        tool_calls: assistantMessage.tool_calls.map(tc => ({
          ...tc,
          function: {
            ...tc.function,
            arguments: tc.function.arguments || '{}',
          },
        })),
      });

      // Execute all tool calls concurrently; session mutations happen serially below.
      const toolResults = await Promise.all(
        assistantMessage.tool_calls.map(async (toolCall) => {
          const toolName = toolCall.function.name;
          let toolArgs;
          let argParseError = null;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            argParseError = e;
          }

          if (argParseError) {
            return { toolCall, toolName, toolArgs: {}, argParseError, result: null, toolStatus: 'error' };
          }

          let result;
          let toolStatus = 'ok';
          try {
            if (toolName === 'spawn_subagent') {
              result = await runSubagent(client, config, toolArgs, config._sessionId);
            } else {
              result = await executeTool(tools, toolName, toolArgs);
            }
          } catch (e) {
            result = { status: 'error', error: e.message };
            toolStatus = 'error';
          }

          return { toolCall, toolName, toolArgs, argParseError: null, result, toolStatus };
        })
      );

      // Process results serially to preserve message order and update trackers.
      let stderrErrorInIteration = false;
      for (const { toolCall, toolName, toolArgs, argParseError, result, toolStatus } of toolResults) {
        if (argParseError) {
          const errorContent = JSON.stringify({
            status: 'error',
            error: `Tool arguments could not be parsed as JSON: ${argParseError.message}. Ensure arguments are a valid JSON object, e.g. {"key": "value"}.`,
          });
          session.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: errorContent });
          runToolCalls.push({ name: toolName, args: {}, status: 'error', result: errorContent });
          consecutiveFailures++;
          continue;
        }

        const resultObj = typeof result === 'object' && result !== null ? result : null;
        const toolFailed = toolStatus === 'error' || (resultObj && resultObj.status === 'error');
        if (toolFailed) {
          consecutiveFailures++;
          if (resultObj && resultObj.stderr) {
            stderrErrorInIteration = true;
            const firstStderrLine = resultObj.stderr.split('\n')[0].trim();
            if (firstStderrLine) {
              stderrTracker.set(firstStderrLine, (stderrTracker.get(firstStderrLine) || 0) + 1);
            }
          }
        } else {
          consecutiveFailures = 0;
        }

        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        runToolCalls.push({ name: toolName, args: toolArgs, status: toolStatus, result: resultStr });

        const sessionContent = resultStr.length > MAX_TOOL_RESULT
          ? resultStr.slice(0, 2000) + `\n[...${resultStr.length - 4000} chars truncated...]\n` + resultStr.slice(-2000)
          : resultStr;
        session.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: sessionContent,
        });

        // Dynamic cron scheduling — update the in-memory scheduler immediately
        // so the cron is active without requiring a server restart.
        if (toolStatus === 'ok') {
          try {
            if (toolName === 'create_cron') {
              const cronEntry = JSON.parse(resultStr)?.cron;
              if (cronEntry) cronScheduler.schedule(cronEntry);
            } else if (toolName === 'update_cron') {
              const cronEntry = JSON.parse(resultStr)?.cron;
              if (cronEntry) { cronScheduler.unschedule(cronEntry.id); cronScheduler.schedule(cronEntry); }
            } else if (toolName === 'delete_cron') {
              const id = JSON.parse(resultStr)?.id;
              if (id) cronScheduler.unschedule(id);
            }
          } catch { /* ignore parse errors */ }
        }

        const callKey = `${toolName}|${JSON.stringify(toolArgs)}|${resultStr}`;
        loopTracker.set(callKey, (loopTracker.get(callKey) || 0) + 1);
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        session.messages.push({
          role: 'user',
          content: '[System: You have had 3 or more consecutive tool failures. Stop retrying the same approach. Either pivot to a fundamentally different strategy or provide your final response explaining what failed and why.]',
        });
        consecutiveFailures = 0;
      }

      const loopDetected = [...loopTracker.values()].some(count => count >= LOOP_DETECTION_THRESHOLD);
      if (loopDetected) {
        session.messages.push({
          role: 'user',
          content: '[System: Loop detected. You are repeatedly calling the same tools with identical arguments and getting identical results. Stop calling tools and provide your final answer now based on what you already know.]',
        });
      }

      const repeatedStderr = [...stderrTracker.entries()].find(([, count]) => count >= CONSECUTIVE_FAILURE_THRESHOLD);
      if (repeatedStderr && !loopDetected) {
        session.messages.push({
          role: 'user',
          content: `[System: The error "${repeatedStderr[0].slice(0, 200)}" has now appeared ${repeatedStderr[1]} times across different commands. You are repeatedly diagnosing the wrong thing. Stop, step back, and reconsider from scratch — what is this error fundamentally telling you about the state of the system?]`,
        });
      } else if (stderrErrorInIteration && !loopDetected) {
        session.messages.push({
          role: 'user',
          content: '[System: A command failed. Examine both the stdout AND stderr fields in the tool result — stderr names the error, but stdout (especially from debug commands like bash -x) often shows the root cause. Do not retry without first understanding what the full output is telling you.]',
        });
      }

      continue;
    }

    // No tool calls — final response
    // Delay pushing to session until we have a valid response (recovery may replace it)
    let content = assistantMessage.content || '';
    let parsed = null;

    if (!content.trim()) {
      // Model returned no content at all — use a targeted nudge instead of the
      // standard JSON recovery chain (designed for non-empty non-JSON responses).
      // Send with no tools so the model cannot respond with another tool call,
      // which would leave content empty and discard any recovery text.
      try {
        const emptyNudge = [
          ...preparedMessages,
          { role: 'user', content: 'You returned an empty response. ' + FORMAT_NUDGE },
        ];
        const nudgeResult = await callModelWithFallback(client, config, emptyNudge, []);
        accumulateUsage(usageAccum, nudgeResult);
        const nudgeContent = nudgeResult.choices[0]?.message?.content || '';
        // Persist nudge text before parsing — if JSON parse throws, content still
        // carries the model's best-effort text so the !parsed handler can show it
        // rather than falling back to "The model did not produce a response."
        if (nudgeContent.trim()) {
          content = nudgeContent;
        }
        parsed = JSON.parse(sanitizeJson(nudgeContent));
      } catch {
        // Fall through to !parsed handler; content may now carry the nudge text
      }
    } else {
      try {
        parsed = JSON.parse(sanitizeJson(content));
      } catch {
        // Step 1: retry with fallback model
        try {
          const fallbackResult = await callModel(client, config.fallbackModel, preparedMessages, toolDefs);
          accumulateUsage(usageAccum, fallbackResult);
          const fallbackContent = fallbackResult.choices[0]?.message?.content || '';
          parsed = JSON.parse(sanitizeJson(fallbackContent));
          content = fallbackContent;
        } catch {
          // Step 2: nudge retry via both models
          try {
            const nudgeMessages = [...preparedMessages, { role: 'user', content: FORMAT_NUDGE }];
            const nudgeResult = await callModelWithFallback(client, config, nudgeMessages, toolDefs);
            accumulateUsage(usageAccum, nudgeResult);
            const nudgeContent = nudgeResult.choices[0]?.message?.content || '';
            parsed = JSON.parse(sanitizeJson(nudgeContent));
            content = nudgeContent;
          } catch {
            // Give up
          }
        }
      }
    }

    if (!parsed) {
      // Don't push bad content — handleChat will inject a synthetic error note.
      // Ensure response is never empty so the delivery layer (e.g. Telegram) can
      // show the user something meaningful rather than its generic fallback message.
      response = content.trim() || 'The model did not produce a response. Please try again.';
      logSummary = 'Model returned non-JSON final response after recovery attempts.';
      status = 'format_error';
      return { iteration, response, logSummary, status, runToolCalls, checkpoint: null, rawResponse: content };
    }

    session.messages.push({ role: 'assistant', content });
    response = typeof parsed.response === 'string'
      ? parsed.response
      : JSON.stringify(parsed.response, null, 2);
    logSummary = parsed.logSummary || '';

    done = true;
    break;
  }

  // Hit iteration limit without completing — wrap-up call
  if (!done) {
    const wrapUpMessages = [
      ...prepareMessages(session.messages),
      { role: 'user', content: WRAP_UP_NOTE },
    ];

    let wrapUpResult;
    try {
      wrapUpResult = await callModelWithFallback(client, config, wrapUpMessages, []);
      accumulateUsage(usageAccum, wrapUpResult);
    } catch (e) {
      return {
        iteration,
        response: 'Agent reached iteration limit and wrap-up call also failed.',
        logSummary: `Iteration limit reached. Wrap-up failed: ${e.message}`,
        status: 'model_error',
        runToolCalls,
        checkpoint: null,
        errorDetail: e.apiErrors ?? { message: e.message, stack: e.stack },
        contextInfo: { messageCount: wrapUpMessages.length },
      };
    }

    if (!wrapUpResult.choices || wrapUpResult.choices.length === 0) {
      return {
        iteration,
        response: 'Wrap-up call returned an empty response.',
        logSummary: 'Iteration limit reached. Wrap-up returned empty choices.',
        status: 'model_error',
        runToolCalls,
        checkpoint: null,
        errorDetail: { message: 'Empty choices array in wrap-up' },
        contextInfo: { messageCount: wrapUpMessages.length },
      };
    }

    let wrapUpContent = wrapUpResult.choices[0].message.content || '';
    let parsedWrapUp = null;

    // Try JSON parse; if it fails, nudge retry (Layer 2)
    try {
      parsedWrapUp = JSON.parse(sanitizeJson(wrapUpContent));
    } catch {
      try {
        const nudgeMessages = [...wrapUpMessages, { role: 'user', content: FORMAT_NUDGE }];
        const nudgeResult = await callModelWithFallback(client, config, nudgeMessages, []);
        accumulateUsage(usageAccum, nudgeResult);
        const nudgeContent = nudgeResult.choices[0]?.message?.content || '';
        parsedWrapUp = JSON.parse(sanitizeJson(nudgeContent));
        wrapUpContent = nudgeContent;
      } catch {
        // Layer 3: use raw text as best-effort response below
      }
    }

    // Store the wrap-up response (but NOT the temporary system note)
    session.messages.push({ role: 'assistant', content: wrapUpContent });

    if (parsedWrapUp) {
      response = typeof parsedWrapUp.response === 'string'
        ? parsedWrapUp.response
        : parsedWrapUp.response != null ? JSON.stringify(parsedWrapUp.response, null, 2) : '';
      logSummary = parsedWrapUp.logSummary || '';
      if (parsedWrapUp.checkpoint) {
        // Normalize checkpoint fields to their expected types. Models sometimes
        // return arrays or objects in fields that must be strings — the same class
        // of bug fixed for `response` in finding 009.
        const cp = parsedWrapUp.checkpoint;
        if (typeof cp.remaining !== 'string') {
          cp.remaining = Array.isArray(cp.remaining)
            ? cp.remaining.map(String).join('\n')
            : cp.remaining != null ? JSON.stringify(cp.remaining) : '';
        }
        if (!Array.isArray(cp.failedApproaches)) {
          cp.failedApproaches = [];
        } else {
          cp.failedApproaches = cp.failedApproaches.map(item =>
            typeof item === 'string' ? item : JSON.stringify(item)
          );
        }
        if (typeof cp.state !== 'object' || cp.state === null || Array.isArray(cp.state)) {
          cp.state = {};
        }
        return {
          iteration,
          response,
          logSummary,
          status: 'checkpoint_reached',
          runToolCalls,
          checkpoint: parsedWrapUp.checkpoint,
        };
      }
      status = 'ok';
    } else {
      // Layer 3: use raw text — user gets a real response instead of an error
      response = wrapUpContent;
      logSummary = 'Wrap-up response was not valid JSON after retry.';
      status = 'ok';
    }
  }

  return { iteration, response, logSummary, status, runToolCalls, checkpoint: null };
}

/**
 * Acquires the session lock and runs fn() inside it.
 * Used by the cron runner to safely write to a session that may also
 * receive concurrent user messages.
 */
export async function withSessionLock(sessionId, fn) {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let releaseLock;
  const current = new Promise(resolve => { releaseLock = resolve; });
  sessionQueues.set(sessionId, current);
  await previous;
  try {
    return await fn();
  } finally {
    releaseLock();
    if (sessionQueues.get(sessionId) === current) {
      sessionQueues.delete(sessionId);
    }
  }
}

/**
 * Main entry point: handles a single POST /api/chat request.
 * Manages the handoff loop across multiple agent runs.
 */
export async function handleChat(config, requestSessionId, userMessage, attachments = [], onCheckpoint = null) {
  const sessionId = requestSessionId || crypto.randomUUID();

  // Serialize concurrent requests for the same session. Each request registers
  // itself at the tail of the queue and waits for the previous request to finish
  // before starting. New sessions (no requestSessionId) each get a unique ID,
  // so they never contend with each other.
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let releaseLock;
  const current = new Promise(resolve => { releaseLock = resolve; });
  sessionQueues.set(sessionId, current);
  await previous;

  try {
    return await _runHandleChat(config, sessionId, userMessage, attachments, onCheckpoint);
  } finally {
    releaseLock();
    // Clean up only if no one else has queued behind us
    if (sessionQueues.get(sessionId) === current) {
      sessionQueues.delete(sessionId);
    }
  }
}

/**
 * The actual chat logic, extracted so handleChat can wrap it cleanly with the
 * session lock.
 */
async function _runHandleChat(config, sessionId, userMessage, attachments = [], onCheckpoint = null) {
  const client = createClient(config);

  const systemPromptTemplate = loadSystemPrompt();
  let session = await loadSession(sessionId);

  if (!session) {
    session = createSession(systemPromptTemplate);
  }

  // Capture persisted state BEFORE resetting metadata so we can inject it below.
  const wasZeroProgress = !!session.metadata.lastCheckpointRemaining;
  const priorCheckpointRemaining = session.metadata.lastCheckpointRemaining || null;
  const priorCheckpointState = session.metadata.checkpointState || {};

  // Preserve accumulated failedApproaches in conversation history before resetting
  // so the model retains knowledge of what failed in the previous batch of handoff runs.
  let userMessageWithContext = userMessage;
  if (session.metadata.failedApproaches && session.metadata.failedApproaches.length > 0) {
    userMessageWithContext += `\n\n[System: The following approaches were tried and failed in previous runs — consider them exhausted:\n${session.metadata.failedApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}]`;
  }

  // If this message follows a zero-progress intervention, tell the agent explicitly so
  // it responds to the user's input instead of blindly resuming the same failing approach.
  if (wasZeroProgress) {
    const stateLines = Object.entries(priorCheckpointState).map(([k, v]) => `- ${k}: ${v}`);
    let note = `\n\n[System: This task previously hit zero-progress and required intervention. If the user has given new direction or clarification, follow it. Otherwise, immediately explain what specific obstacle is blocking progress — do not resume the same failing approach.`;
    if (stateLines.length > 0) {
      note += `\n\nKnown facts from previous run:\n${stateLines.join('\n')}`;
    }
    note += `]`;
    userMessageWithContext += note;
  }

  // Append user message and reset handoff state.
  // If attachments (e.g. images) are present, build a multimodal content array.
  let userContent;
  if (attachments && attachments.length > 0) {
    userContent = [
      ...attachments.map(a => ({ type: 'image_url', image_url: { url: a.url } })),
      { type: 'text', text: userMessageWithContext },
    ];
  } else {
    userContent = userMessageWithContext;
  }
  session.messages.push({ role: 'user', content: userContent });
  session.metadata.handoffCount = 0;
  session.metadata.failedApproaches = [];
  session.metadata.lastCheckpointRemaining = null;
  session.metadata.checkpointState = {};

  // Resolves {{user_info}} in system prompt at runtime (never persisted).
  // Applies a sliding window: always includes the system prompt (messages[0])
  // plus the most recent contextWindow messages, so long sessions don't overflow
  // the model's context. Full history is always preserved on disk.
  function prepareMessages(messages) {
    const resolved = messages.map((msg, i) => {
      if (i === 0 && msg.role === 'system') {
        return { ...msg, content: resolveSystemPrompt(msg.content, sessionId) };
      }
      return msg;
    });
    if (resolved.length <= config.contextWindow + 1) return resolved;
    return [resolved[0], ...resolved.slice(-(config.contextWindow))];
  }

  const allToolCalls = [];
  const usageAccum = { prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0 };
  let finalResponse = '';
  let finalLogSummary = '';
  let finalStatus = 'ok';
  // Tracks checkpoint.remaining from the previous handoff run to detect zero progress.
  // Initialized from persisted metadata so detection works across user messages too —
  // if the agent was stuck before and produces the same remaining again on the next
  // user turn, zero-progress fires after just one run instead of two.
  let previousRemaining = priorCheckpointRemaining;

  try {
    // Handoff loop
    while (true) {
      // Safety check: if the last two assistant messages are both model_error
      // synthetic notes, we are in a confirmed failure loop. Escalate immediately
      // rather than burning more iterations on a stuck session.
      if (hasConsecutiveModelErrors(session.messages)) {
        finalResponse = 'The model has failed twice in a row. This is likely due to the conversation being too long for the model to process. Please start a new session or switch to a model with a larger context window.';
        finalLogSummary = 'Consecutive model_error detected: session escalated to intervention_required without running another agent loop.';
        finalStatus = 'intervention_required';
        await appendLog(sessionId, {
          iteration: 0,
          model: config.selectedModel,
          userInput: userMessage,
          toolCalls: [],
          response: finalResponse,
          logSummary: finalLogSummary,
          status: 'intervention_required',
        });
        break;
      }

      const runStartIndex = session.messages.length;
      const run = await runAgentLoop(client, { ...config, _sessionId: sessionId }, session, prepareMessages, usageAccum);
      allToolCalls.push(...run.runToolCalls);

      if (run.status !== 'checkpoint_reached') {
        finalResponse = run.response;
        finalLogSummary = run.logSummary;
        finalStatus = run.status;

        const logEntry = {
          iteration: run.iteration,
          model: config.selectedModel,
          userInput: userMessage,
          toolCalls: allToolCalls,
          response: finalResponse,
          logSummary: finalLogSummary,
          status: finalStatus,
        };
        if (run.errorDetail) logEntry.errorDetail = run.errorDetail;
        if (run.contextInfo) logEntry.contextInfo = run.contextInfo;
        if (run.rawResponse) logEntry.rawResponse = run.rawResponse;
        await appendLog(sessionId, logEntry);

        // Inject synthetic error note so the model has context on the next user turn.
        // For failed runs, also strip the tool call history — keeping it would bloat
        // the context and create a positive-feedback death spiral where each failure
        // makes the next one more likely (especially on free models with small context
        // windows). The synthetic note is sufficient context; tool results are preserved
        // in the JSONL log and accessible via read_session_log.
        // On abort: save checkpoint data so the task can be resumed later,
        // same as the checkpoint_reached path does for handoff runs.
        if (finalStatus === 'aborted' && run.checkpoint) {
          if (run.checkpoint.failedApproaches?.length > 0) {
            if (!session.metadata.failedApproaches) session.metadata.failedApproaches = [];
            session.metadata.failedApproaches.push(...run.checkpoint.failedApproaches);
          }
          if (run.checkpoint.state && Object.keys(run.checkpoint.state).length > 0) {
            session.metadata.checkpointState = { ...(session.metadata.checkpointState || {}), ...run.checkpoint.state };
          }
          if (run.checkpoint.remaining) {
            session.metadata.lastCheckpointRemaining = run.checkpoint.remaining.trim();
          }
        }

        if (finalStatus === 'model_error' || finalStatus === 'format_error') {
          if (finalStatus === 'model_error' && isImageUnsupportedError(run.errorDetail)) {
            finalResponse = 'This model does not support image input. Please switch to a multimodal model (e.g. claude-3.5-sonnet, gpt-4o) in settings.';
            // Strip the image from the user message that caused the failure so it
            // does not permanently break the session on every subsequent call.
            // Replace with a text placeholder so the model knows a image was present.
            for (let i = session.messages.length - 1; i >= 0; i--) {
              const msg = session.messages[i];
              if (msg.role === 'user' && Array.isArray(msg.content)) {
                const textPart = msg.content.find(c => c.type === 'text')?.text || '';
                msg.content = textPart
                  ? `${textPart}\n[image removed — model does not support image input]`
                  : '[image removed — model does not support image input]';
                break;
              }
            }
          }
          session.messages.splice(runStartIndex, session.messages.length - runStartIndex);
          const errorDetail = run.errorDetail ? ` Error detail: ${JSON.stringify(run.errorDetail)}` : '';
          session.messages.push({
            role: 'assistant',
            content: `[System: Previous run failed (${finalStatus}): ${finalLogSummary}.${errorDetail}]`,
          });
        }

        break;
      }

      // Checkpoint reached — log this run and notify the caller (e.g. Telegram adapter)
      // so intermediate progress is visible to the user instead of being swallowed
      // by the handoff loop until the final response.
      await appendLog(sessionId, {
        iteration: run.iteration,
        model: config.selectedModel,
        userInput: userMessage,
        toolCalls: run.runToolCalls,
        response: run.response,
        logSummary: run.logSummary,
        status: 'checkpoint_reached',
      });
      if (onCheckpoint) await onCheckpoint(run.response);

      // Accumulate failedApproaches from this run into session metadata so the
      // full history of failed strategies is available across all handoff runs.
      if (run.checkpoint.failedApproaches && run.checkpoint.failedApproaches.length > 0) {
        if (!session.metadata.failedApproaches) session.metadata.failedApproaches = [];
        session.metadata.failedApproaches.push(...run.checkpoint.failedApproaches);
      }

      // Merge concrete facts from this run's checkpoint.state into session metadata.
      // Later runs overwrite earlier values for the same key (newer discoveries win).
      if (run.checkpoint.state && Object.keys(run.checkpoint.state).length > 0) {
        session.metadata.checkpointState = {
          ...(session.metadata.checkpointState || {}),
          ...run.checkpoint.state,
        };
      }

      // Zero-progress detection: if checkpoint.remaining is identical to the previous
      // handoff's remaining, the agent completed a full run without making any progress.
      // Stop immediately rather than burning more iterations on a stuck task.
      const currentRemaining = (run.checkpoint.remaining || '').trim();
      if (previousRemaining !== null && currentRemaining === previousRemaining) {
        finalResponse = run.response;
        finalLogSummary = 'Zero progress detected: task state unchanged after a full run. Human intervention required.';
        finalStatus = 'intervention_required';

        // Persist so that the next user message initializes previousRemaining from this
        // value — zero-progress will then fire after just one run instead of two.
        session.metadata.lastCheckpointRemaining = currentRemaining;

        await appendLog(sessionId, {
          iteration: 0,
          model: config.selectedModel,
          userInput: userMessage,
          toolCalls: [],
          response: finalResponse,
          logSummary: finalLogSummary,
          status: 'intervention_required',
        });
        session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);
        break;
      }
      previousRemaining = currentRemaining;

      // Check handoff limit
      session.metadata.handoffCount++;
      if (session.metadata.handoffCount > config.maxHandoffs) {
        finalResponse = run.response;
        finalLogSummary = run.logSummary;
        finalStatus = 'intervention_required';

        await appendLog(sessionId, {
          iteration: 0,
          model: config.selectedModel,
          userInput: userMessage,
          toolCalls: [],
          response: finalResponse,
          logSummary: 'Max handoffs exceeded. Human intervention required.',
          status: 'intervention_required',
        });
        // Strip tool history even when stopping — prevents context bloat on the
        // next user message when human intervention resumes the session.
        session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);
        break;
      }

      // Strip intermediate tool messages from this run before resuming.
      // Keep only the wrap-up assistant response (last message added by runAgentLoop) —
      // it summarises what was done and is far cheaper context than the raw tool history.
      session.messages.splice(runStartIndex, session.messages.length - runStartIndex - 1);

      // Resume with checkpoint.remaining as new prompt.
      // Guard against null/undefined in case the model omitted the field.
      // Inject the full accumulated failedApproaches and concrete state so the agent
      // has complete memory of what failed and what was already discovered.
      let resumeContent = run.checkpoint.remaining || 'Continue with the task.';
      const allFailedApproaches = session.metadata.failedApproaches || [];
      if (allFailedApproaches.length > 0) {
        resumeContent += `\n\n[System: The following approaches were tried and failed in previous runs — do not repeat them:\n${allFailedApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}]`;
      }
      const stateToInject = session.metadata.checkpointState || {};
      if (Object.keys(stateToInject).length > 0) {
        resumeContent += `\n\n[System: Known facts from previous runs:\n${Object.entries(stateToInject).map(([k, v]) => `- ${k}: ${v}`).join('\n')}]`;
      }
      session.messages.push({ role: 'user', content: resumeContent });
    }
  } catch (e) {
    await appendLog(sessionId, {
      iteration: 0,
      model: config.selectedModel,
      userInput: userMessage,
      toolCalls: allToolCalls,
      response: `An unexpected server error occurred: ${e.message}`,
      logSummary: `Critical error: ${e.message}`,
      status: 'error',
      errorDetail: { message: e.message, stack: e.stack },
    });
    throw e;
  } finally {
    // Clear any stale abort flag — prevents a flag set just as a run finished
    // from killing the next run.
    sessionAborts.delete(sessionId);

    // Accumulate token usage into session metadata so /usage can read it
    if (!session.metadata.tokenUsage) session.metadata.tokenUsage = { prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0 };
    session.metadata.tokenUsage.prompt += usageAccum.prompt;
    session.metadata.tokenUsage.completion += usageAccum.completion;
    session.metadata.tokenUsage.cacheRead = (session.metadata.tokenUsage.cacheRead || 0) + usageAccum.cacheRead;
    session.metadata.tokenUsage.cacheCreation = (session.metadata.tokenUsage.cacheCreation || 0) + usageAccum.cacheCreation;

    // Always persist the session — even if an unexpected error occurred.
    // A failed save must not mask the original error.
    try {
      await saveSession(sessionId, session);
    } catch (saveErr) {
      console.error(`Failed to save session ${sessionId}:`, saveErr);
    }
  }

  console.log(`${chalk.magenta('<<<')} ${chalk.bold('Final Response')} [SID: ${chalk.dim(sessionId.slice(0, 8))}] ${chalk.italic(finalLogSummary)}`);

  return {
    sessionId,
    response: finalResponse,
    logSummary: finalLogSummary,
    toolCalls: allToolCalls,
  };
}
