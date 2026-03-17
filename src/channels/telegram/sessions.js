import fs from 'fs';
import path from 'path';
import os from 'os';

const sessionsFile = path.join(os.homedir(), '.jarvis', 'data', 'channels', 'telegram', 'sessions.json');

export function load() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch {
    return {};
  }
}

export function save(map) {
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(sessionsFile, JSON.stringify(map, null, 2), 'utf8');
}
