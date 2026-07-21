/**
 * Secret wrapper type that prevents raw credential values from leaking into logs,
 * JSON serialization, or string interpolation. All credential strings (PATs, tokens)
 * should be wrapped in a `Secret` immediately on parse.
 *
 * Usage:
 *   const token = Secret.of(rawValue);
 *   token.reveal()         // 'ghp_...'
 *   String(token)          // '[REDACTED]'
 *   JSON.stringify(token)  // '"[REDACTED]"'
 *   console.log(token)     // '[REDACTED]'
 */
export class Secret {
  private constructor(private readonly value: string) {}

  /**
   * Create a Secret from a raw string value. Throws if the value is empty.
   */
  static of(value: string): Secret {
    if (!value) throw new Error('Secret cannot be empty');
    return new Secret(value);
  }

  /**
   * Return the raw secret value. Use only where the value must actually be used
   * (e.g. injecting into an Authorization header). Never log the result.
   */
  reveal(): string {
    return this.value;
  }

  /**
   * Returns '[REDACTED]' — prevents leakage via string concatenation or template literals.
   */
  toString(): string {
    return '[REDACTED]';
  }

  /**
   * Returns '[REDACTED]' — prevents leakage via JSON.stringify.
   */
  toJSON(): string {
    return '[REDACTED]';
  }

  /**
   * Returns '[REDACTED]' — prevents leakage via util.inspect / console.log.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}
