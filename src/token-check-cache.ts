/**
 * Token check cache validity logic.
 *
 * Pure function for determining whether a cached token-check result is still fresh.
 * Exported separately so tests can import without triggering CLI side effects.
 */

/**
 * Check if a token-check cache entry is still valid (less than 1 hour old).
 *
 * Property 15: For any cache entry with a `checked_at` timestamp and a query time `now`,
 * the cache entry is valid if and only if `now - checked_at < 3600000` (1 hour in ms).
 */
export function isCacheEntryValid(checkedAt: string, now: Date): boolean {
  const checkedTime = new Date(checkedAt).getTime();
  if (isNaN(checkedTime)) return false;
  return now.getTime() - checkedTime < 3_600_000;
}
