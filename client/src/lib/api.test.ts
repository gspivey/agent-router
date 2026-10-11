import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, AuthError, ApiError } from './api.js';
import { auth, TOKEN_STORAGE_KEY } from './stores.svelte.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  auth.token = 'tok';
  auth.error = 'none';
});

describe('api — bearer header (Req 3.3)', () => {
  it('attaches Authorization: Bearer <token> on listSessions', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ sessions: [], total: 0, offset: 0, limit: 20 }));

    const res = await api.listSessions();

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(res).toEqual({ sessions: [], total: 0, offset: 0, limit: 20 });
    fetchSpy.mockRestore();
  });

  it('getSession requests the lines param and returns the seam fields', async () => {
    const detail = {
      meta: { session_id: 's1', status: 'active', created_at: 1, completed_at: null, prs: [] },
      entries: [],
      skipped_lines: 0,
      first_event_id: null,
      last_event_id: null,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(detail));

    const res = await api.getSession('s1', 200);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/sessions/s1?lines=200');
    expect(res.first_event_id).toBeNull();
    expect(res.last_event_id).toBeNull();
    fetchSpy.mockRestore();
  });

  it('inject posts the prompt as JSON and returns {accepted:true}', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ accepted: true }, 202));

    const res = await api.inject('s1', 'do it');

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'do it' });
    expect(res).toEqual({ accepted: true });
    fetchSpy.mockRestore();
  });

  it('interrupt posts and returns {ok:true}', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    const res = await api.interrupt('s1');

    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(res).toEqual({ ok: true });
    fetchSpy.mockRestore();
  });
});

describe('api — kill (spa-operator-restoration B-1)', () => {
  it('kill POSTs /sessions/:id/kill and returns {ok:true}', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    const res = await api.kill('s1');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/sessions/s1/kill');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(res).toEqual({ ok: true });
    fetchSpy.mockRestore();
  });

  it('kill encodes the session id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    await api.kill('a/b c');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/sessions/${encodeURIComponent('a/b c')}/kill`);
    fetchSpy.mockRestore();
  });

  it('kill throws ApiError(409) when the session is not active', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 409 }));

    await expect(api.kill('s1')).rejects.toMatchObject({ status: 409 });
    await expect(api.kill('s1')).rejects.toBeInstanceOf(ApiError);
    fetchSpy.mockRestore();
  });

  it('kill throws ApiError(404) for an unknown session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await expect(api.kill('s1')).rejects.toMatchObject({ status: 404 });
    fetchSpy.mockRestore();
  });

  it('kill enters the expired lockout on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));

    await expect(api.kill('s1')).rejects.toMatchObject({ kind: 'expired' });
    expect(auth.error).toBe('expired');
    fetchSpy.mockRestore();
  });
});

describe('api — repo-grouped sessions (spa-operator-restoration A-2)', () => {
  it('listRepoSessions GETs /repos/sessions and returns the envelope', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ repos: [] }));

    const res = await api.listRepoSessions();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/repos/sessions');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(res).toEqual({ repos: [] });
    fetchSpy.mockRestore();
  });

  it('listRepoSessions enters the expired lockout on 401', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(api.listRepoSessions()).rejects.toMatchObject({ kind: 'expired' });
    expect(auth.error).toBe('expired');
    fetchSpy.mockRestore();
  });

  it('listRepoPagedSessions encodes the repo and sets limit/offset params', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ sessions: [], total: 0, offset: 10, limit: 5 }));

    const res = await api.listRepoPagedSessions('owner/repo', 5, 10);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain(encodeURIComponent('owner/repo'));
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=10');
    expect(res.offset).toBe(10);
    fetchSpy.mockRestore();
  });
});

describe('api — config + cron toggle (spa-operator-restoration C-1)', () => {
  function sampleConfig() {
    return {
      sessionTimeouts: {
        inactivityMinutes: 60,
        maxLifetimeMinutes: 1440,
        gracePeriodAfterMergeSeconds: 30,
      },
      rateLimits: { perPRSeconds: 300 },
      crons: [
        {
          name: 'dpdk-cycle',
          repo: 'gspivey/dpdk-stdlib-rust',
          schedule: '*/30 * * * *',
          nextFireTime: '2026-10-11T03:00:00Z',
          paused: false,
        },
      ],
      tokens: [
        {
          project: 'edit-director',
          tokenName: 'GITHUB_TOKEN_EDIT',
          isSet: true,
          expiry: '2026-12-01T00:00:00Z',
          health: 'green',
        },
      ],
      repos: [{ name: 'gspivey/agent-router', webhookSecretName: '[configured]' }],
    };
  }

  it('getConfig GETs /config and returns the config envelope', async () => {
    const body = sampleConfig();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));

    const res = await api.getConfig();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/config');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(res).toEqual(body);
    fetchSpy.mockRestore();
  });

  it('getConfig enters the expired lockout on 401', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(api.getConfig()).rejects.toMatchObject({ kind: 'expired' });
    expect(auth.error).toBe('expired');
    fetchSpy.mockRestore();
  });

  it('pauseCron POSTs /crons/:name/pause and returns {ok:true}', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    const res = await api.pauseCron('my-cron');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/crons/my-cron/pause');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(res).toEqual({ ok: true });
    fetchSpy.mockRestore();
  });

  it('resumeCron POSTs /crons/:name/resume and returns {ok:true}', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    const res = await api.resumeCron('my-cron');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/crons/my-cron/resume');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(res).toEqual({ ok: true });
    fetchSpy.mockRestore();
  });

  it('pauseCron encodes the cron name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    await api.pauseCron('a/b c');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/crons/${encodeURIComponent('a/b c')}/pause`);
    fetchSpy.mockRestore();
  });

  it('resumeCron enters the expired lockout on 403', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 403 }));

    await expect(api.resumeCron('my-cron')).rejects.toMatchObject({ kind: 'expired' });
    expect(auth.error).toBe('expired');
    fetchSpy.mockRestore();
  });

  it('pauseCron throws ApiError on a non-auth failure (500)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));

    await expect(api.pauseCron('my-cron')).rejects.toBeInstanceOf(ApiError);
    expect(auth.error).toBe('none');
    fetchSpy.mockRestore();
  });
});

describe('api — auth failures (Req 3.4, 3.5)', () => {
  it('throws AuthError("missing") and makes no request when there is no token', async () => {
    auth.token = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(api.listSessions()).rejects.toMatchObject({ kind: 'missing' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('enters the expired lockout and throws AuthError("expired") on 401', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));

    await expect(api.listSessions()).rejects.toBeInstanceOf(AuthError);
    expect(auth.error).toBe('expired');
    expect(auth.token).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    fetchSpy.mockRestore();
  });

  it('enters the expired lockout on 403', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));

    await expect(api.getSession('s1')).rejects.toMatchObject({ kind: 'expired' });
    expect(auth.error).toBe('expired');
    fetchSpy.mockRestore();
  });

  it('throws ApiError for a non-auth non-2xx (e.g. 500)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
    // A 500 is NOT an auth failure — the lockout must not fire.
    expect(auth.error).toBe('none');
    fetchSpy.mockRestore();
  });
});
