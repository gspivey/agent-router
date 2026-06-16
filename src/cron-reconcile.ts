import cron from 'node-cron';
import type { AgentRouterConfig } from './config.js';
import type { Database } from './db.js';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles } from './session-files.js';
import type { Logger } from './log.js';

export function reconcileCronJobs(deps: {
  oldTasks: cron.ScheduledTask[];
  oldCron: AgentRouterConfig['cron'];
  nextCron: AgentRouterConfig['cron'];
  db: Database;
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  log: Logger;
  handleCronFire: (entry: AgentRouterConfig['cron'][number]) => void;
}): cron.ScheduledTask[] {
  const { oldTasks, oldCron, nextCron, db, log, handleCronFire } = deps;

  const oldMap = new Map(oldCron.map((e, i) => [e.name, { entry: e, task: oldTasks[i]! }]));
  const newTasks: cron.ScheduledTask[] = [];

  for (const entry of nextCron) {
    const existing = oldMap.get(entry.name);
    if (existing && existing.entry.schedule === entry.schedule && existing.entry.repo === entry.repo && existing.entry.promptFile === entry.promptFile) {
      // Unchanged — keep existing task
      newTasks.push(existing.task);
      oldMap.delete(entry.name);
    } else {
      // New or changed — stop old if it existed, create new
      if (existing) {
        existing.task.stop();
        oldMap.delete(entry.name);
      }
      const state = db.getCronState(entry.name);
      const paused = state !== null && state.paused;
      const task = cron.schedule(entry.schedule, () => {
        handleCronFire(entry);
      }, { scheduled: !paused });
      newTasks.push(task);
      log.info('Cron job reconciled', { name: entry.name, schedule: entry.schedule, paused });
    }
  }

  // Stop removed entries
  for (const [name, { task }] of oldMap) {
    task.stop();
    log.info('Cron job removed', { name });
  }

  return newTasks;
}
