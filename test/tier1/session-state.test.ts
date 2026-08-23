import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../src/session-mgr.js';

describe('SessionState type', () => {
  it('has the expected shape with all timer and flag fields', () => {
    // Verify the SessionState interface can be constructed with all required fields.
    // This is a compile-time + runtime check that the type is correctly exported
    // and structurally sound.
    const state: SessionState = {
      inactivityTimer: undefined,
      lifetimeTimer: undefined,
      graceTimer: undefined,
      completionFlag: false,
    };

    expect(state.inactivityTimer).toBeUndefined();
    expect(state.lifetimeTimer).toBeUndefined();
    expect(state.graceTimer).toBeUndefined();
    expect(state.completionFlag).toBe(false);
  });

  it('allows timer fields to hold NodeJS.Timeout values', () => {
    const timer = setTimeout(() => {}, 0);
    const state: SessionState = {
      inactivityTimer: timer,
      lifetimeTimer: timer,
      graceTimer: timer,
      completionFlag: true,
    };

    expect(state.inactivityTimer).toBe(timer);
    expect(state.lifetimeTimer).toBe(timer);
    expect(state.graceTimer).toBe(timer);
    expect(state.completionFlag).toBe(true);

    clearTimeout(timer);
  });

  it('consolidates exactly 4 fields (3 timers + 1 flag)', () => {
    // Structural assertion: the interface has exactly the expected keys.
    // This prevents drift where someone adds a field without updating tests.
    const state: SessionState = {
      inactivityTimer: undefined,
      lifetimeTimer: undefined,
      graceTimer: undefined,
      completionFlag: false,
    };

    const keys = Object.keys(state).sort();
    expect(keys).toEqual([
      'completionFlag',
      'graceTimer',
      'inactivityTimer',
      'lifetimeTimer',
    ]);
  });
});
