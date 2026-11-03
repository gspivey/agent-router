import { describe, it, expect } from 'vitest';
import { formatUptime } from './uptime.js';

describe('formatUptime', () => {
  // Defensive inputs
  it('returns "—" for negative values', () => {
    expect(formatUptime(-1)).toBe('—');
  });

  it('returns "—" for NaN', () => {
    expect(formatUptime(NaN)).toBe('—');
  });

  it('returns "—" for Infinity', () => {
    expect(formatUptime(Infinity)).toBe('—');
  });

  it('returns "—" for -Infinity', () => {
    expect(formatUptime(-Infinity)).toBe('—');
  });

  // Sub-minute
  it('returns "<1m" for 0 seconds', () => {
    expect(formatUptime(0)).toBe('<1m');
  });

  it('returns "<1m" for 59 seconds', () => {
    expect(formatUptime(59)).toBe('<1m');
  });

  // Minutes only (60s – 3599s)
  it('returns "1m" for 60 seconds', () => {
    expect(formatUptime(60)).toBe('1m');
  });

  it('returns "1m" for 119 seconds (truncates to 1m)', () => {
    expect(formatUptime(119)).toBe('1m');
  });

  it('returns "1m" for 90 seconds', () => {
    expect(formatUptime(90)).toBe('1m');
  });

  it('returns "59m" for 3599 seconds', () => {
    expect(formatUptime(3599)).toBe('59m');
  });

  // Hours and minutes (3600s – 86399s)
  it('returns "1h 0m" for exactly 3600 seconds', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
  });

  it('returns "1h 30m" for 5400 seconds', () => {
    expect(formatUptime(5400)).toBe('1h 30m');
  });

  it('returns "23h 59m" for 86399 seconds', () => {
    expect(formatUptime(86399)).toBe('23h 59m');
  });

  // Days and hours (86400s+)
  it('returns "1d 0h" for exactly 86400 seconds', () => {
    expect(formatUptime(86400)).toBe('1d 0h');
  });

  it('returns "1d 1h" for 90000 seconds', () => {
    expect(formatUptime(90000)).toBe('1d 1h');
  });

  it('returns "2d 3h" for 2 days + 3 hours', () => {
    expect(formatUptime(2 * 86400 + 3 * 3600)).toBe('2d 3h');
  });

  it('returns "7d 0h" for exactly 7 days', () => {
    expect(formatUptime(7 * 86400)).toBe('7d 0h');
  });

  // Large values
  it('handles very large values correctly', () => {
    // 365 days
    expect(formatUptime(365 * 86400)).toBe('365d 0h');
  });
});
