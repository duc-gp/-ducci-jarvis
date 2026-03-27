import cron from 'node-cron';

// Maps cron id -> active node-cron task
const tasks = new Map();

// Tracks which cron ids are currently executing
const runningCrons = new Set();
// Maps cron id -> Date when it started running
const cronStartTimes = new Map();

let _runCron = null;
let _config = null;

export function setRunning(id) {
  runningCrons.add(id);
  cronStartTimes.set(id, new Date());
}

export function clearRunning(id) {
  runningCrons.delete(id);
  cronStartTimes.delete(id);
}

export function isRunningCron(id) {
  return runningCrons.has(id);
}

export function getRunningCrons() {
  return new Map(cronStartTimes);
}

export function init(runCronFn, config) {
  _runCron = runCronFn;
  _config = config;
}

export function schedule(entry) {
  // Stop existing task if rescheduling
  if (tasks.has(entry.id)) {
    tasks.get(entry.id).stop();
  }
  const task = cron.schedule(entry.schedule, () => {
    _runCron(entry, _config).catch(e => {
      console.error(`[cron] Error running "${entry.name}": ${e.message}`);
    });
  });
  tasks.set(entry.id, task);
  console.log(`[cron] scheduled "${entry.name}" (${entry.schedule})`);
}

export function unschedule(id) {
  const task = tasks.get(id);
  if (task) {
    task.stop();
    tasks.delete(id);
    console.log(`[cron] unscheduled id=${id}`);
  }
}
