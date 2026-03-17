import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { PATHS } from './config.js';

export async function appendLog(sessionId, entry) {
  const logFile = path.join(PATHS.logsDir, `session-${sessionId}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), sessionId, ...entry }) + '\n';
  await fs.promises.appendFile(logFile, line, 'utf8');

  // Console output for better visibility
  const statusColor = entry.status === 'ok' ? chalk.green : chalk.red;
  console.log(
    `${chalk.blue('Session')}: ${chalk.dim(sessionId.slice(0, 8))} | ` +
    `${chalk.yellow('Iter')}: ${entry.iteration} | ` +
    `${chalk.cyan('Status')}: ${statusColor(entry.status)} | ` +
    `${entry.logSummary || '(no summary)'}`
  );
}
