import type { RestartRequiredCondition } from './restart-required.js';

export interface HealthState {
  startedAtMs: number;
  nowMs: number;
  activeSessionCount: number;
  dbOk: boolean;
  restartRequired?: RestartRequiredCondition | null;
}

export interface HealthResponseBody {
  status: 'ok' | 'degraded';
  uptime_seconds: number;
  active_sessions: number;
  db_ok: boolean;
  restart_required?: { fields: string[]; since: string };
}

export interface HealthResponse {
  status: number;
  body: HealthResponseBody;
}

export function buildHealthResponse(state: HealthState): HealthResponse {
  const uptimeSeconds = Math.floor((state.nowMs - state.startedAtMs) / 1000);
  const status = state.dbOk ? 'ok' : 'degraded';
  const body: HealthResponseBody = {
    status,
    uptime_seconds: uptimeSeconds,
    active_sessions: state.activeSessionCount,
    db_ok: state.dbOk,
  };
  if (state.restartRequired) {
    body.restart_required = {
      fields: state.restartRequired.fields,
      since: new Date(state.restartRequired.since).toISOString(),
    };
  }
  return {
    status: state.dbOk ? 200 : 503,
    body,
  };
}
