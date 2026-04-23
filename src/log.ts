export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
];

function isValidLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function redactSecrets(line: string, secrets: ReadonlyArray<string>): string {
  let result = line;
  for (const secret of secrets) {
    if (secret.length > 0 && result.includes(secret)) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
  }
  return result;
}

export interface CreateLoggerOptions {
  level?: string;
  secrets?: string[];
  output?: (line: string) => void;
}

export function createLogger(options?: CreateLoggerOptions): Logger {
  const rawLevel = options?.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const level: LogLevel = isValidLevel(rawLevel) ? rawLevel : 'info';
  const secrets = options?.secrets ?? [];
  const output = options?.output ?? ((line: string) => { process.stdout.write(line); });

  return buildLogger(level, secrets, output, {});
}

function buildLogger(
  minLevel: LogLevel,
  secrets: ReadonlyArray<string>,
  output: (line: string) => void,
  baseFields: Record<string, unknown>,
): Logger {
  const minOrder = LEVEL_ORDER[minLevel];

  function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minOrder) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: msg,
      ...baseFields,
      ...fields,
    };

    let line = JSON.stringify(entry) + '\n';
    line = redactSecrets(line, secrets);
    output(line);
  }

  return {
    debug(msg, fields) { log('debug', msg, fields); },
    info(msg, fields) { log('info', msg, fields); },
    warn(msg, fields) { log('warn', msg, fields); },
    error(msg, fields) { log('error', msg, fields); },
    child(fields) {
      return buildLogger(minLevel, secrets, output, { ...baseFields, ...fields });
    },
  };
}
