// Prefix every console.log/error line with a date+time stamp so all output
// (agent, cron, telegram, tools, etc.) is consistently timestamped in server.log.
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log = (...args) => _log(`[${ts()}]`, ...args);
console.error = (...args) => _err(`[${ts()}]`, ...args);

import { startServer } from './app.js';

startServer();
