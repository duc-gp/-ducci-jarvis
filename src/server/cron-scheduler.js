import cron from 'node-cron';

// Maps cron id -> active node-cron task
const tasks = new Map();

let _runCron = null;
let _config = null;

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
