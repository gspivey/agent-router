/**
 * Inline ULID generator (task-attempt-outcome, task 1.1).
 *
 * A ULID is a 26-char Crockford base32 string: a 48-bit unix-millisecond
 * timestamp (first 10 chars) followed by 80 bits of randomness (last 16 chars).
 * ULIDs are lexicographically sortable in the same order as their timestamps,
 * which is why they are used as the public identifiers for tasks, attempts, and
 * task events (`task_events.seq` remains the authoritative replay cursor).
 *
 * Implemented inline rather than via a dependency: `AGENTS.md` requires
 * justifying any new dependency, and a ULID is small and fully specified, so a
 * self-contained generator is cheaper than a new supply-chain surface.
 */

// Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10; // chars encoding the 48-bit timestamp
const RANDOM_LEN = 16; // chars encoding the 80-bit random component
const MAX_TIME = 281474976710655; // 2^48 - 1

/** Encode a non-negative integer time (unix ms) into `TIME_LEN` base32 chars. */
function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new Error(`ulid: time ${now} is out of range (0..${MAX_TIME})`);
  }
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

/** Encode `RANDOM_LEN` random base32 chars (80 bits of entropy). */
function encodeRandom(): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[Math.floor(Math.random() * ENCODING_LEN)];
  }
  return out;
}

/**
 * Generate a ULID. Lexicographically sortable; encodes unix-ms `now` (defaults
 * to `Date.now()`) in the first 10 chars and 80 bits of randomness in the last
 * 16. Successive calls within the same millisecond are NOT guaranteed to be
 * monotonic — use `monotonicUlidFactory()` when strict ordering is required.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Increment a `RANDOM_LEN`-char Crockford base32 string by one (big-endian). */
function incrementRandom(random: string): string {
  const chars = random.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = ENCODING.indexOf(chars[i] as string);
    if (index < ENCODING_LEN - 1) {
      chars[i] = ENCODING[index + 1] as string;
      return chars.join('');
    }
    // Overflow this char back to 0 and carry to the next most-significant char.
    chars[i] = ENCODING[0] as string;
  }
  // Overflowed the entire 80-bit random space within one millisecond — vanishingly
  // unlikely in practice. Throwing is correct: we cannot preserve monotonicity.
  throw new Error('ulid: random component overflow within a single millisecond');
}

/**
 * Build a monotonic ULID factory. Within the same millisecond, each successive
 * id increments the previous id's random component so the stream remains
 * strictly increasing. When the clock advances, the random component is reseeded.
 *
 * Monotonicity matters because `attempts` and `task_events` benefit from
 * sortable ids even when several are generated inside one millisecond.
 */
export function monotonicUlidFactory(): (now?: number) => string {
  let lastTime = -1;
  let lastRandom = '';

  return (now: number = Date.now()): string => {
    if (now <= lastTime) {
      // Same (or a backwards) clock reading: keep the previous timestamp and
      // increment the random component to stay strictly increasing.
      lastRandom = incrementRandom(lastRandom);
      return encodeTime(lastTime) + lastRandom;
    }
    lastTime = now;
    lastRandom = encodeRandom();
    return encodeTime(now) + lastRandom;
  };
}
