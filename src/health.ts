export interface HealthState {
  startedAtMs: number;
  nowMs: number;
  activeSessionCount: number;
  dbOk: boolean;
}

export interface HealthResponse {
  status: number;
  body: {
    status: 'ok' | 'degraded';
    uptime_seconds: number;
    active_sessions: number;
    db_ok: boolean;
  };
}

export function buildHealthResponse(state: HealthState): HealthResponse {
  const uptimeSeconds = Math.floor((state.nowMs - state.startedAtMs) / 1000);
  const status = state.dbOk ? 'ok' : 'degraded';
  return {
    status: state.dbOk ? 200 : 503,
    body: {
      status,
      uptime_seconds: uptimeSeconds,
      active_sessions: state.activeSessionCount,
      db_ok: state.dbOk,
    },
  };
}
