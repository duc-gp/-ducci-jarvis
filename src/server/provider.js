import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Convert OpenAI tool definitions to Anthropic format.
// Cache_control on the last tool caches everything up to and including the full tools array.
function openAIToolsToAnthropic(tools) {
  if (!tools || tools.length === 0) return [];
  return tools.map((t, i) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {}, required: [] },
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

// Convert OpenAI message history to Anthropic format.
// Key differences:
//   - system message becomes a separate `system` param, not part of messages
//   - assistant tool_calls → content array with tool_use blocks
//   - role:'tool' messages → content array with tool_result blocks inside a user message
//   - Anthropic requires strict user/assistant alternation; consecutive user messages
//     (e.g. tool results followed by a system note) are merged
function openAIMessagesToAnthropic(messages) {
  let system;
  let rest = messages;

  if (messages[0]?.role === 'system') {
    // Array form allows cache_control; Anthropic accepts string or array for system
    system = [{ type: 'text', text: messages[0].content, cache_control: { type: 'ephemeral' } }];
    rest = messages.slice(1);
  }

  const result = [];

  for (let i = 0; i < rest.length; i++) {
    const msg = rest[i];

    if (msg.role === 'user') {
      const last = result[result.length - 1];
      if (last && last.role === 'user') {
        // Merge into previous user message to maintain strict alternation
        const newPart = { type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
        if (typeof last.content === 'string') {
          last.content = [{ type: 'text', text: last.content }, newPart];
        } else {
          last.content.push(newPart);
        }
      } else {
        result.push({ role: 'user', content: msg.content });
      }

    } else if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      result.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });

      // Collect following tool-result messages into a single user message
      const toolResults = [];
      while (i + 1 < rest.length && rest[i + 1].role === 'tool') {
        i++;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rest[i].tool_call_id,
          content: rest[i].content,
        });
      }
      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults });
      }

    }
    // role:'tool' messages that were not consumed above are skipped (shouldn't happen)
  }

  return { system, messages: result };
}

// Normalize an Anthropic response to the shape agent.js expects from the OpenAI SDK
function anthropicResponseToOpenAI(response) {
  const textParts = response.content.filter(c => c.type === 'text');
  const toolParts = response.content.filter(c => c.type === 'tool_use');

  const text = textParts.map(t => t.text).join('') || null;
  const toolCalls = toolParts.length > 0
    ? toolParts.map(t => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input) },
    }))
    : undefined;

  return {
    choices: [{
      message: {
        role: 'assistant',
        content: toolCalls ? null : text,
        ...(toolCalls && { tool_calls: toolCalls }),
      },
      finish_reason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

// Build an Anthropic adapter that exposes the same interface as the OpenAI SDK client
function createAnthropicClient(apiKey) {
  const isOAuthToken = apiKey.startsWith('sk-ant-oat');
  const anthropic = isOAuthToken
    ? new Anthropic({ authToken: apiKey, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } })
    : new Anthropic({ apiKey });

  return {
    chat: {
      completions: {
        create: async ({ model, messages, tools }) => {
          const { system, messages: anthropicMessages } = openAIMessagesToAnthropic(messages);
          const anthropicTools = openAIToolsToAnthropic(tools);

          const params = {
            model,
            max_tokens: 8096,
            messages: anthropicMessages,
          };
          if (system) params.system = system;
          if (anthropicTools.length > 0) params.tools = anthropicTools;

          const response = await anthropic.messages.create(params);
          return anthropicResponseToOpenAI(response);
        },
      },
    },
  };
}

export function createClient(config) {
  if (config.provider === 'anthropic') {
    return createAnthropicClient(config.apiKey);
  }
  if (config.provider === 'z-ai') {
    return new OpenAI({
      baseURL: 'https://api.z.ai/api/coding/paas/v4/',
      apiKey: config.apiKey,
    });
  }
  if (config.provider === 'openai-compatible') {
    return new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  }
  // Default: OpenRouter (OpenAI-compatible)
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.apiKey,
  });
}
