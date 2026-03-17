import fs from 'fs';
import path from 'path';
import { PATHS } from './config.js';

export async function loadSession(sessionId) {
  const filePath = path.join(PATHS.conversationsDir, `${sessionId}.json`);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSession(sessionId, session) {
  session.metadata.updatedAt = new Date().toISOString();
  const filePath = path.join(PATHS.conversationsDir, `${sessionId}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
}

export function createSession(systemPromptTemplate) {
  return {
    metadata: {
      handoffCount: 0,
      failedApproaches: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    messages: [
      { role: 'system', content: systemPromptTemplate },
    ],
  };
}
