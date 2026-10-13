import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import type { RepoSessionsResponse } from '../lib/types.js';

/**
 * SessionList overflow-fix unit test (spa-polish ROADMAP 87, Req 6.4).
 *
 * Asserts the list container carries `overflow-x-hidden` as the backstop
 * against horizontal overflow. `api` is mocked so there is no live network.
 */
const listRepoSessions = vi.fn();
const listRepoPagedSessions = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    listRepoSessions: (...args: unknown[]) => listRepoSessions(...args),
    listRepoPagedSessions: (...args: unknown[]) => listRepoPagedSessions(...args),
  },
  AuthError: class AuthError extends Error {
    kind: 'missing' | 'expired';
    constructor(kind: 'missing' | 'expired') {
      super(kind);
      this.name = 'AuthError';
      this.kind = kind;
    }
  },
}));

const { default: SessionList } = await import('./SessionList.svelte');

describe('SessionList overflow fix', () => {
  beforeEach(() => {
    listRepoSessions.mockReset();
    listRepoPagedSessions.mockReset();
  });
  afterEach(cleanup);

  it('carries overflow-x-hidden on the list container', async () => {
    const resp: RepoSessionsResponse = { repos: [] };
    listRepoSessions.mockResolvedValue(resp);
    const { getByTestId } = render(SessionList);
    await waitFor(() => {
      expect(getByTestId('session-list').className).toContain('overflow-x-hidden');
    });
  });
});
