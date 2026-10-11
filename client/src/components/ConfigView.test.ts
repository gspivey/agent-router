import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { ConfigResponse } from '../lib/types.js';

/**
 * ConfigView unit tests (spa-operator-restoration ROADMAP 82, Task C-2).
 *
 * The view is populated from a single stubbed `api.getConfig()` call and the
 * cron toggle exercises `api.pauseCron` / `api.resumeCron`. `api` is mocked so
 * there is no live network. Covers: loading state, Token Health rendering
 * (red-row highlight, null expiry, duplicate project/tokenName keys), the
 * cron pause/resume optimistic toggle + revert-on-error, Session Timeouts,
 * Repositories webhook indicator (green for the exact "[configured]" sentinel,
 * amber otherwise), and the retriable error state.
 */

const getConfig = vi.fn();
const pauseCron = vi.fn();
const resumeCron = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    getConfig: (...args: unknown[]) => getConfig(...args),
    pauseCron: (...args: unknown[]) => pauseCron(...args),
    resumeCron: (...args: unknown[]) => resumeCron(...args),
  },
  // Re-create the AuthError shape the component checks with `instanceof`.
  AuthError: class AuthError extends Error {
    kind: 'missing' | 'expired';
    constructor(kind: 'missing' | 'expired') {
      super(kind);
      this.name = 'AuthError';
      this.kind = kind;
    }
  },
}));

// Imported AFTER the mock is registered.
const { default: ConfigView } = await import('./ConfigView.svelte');

function makeConfig(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
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
    ...overrides,
  };
}

describe('ConfigView', () => {
  beforeEach(() => {
    getConfig.mockReset();
    pauseCron.mockReset();
    resumeCron.mockReset();
  });

  afterEach(cleanup);

  it('shows the loading state while getConfig is in flight', () => {
    getConfig.mockReturnValue(new Promise(() => {})); // never resolves
    const { getByTestId } = render(ConfigView);
    expect(getByTestId('config-loading')).toBeTruthy();
  });

  it('renders the Token Health table rows (FR-7.2)', async () => {
    getConfig.mockResolvedValue(makeConfig());
    const { findAllByTestId } = render(ConfigView);
    const rows = await findAllByTestId('token-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('edit-director');
    expect(rows[0]?.textContent).toContain('GITHUB_TOKEN_EDIT');
  });

  it('highlights a red-health token row (FR-7.2b) and shows a red dot', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        tokens: [
          {
            project: 'p',
            tokenName: 't',
            isSet: false,
            expiry: null,
            health: 'red',
          },
        ],
      }),
    );
    const { findByTestId } = render(ConfigView);
    const row = await findByTestId('token-row');
    expect(row.className).toContain('rgba(248,81,73,0.1)');
    const dot = await findByTestId('health-dot');
    expect(dot.getAttribute('aria-label')).toBe('red');
  });

  it('renders "—" for a null token expiry (FR-7.2c)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        tokens: [{ project: 'p', tokenName: 't', isSet: true, expiry: null, health: 'unknown' }],
      }),
    );
    const { findByTestId } = render(ConfigView);
    const row = await findByTestId('token-row');
    expect(row.textContent).toContain('—');
  });

  it('renders two rows for same project but different tokenName (no duplicate key)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        tokens: [
          { project: 'proj', tokenName: 'TOKEN_A', isSet: true, expiry: null, health: 'green' },
          { project: 'proj', tokenName: 'TOKEN_B', isSet: true, expiry: null, health: 'green' },
        ],
      }),
    );
    const { findAllByTestId } = render(ConfigView);
    const rows = await findAllByTestId('token-row');
    expect(rows).toHaveLength(2);
  });

  it('shows a "Pause" button for an active cron and calls pauseCron on click (FR-7.3b)', async () => {
    getConfig.mockResolvedValue(makeConfig());
    pauseCron.mockResolvedValue({ ok: true });
    const { findByTestId } = render(ConfigView);
    const btn = await findByTestId('cron-toggle-dpdk-cycle');
    expect(btn.textContent?.trim()).toBe('Pause');

    await fireEvent.click(btn);
    expect(pauseCron).toHaveBeenCalledWith('dpdk-cycle');
    // Optimistic toggle flips the label to "Resume".
    await waitFor(() => expect(btn.textContent?.trim()).toBe('Resume'));
  });

  it('shows a "Resume" button for a paused cron and calls resumeCron (FR-7.3c)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        crons: [
          {
            name: 'c1',
            repo: 'o/r',
            schedule: '* * * * *',
            nextFireTime: null,
            paused: true,
          },
        ],
      }),
    );
    resumeCron.mockResolvedValue({ ok: true });
    const { findByTestId } = render(ConfigView);
    const btn = await findByTestId('cron-toggle-c1');
    expect(btn.textContent?.trim()).toBe('Resume');

    await fireEvent.click(btn);
    expect(resumeCron).toHaveBeenCalledWith('c1');
  });

  it('reverts the optimistic toggle and shows an inline error on pause failure (FR-7.3d)', async () => {
    getConfig.mockResolvedValue(makeConfig());
    pauseCron.mockRejectedValue(new Error('boom'));
    const { findByTestId } = render(ConfigView);
    const btn = await findByTestId('cron-toggle-dpdk-cycle');

    await fireEvent.click(btn);
    // Reverted back to "Pause" and an inline error appears.
    await waitFor(() => expect(btn.textContent?.trim()).toBe('Pause'));
    expect(await findByTestId('cron-error-dpdk-cycle')).toBeTruthy();
  });

  it('renders "—" for a null nextFireTime (FR-7.3e)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        crons: [
          { name: 'c1', repo: 'o/r', schedule: '* * * * *', nextFireTime: null, paused: false },
        ],
      }),
    );
    const { findByTestId } = render(ConfigView);
    const row = await findByTestId('cron-row');
    expect(row.textContent).toContain('—');
  });

  it('renders the Session Timeouts values (FR-7.4)', async () => {
    getConfig.mockResolvedValue(makeConfig());
    const { findByTestId } = render(ConfigView);
    const panel = await findByTestId('session-timeouts');
    expect(panel.textContent).toContain('60');
    expect(panel.textContent).toContain('1440');
    expect(panel.textContent).toContain('30');
  });

  it('renders the Rate Limits per-PR interval (FR-7.5)', async () => {
    getConfig.mockResolvedValue(makeConfig());
    const { findByTestId } = render(ConfigView);
    const panel = await findByTestId('rate-limits');
    expect(panel.textContent).toContain('300');
  });

  it('shows a green webhook indicator for the exact "[configured]" sentinel (FR-7.6a)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({ repos: [{ name: 'gspivey/agent-router', webhookSecretName: '[configured]' }] }),
    );
    const { findByTestId } = render(ConfigView);
    const indicator = await findByTestId('webhook-indicator');
    expect(indicator.textContent?.trim()).toBe('yes');
    expect(indicator.className).toContain('--success');
  });

  it('shows an amber indicator when webhookSecretName is not exactly "[configured]" (FR-7.6b)', async () => {
    getConfig.mockResolvedValue(
      makeConfig({
        repos: [{ name: 'o/r', webhookSecretName: 'WEBHOOK_SECRET_o_r' }],
      }),
    );
    const { findByTestId } = render(ConfigView);
    const indicator = await findByTestId('webhook-indicator');
    expect(indicator.textContent?.trim()).toBe('no');
    expect(indicator.className).toContain('--warning');
  });

  it('renders a retriable error banner on a non-auth failure', async () => {
    getConfig.mockRejectedValue(new Error('network down'));
    const { findByTestId } = render(ConfigView);
    expect(await findByTestId('config-error')).toBeTruthy();
    expect(await findByTestId('config-retry')).toBeTruthy();
  });

  it('does NOT render the error state on an AuthError (handled globally)', async () => {
    const { AuthError } = await import('../lib/api.js');
    getConfig.mockRejectedValue(new AuthError('expired'));
    const { queryByTestId } = render(ConfigView);
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByTestId('config-loading')).toBeNull());
    expect(queryByTestId('config-error')).toBeNull();
  });

  it('retry refetches config after an error (FR: retry button)', async () => {
    getConfig.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(makeConfig());
    const { findByTestId, findAllByTestId } = render(ConfigView);
    const retry = await findByTestId('config-retry');
    await fireEvent.click(retry);
    const rows = await findAllByTestId('token-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });
});
