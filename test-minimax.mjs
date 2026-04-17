/**
 * MiniMax OpenAI-compatible API test script.
 * Usage: MINIMAX_API_KEY=xxx MINIMAX_BASE_URL=https://api.minimaxi.chat/v1 node test-minimax.mjs
 *
 * Tests:
 *   1. Simple chat completion (no tools)
 *   2. Single tool call (model requests a tool)
 *   3. Multi-turn: tool call → tool result → final answer  ← this is where Jarvis breaks
 */

import OpenAI from 'openai';

const API_KEY  = process.env.MINIMAX_API_KEY;
const BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.chat/v1';
const MODEL    = process.env.MINIMAX_MODEL    || 'MiniMax-Text-01';

if (!API_KEY) {
  console.error('ERROR: set MINIMAX_API_KEY env var');
  process.exit(1);
}

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    },
  },
];

function sep(label) {
  console.log('\n' + '─'.repeat(60));
  console.log(`TEST: ${label}`);
  console.log('─'.repeat(60));
}

function dump(label, obj) {
  console.log(`\n[${label}]`);
  console.log(JSON.stringify(obj, null, 2));
}

// ── Test 1: Simple chat ────────────────────────────────────────
sep('1 · Simple chat (no tools)');
try {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
  });
  dump('response', res.choices[0].message);
  console.log('✅ PASS');
} catch (e) {
  console.error('❌ FAIL', e.message);
  dump('error', e);
}

// ── Test 2: Single tool call ───────────────────────────────────
sep('2 · Single tool call (model should call get_weather)');
let toolCallId, toolCallName, toolCallArgs;
try {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'What is the weather in Berlin?' }],
    tools,
    tool_choice: 'auto',
  });
  const msg = res.choices[0].message;
  dump('response message', msg);

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    toolCallId   = msg.tool_calls[0].id;
    toolCallName = msg.tool_calls[0].function.name;
    toolCallArgs = msg.tool_calls[0].function.arguments;
    console.log(`\n→ Tool call id : "${toolCallId}"`);
    console.log(`→ Tool name    : "${toolCallName}"`);
    console.log(`→ Arguments    : ${toolCallArgs}`);
    console.log('✅ PASS — got tool call');
  } else {
    console.log('⚠️  No tool call returned (model answered directly)');
  }
} catch (e) {
  console.error('❌ FAIL', e.message);
  dump('error', e);
}

// ── Test 3: Multi-turn tool result ─────────────────────────────
sep('3 · Multi-turn: send tool result back (the failing case in Jarvis)');
if (!toolCallId) {
  console.log('⚠️  SKIP — test 2 did not produce a tool call');
} else {
  try {
    const messages = [
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: { name: toolCallName, arguments: toolCallArgs },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify({ city: 'Berlin', temperature: '15°C', condition: 'Cloudy' }),
      },
    ];

    dump('request messages', messages);

    const res = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
    });

    dump('response', res.choices[0].message);
    console.log('\n✅ PASS — multi-turn tool result accepted');
  } catch (e) {
    console.error('\n❌ FAIL — multi-turn tool result rejected');
    console.error('Status :', e.status);
    console.error('Message:', e.message);
    dump('error body', e.error ?? e);

    // ── Test 3b: retry without tool_call_id on the tool message ──
    sep('3b · Retry without tool_call_id (some providers ignore it)');
    try {
      const messages = [
        { role: 'user', content: 'What is the weather in Berlin?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: toolCallName, arguments: toolCallArgs },
            },
          ],
        },
        {
          role: 'tool',
          // tool_call_id intentionally omitted
          name: toolCallName,
          content: JSON.stringify({ city: 'Berlin', temperature: '15°C', condition: 'Cloudy' }),
        },
      ];

      const res = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
      });

      dump('response', res.choices[0].message);
      console.log('\n✅ PASS — without tool_call_id works');
      console.log('\n💡 FIX NEEDED in Jarvis: strip tool_call_id from tool messages for MiniMax');
    } catch (e2) {
      console.error('❌ FAIL', e2.message);
    }
  }
}

// ── Test 4: Tool ID format check ───────────────────────────────
sep('4 · Inspect tool call ID format from model');
if (toolCallId) {
  console.log(`Raw ID: "${toolCallId}"`);
  if (/^call_-/.test(toolCallId)) {
    console.log('⚠️  NEGATIVE ID detected — MiniMax returns negative numeric IDs like call_-123456');
    console.log('   This may cause issues if the API does not accept them back as-is.');
  } else {
    console.log('✅ ID format looks standard');
  }
}

console.log('\n' + '═'.repeat(60));
console.log('Done. Check results above to determine what Jarvis needs to handle.');
console.log('═'.repeat(60) + '\n');
