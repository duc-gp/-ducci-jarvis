/**
 * fish.audio API integration — TTS and STT.
 */

import { createClient } from './provider.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
const execAsync = promisify(exec);

// System prompt for TTS summary generation.
// fish.audio s1 emotion tags: (emotion) at the START of a sentence only — applies to the whole sentence.
// Multiple tags can be combined: (excited)(soft tone) Hello!
// Tags must never appear mid-sentence.
const TTS_SYSTEM_PROMPT = `Summarize the given text in 1-2 spoken sentences for audio playback. Start each sentence with an emotion tag like (calm), (excited), (confident), (happy), or (curious) — placed before the first word of the sentence. Plain text only, no emojis, no markdown. Match the language of the text. Output only the summary, nothing else.`;

/**
 * Generate a short TTS-optimized spoken summary of a response via LLM.
 * Includes fish.audio s1 emotion tags at sentence starts.
 *
 * @param {string} plainText - Plain text of the agent response (HTML already stripped)
 * @param {object} config - Full app config (provider, apiKey, selectedModel)
 * @returns {Promise<string>} - TTS-ready text with emotion tags
 */
export async function generateTtsSummary(plainText, config) {
  const client = createClient(config);

  const response = await client.chat.completions.create({
    model: config.selectedModel,
    messages: [
      { role: 'system', content: TTS_SYSTEM_PROMPT },
      { role: 'user', content: `Summarize this for spoken audio:\n\n${plainText.slice(0, 3000)}` },
    ],
  });

  const choice = response.choices[0];
  const msg = choice?.message;
  const content = (msg?.content || msg?.reasoning_content || '').trim();
  if (!content) {
    // Surface the raw response structure so we can diagnose where the text actually is
    throw new Error(`empty LLM response. finish_reason=${choice?.finish_reason} keys=${Object.keys(msg || {}).join(',')} raw=${JSON.stringify(msg).slice(0, 300)}`);
  }
  return content;
}

/**
 * Convert text to speech via fish.audio TTS API.
 * Returns a Buffer containing MP3 audio data.
 *
 * @param {string} text - TTS-ready text (may include fish.audio emotion tags)
 * @param {object} config - Must include fishAudioApiKey and optionally fishAudioVoiceId
 * @returns {Promise<Buffer>}
 */
export async function textToSpeech(text, config) {
  const { fishAudioApiKey, fishAudioVoiceId } = config;

  const body = {
    text,
    format: 'mp3',
    latency: 'normal',
    mp3_bitrate: 64,
  };
  if (fishAudioVoiceId) body.reference_id = fishAudioVoiceId;

  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${fishAudioApiKey}`,
      'Content-Type': 'application/json',
      'model': 's1',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`fish.audio TTS ${response.status}: ${errText.slice(0, 200)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Transcribe audio to text via fish.audio ASR API.
 * audioBuffer should be OGG/Opus data (standard Telegram voice format).
 *
 * @param {Buffer} audioBuffer
 * @param {object} config - Must include fishAudioApiKey
 * @returns {Promise<string>} - Transcribed text
 */
export async function speechToText(audioBuffer, config) {
  const { fishAudioApiKey } = config;

  // Telegram voice messages are OGG/Opus — fish.audio ASR doesn't support Opus.
  // Convert to WAV first via ffmpeg.
  const id = `jarvis-stt-${Date.now()}`;
  const inPath = join(tmpdir(), `${id}.ogg`);
  const outPath = join(tmpdir(), `${id}.wav`);
  let wavBuffer;
  try {
    await writeFile(inPath, audioBuffer);
    await execAsync(`ffmpeg -y -i "${inPath}" -ar 16000 -ac 1 "${outPath}"`);
    wavBuffer = await readFile(outPath);
  } finally {
    unlink(inPath).catch(() => {});
    unlink(outPath).catch(() => {});
  }

  const formData = new FormData();
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  formData.append('audio', blob, 'voice.wav');

  const response = await fetch('https://api.fish.audio/v1/asr', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${fishAudioApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`fish.audio ASR ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}
