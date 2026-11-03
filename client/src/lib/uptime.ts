/**
 * Format a uptime duration in seconds as a human-readable string.
 *
 * Used by the Overview dashboard stat card (BACKLOG.md § P2.41) to display
 * how long the daemon has been running. The server sends `uptime_s` as a
 * non-negative integer; this function converts it to an operator-friendly
 * label.
 *
 * Ranges:
 *  - Negative / non-finite  → `"—"` (defensive; daemon always sends ≥ 0)
 *  - 0–59 s                 → `"<1m"`
 *  - 60 s – 59m 59s         → `"Xm"` (minutes only; sub-minute noise suppressed)
 *  - 1h – 23h 59m           → `"Xh Ym"` (hours and minutes)
 *  - ≥ 1d                   → `"Xd Yh"` (days and hours; minutes are noise)
 */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }

  const totalSeconds = Math.floor(seconds);

  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (totalSeconds < MINUTE) {
    return '<1m';
  }

  if (totalSeconds < HOUR) {
    const minutes = Math.floor(totalSeconds / MINUTE);
    return `${minutes}m`;
  }

  if (totalSeconds < DAY) {
    const hours = Math.floor(totalSeconds / HOUR);
    const minutes = Math.floor((totalSeconds % HOUR) / MINUTE);
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(totalSeconds / DAY);
  const hours = Math.floor((totalSeconds % DAY) / HOUR);
  return `${days}d ${hours}h`;
}
